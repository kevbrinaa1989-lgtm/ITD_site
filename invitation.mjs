import { randomBytes, createHash } from "node:crypto";
const TTL = 24 * 60 * 60 * 1000;
const hash = value => createHash("sha256").update(value).digest("hex");
const INVALID = "Приглашение недействительно или срок его действия истёк. Обратитесь в студию.";
export function initInvitations({db, passwordHash, now = Date.now}) {
  try { db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS invitations(
    id INTEGER PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',tokenHash TEXT UNIQUE,
    status TEXT NOT NULL,createdBy INTEGER NOT NULL REFERENCES users(id),createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,processedAt INTEGER,usedBy INTEGER REFERENCES users(id));
    CREATE INDEX IF NOT EXISTS invitations_email_status ON invitations(email,status);
    CREATE TABLE IF NOT EXISTS invitation_events(id INTEGER PRIMARY KEY,invitationId INTEGER NOT NULL REFERENCES invitations(id),
    type TEXT NOT NULL,actorId INTEGER REFERENCES users(id),createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invitation_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expiresAt INTEGER NOT NULL); COMMIT;`); } catch(error) { if(db.isTransaction)db.exec("ROLLBACK");throw error; }
  const get = (sql,...args) => db.prepare(sql).get(...args);
  const run = (sql,...args) => db.prepare(sql).run(...args);
  const all = (sql,...args) => db.prepare(sql).all(...args);
  const tx = action => { db.exec("BEGIN IMMEDIATE"); try {const result=action();db.exec("COMMIT");return result;}catch(error){db.exec("ROLLBACK");throw error;} };
  const event = (id,type,actorId,time) => run("INSERT INTO invitation_events(invitationId,type,actorId,createdAt) VALUES(?,?,?,?)",id,type,actorId,time);
  const strict = (body,keys,fail) => {if(Object.keys(body).some(key=>!keys.includes(key)))fail(400,"Недопустимые поля запроса");};
  const nameValid = name => typeof name === "string" && name.trim().length > 0 && name.length <= 200;
  const serialize = row => ({id:row.id,email:row.email,name:row.name,status:row.status,createdAt:new Date(row.createdAt).toISOString(),expiresAt:new Date(row.expiresAt).toISOString(),processedAt:row.processedAt==null?null:new Date(row.processedAt).toISOString()});
  function expire(time) {for(const row of all("SELECT id FROM invitations WHERE status='active' AND expiresAt<=?",time)){run("UPDATE invitations SET status='expired',tokenHash=NULL,processedAt=? WHERE id=?",time,row.id);event(row.id,"expired",null,time);}}
  function throttle(scope,key,limit,fail) {
    const time=now(),safeKey=scope+":"+hash(key);
    tx(()=>{run("DELETE FROM invitation_limits WHERE expiresAt<=?",time);run("INSERT INTO invitation_limits(key,count,expiresAt) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",safeKey,time+900000);});
    if(get("SELECT count FROM invitation_limits WHERE key=?",safeKey).count>limit)fail(429,"Слишком много попыток. Повторите через 15 минут");
  }
  const eligible = (token,time) => get("SELECT * FROM invitations WHERE tokenHash=? AND status='active' AND expiresAt>?",hash(token),time);
  async function handle({req,res,path,method,user,body,json,fail,clientIP}) {
    const adminPath = path === "/api/admin/invitations" || /^\/api\/admin\/invitations\/\d+\/revoke$/.test(path);
    if(!adminPath && path !== "/api/invitations/accept")return false;
    res.setHeader("Referrer-Policy","no-referrer");
    if(adminPath){
      if(!user)fail(401,"Войдите в кабинет");if(user.role!=="admin")fail(403,"Нет доступа");
      if(path === "/api/admin/invitations" && method === "GET"){
        tx(()=>expire(now()));json(res,200,{invitations:all("SELECT * FROM invitations ORDER BY id DESC").map(serialize)});return true;
      }
      if(method!=="POST")fail(404,"Маршрут не найден");
      const b=await body(req);throttle("admin",String(user.id),60,fail);
      req.itdRecheckSession?.();
      if(path === "/api/admin/invitations"){
        strict(b,["email","name","confirmVerified"],fail);
        if(typeof b.email!=="string"||b.email.length>254||!/^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/.test(b.email)||b.confirmVerified!==true||("name" in b && b.name!==""&&!nameValid(b.name)))fail(400,"Укажите email и подтвердите проверку получателя");
        const email=b.email.trim().toLowerCase(),name=(b.name||"").trim(),token=randomBytes(32).toString("hex");let id;
        tx(()=>{const time=now();expire(time);if(get("SELECT id FROM users WHERE email=?",email))fail(409,"Этот email уже принадлежит аккаунту. Используйте восстановление доступа.");
          for(const previous of all("SELECT id FROM invitations WHERE email=? AND status='active'",email)){run("UPDATE invitations SET status='revoked',tokenHash=NULL,processedAt=? WHERE id=?",time,previous.id);event(previous.id,"reissued",user.id,time);}
          id=Number(run("INSERT INTO invitations(email,name,tokenHash,status,createdBy,createdAt,expiresAt) VALUES(?,?,?,'active',?,?,?)",email,name,hash(token),user.id,time,time+TTL).lastInsertRowid);event(id,"created",user.id,time);
        });json(res,201,{invitation:serialize(get("SELECT * FROM invitations WHERE id=?",id)),invitationPath:"/accept-invitation/#"+token});return true;
      }
      strict(b,[],fail);const id=Number(path.split("/")[4]);
      tx(()=>{const time=now();expire(time);const row=get("SELECT * FROM invitations WHERE id=?",id);if(!row)fail(404,"Приглашение не найдено");if(row.status!=="active")fail(409,"Приглашение уже обработано");run("UPDATE invitations SET status='revoked',tokenHash=NULL,processedAt=? WHERE id=?",time,id);event(id,"revoked",user.id,time);});json(res,200,{ok:true});return true;
    }
    if(method!=="POST")fail(404,"Маршрут не найден");
    throttle("accept",req.itdClientIP||clientIP||req.socket.remoteAddress||"unknown",20,fail);
    const b=await body(req);strict(b,["token","name","password","passwordConfirm"],fail);
    if(typeof b.token!=="string"||!/^[a-f0-9]{64}$/.test(b.token))fail(400,INVALID);
    if(!nameValid(b.name)||typeof b.password!=="string"||b.password.length<12||b.password.length>256||b.password!==b.passwordConfirm)fail(400,"Укажите имя и совпадающие пароли из 12–256 символов");
    const candidate=eligible(b.token,now());if(!candidate||get("SELECT id FROM users WHERE email=?",candidate.email))fail(400,INVALID);
    const encoded=await passwordHash(b.password);
    req.itdRecheckSession?.();
    tx(()=>{const time=now(),row=eligible(b.token,time);if(!row||get("SELECT id FROM users WHERE email=?",row.email))fail(400,INVALID);
      const id=Number(run("INSERT INTO users(email,name,role,password,createdAt) VALUES(?,?,'client',?,?)",row.email,b.name.trim(),encoded,time).lastInsertRowid);
      const result=run("UPDATE invitations SET status='used',tokenHash=NULL,processedAt=?,usedBy=? WHERE id=? AND status='active'",time,id,row.id);if(!result.changes)fail(400,INVALID);event(row.id,"used",id,time);
    });json(res,200,{ok:true});return true;
  }
  return handle;
}
