import { prepareFixtureUpload } from "./tests/upload-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, readdir, cp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { bindData, backupData, verifyBackup, restoreBackup, configuredData, openConfiguredData, inspectData } from "./data-storage.mjs";

const serverURL = new URL("./server.mjs", import.meta.url).href;
// A separate OS process ensures no live connection or module state survives a restart.
async function startServer(options, { cwd, env = {} } = {}) {
  const script = `import(${JSON.stringify(serverURL)}).then(async ({createApp}) => {
    const app=await createApp(JSON.parse(process.env.ITD_TEST_OPTIONS));
    process.on('message', async value => {if(value==='stop'){await app.close();process.exit(0);}});
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
    process.send({port:app.server.address().port});
  }).catch(error=>{process.send({error:error.message});process.exit(1);});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env: { ...process.env, ...env, ITD_TEST_OPTIONS: JSON.stringify(options) },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = once(child, "exit");
  let timeout;
  const ready = await Promise.race([
    once(child, "message").then(([message]) => message),
    exit.then(([code]) => { throw new Error(`Server exited ${code}: ${stderr}`); }),
    new Promise((_, reject) => { timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Server start timeout")); }, 10000); }),
  ]).finally(() => clearTimeout(timeout));
  if (ready.error) { await exit; throw new Error(ready.error); }
  return { child, base: `http://127.0.0.1:${ready.port}`, async stop(signal) { if(child.exitCode !== null || child.signalCode) return; if(signal)child.kill(signal);else child.send("stop");await exit; } };
}
async function request(server, path, { method="GET", cookie, body }={}) {
  body = await prepareFixtureUpload(server.base, path, body, cookie, method);

  const response = await fetch(server.base + path, { method, headers: {
    ...(cookie ? {Cookie:cookie} : {}), ...(method === "GET" ? {} : {Origin:server.base,"X-ITD-Request":"1","Content-Type":"application/json"}),
  }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  return response;
}
async function json(server,path,options,status=200) {
  const response=await request(server,path,options),data=await response.json();
  assert.equal(response.status,status,`${path}: ${JSON.stringify(data)}`);return data;
}
async function login(server,email,password) {
  const response=await request(server,"/api/login",{method:"POST",body:{email,password}});
  assert.equal(response.status,200);await response.json();return response.headers.get("set-cookie").split(";")[0];
}
async function fingerprint(folder) {
  const entries={};
  for(const item of await readdir(folder,{withFileTypes:true})) {
    const path=join(folder,item.name);
    entries[item.name]=item.isDirectory()?await fingerprint(path):createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return entries;
}

test("pinned storage survives process restarts and restores complete verified backups", async t => {
  const root=await mkdtemp(join(tmpdir(),"itd-storage-test-"));
  const dataDir=join(root,"original"),settingsFile=join(root,"settings","storage.json"),backups=join(root,"backups");
  const password=randomBytes(24).toString("hex"),adminEmail="admin@example.test",clientEmail="client@example.test";
  let server;
  const document=Buffer.from("Signed demonstration contract\nПример подписанного документа", "utf8");
  try {
    server=await startServer({dataDir,adminEmail,adminPassword:password});
    const admin=await login(server,adminEmail,password);
    const {user}=await json(server,"/api/register",{method:"POST",body:{name:"Temporary client",email:clientEmail,password}},201);
    const project=await json(server,"/api/projects",{method:"POST",cookie:admin,body:{title:"Persistent project",clientId:user.id}},201);
    const stage=await json(server,`/api/projects/${project.id}/stages`,{method:"POST",cookie:admin,body:{title:"Approved design",status:"completed",description:"Keep this description"}},201);
    const file=await json(server,`/api/projects/${project.id}/files`,{method:"POST",cookie:admin,body:{name:"contract.txt",contentType:"text/plain",category:"document",stageId:stage.id,data:document.toString("base64")}},201);
    const session=await login(server,clientEmail,password);
    await server.stop();server=null;
    const beforeBind={database:await readFile(join(dataDir,"itd.sqlite")),files:await fingerprint(join(dataDir,"files"))};
    const bound=await bindData(dataDir,{settingsFile,backupDestination:backups});
    assert.equal(bound.counts.users,2);assert.equal(bound.counts.files,1);verifyBackup(bound.backupDir);
    assert.deepEqual(await readFile(join(dataDir,"itd.sqlite")),beforeBind.database);assert.deepEqual(await fingerprint(join(dataDir,"files")),beforeBind.files);
    const pinned=await readFile(settingsFile,"utf8");
    const afterBind=await fingerprint(dataDir);const repeated=await bindData(dataDir,{settingsFile,backupDestination:backups});assert.equal(repeated.alreadyConnected,true);assert.deepEqual(await fingerprint(dataDir),afterBind);assert.equal(await readFile(settingsFile,"utf8"),pinned);
    await t.test("fresh processes retain accounts, sessions, projects, stages and exact document bytes",async()=>{
      const wrongDataDir=join(root,"wrong-environment-data");
      for(const signal of [undefined,"SIGKILL"]) {
        server=await startServer({storageOptions:{settingsFile}},{cwd:signal ? join(root,"settings") : root,env:{ITD_DATA_DIR:wrongDataDir}});
        for(const path of ["/","/anketa","/cabinet"]){const response=await request(server,path);assert.equal(response.status,200,`${path} serves from a different working directory`);assert.match(response.headers.get("content-type"),/text\/html/);assert.ok((await response.text()).length>100);}
        await json(server,"/api/me",{},401);
        assert.equal(configuredData({settingsFile}),dataDir);await assert.rejects(readdir(wrongDataDir),{code:"ENOENT"});
        const cookie=await login(server,clientEmail,password);
        const current=await json(server,"/api/me",{cookie:session});assert.equal(current.user.id,user.id);
        const {projects}=await json(server,"/api/projects",{cookie});
        assert.equal(projects.length,1);assert.equal(projects[0].title,"Persistent project");
        assert.deepEqual(projects[0].stages,[{id:stage.id,title:"Approved design",status:"completed",description:"Keep this description",startDate:null,plannedEndDate:null}]);
        assert.equal(projects[0].files[0].category,"document");assert.equal(projects[0].files[0].stageId,stage.id);
        const response=await request(server,`/api/files/${file.id}/download`,{cookie});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),document);
        await login(server,adminEmail,password);
        await assert.rejects(startServer({storageOptions:{settingsFile}}),/используются|занят|locked/i);
        await assert.rejects(backupData({settingsFile,destination:backups}),/используются|занят|locked/i);
        await server.stop(signal);server=null;
      }
      server=await startServer({storageOptions:{settingsFile}},{cwd:root,env:{ITD_DATA_DIR:wrongDataDir}});await login(server,clientEmail,password);await server.stop();server=null;await assert.rejects(readdir(wrongDataDir),{code:"ENOENT"});
    });
    let snapshot;
    await t.test("backup and restore recover accounts, projects and documents without later changes",async()=>{
      const before=await fingerprint(dataDir);snapshot=await backupData({settingsFile,destination:backups});assert.deepEqual(await fingerprint(dataDir),before);assert.equal(await readFile(settingsFile,"utf8"),pinned);const info=verifyBackup(snapshot);assert.equal(info.counts.files,1);
      server=await startServer({storageOptions:{settingsFile}});const cookie=await login(server,adminEmail,password);
      await json(server,`/api/stages/${stage.id}`,{method:"PATCH",cookie,body:{title:"Changed after backup"}});
      await json(server,"/api/projects",{method:"POST",cookie,body:{title:"Later project",clientId:user.id}},201);
      await server.stop();server=null;
      const restored=join(root,"restored");restoreBackup(snapshot,restored);
      const restoredSettings=join(root,"restored-settings.json");await bindData(restored,{settingsFile:restoredSettings,backupDestination:backups});
      server=await startServer({storageOptions:{settingsFile:restoredSettings}});const client=await login(server,clientEmail,password);await login(server,adminEmail,password);
      const {projects}=await json(server,"/api/projects",{cookie:client});assert.equal(projects.length,1);assert.equal(projects[0].stages[0].title,"Approved design");
      const response=await request(server,`/api/files/${file.id}/download`,{cookie:client});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),document);
      await server.stop();server=null;
      assert.equal(await readFile(settingsFile,"utf8"),pinned);assert.equal(inspectData(dataDir).counts.projects,2);
    });
    await t.test("restore refuses existing destinations and leaves original data byte-for-byte unchanged",async()=>{
      const before=await fingerprint(dataDir);assert.throws(()=>restoreBackup(snapshot,dataDir),/EEXIST/);assert.deepEqual(await fingerprint(dataDir),before);
      const other=join(root,"other");restoreBackup(snapshot,other);
      const otherBefore=await fingerprint(other);await assert.rejects(bindData(other,{settingsFile,backupDestination:backups}),/другая папка/);assert.equal(await readFile(settingsFile,"utf8"),pinned);assert.deepEqual(await fingerprint(other),otherBefore);assert.deepEqual(await fingerprint(dataDir),before);
    });
    await t.test("corrupted or incomplete backups are rejected before creating a restore target",async()=>{
      for(const mode of ["changed-document","missing-document","extra-file","changed-database"]) {
        const damaged=join(root,mode);await cp(snapshot,damaged,{recursive:true});
        const [storedName]=await readdir(join(damaged,"files"));
        if(mode==="changed-document")await writeFile(join(damaged,"files",storedName),"tampered");
        if(mode==="missing-document")await rm(join(damaged,"files",storedName));
        if(mode==="extra-file")await writeFile(join(damaged,"files","extra.txt"),"unexpected");
        if(mode==="changed-database")await writeFile(join(damaged,"itd.sqlite"),"not a database");
        const target=join(root,`${mode}-restore`);assert.throws(()=>verifyBackup(damaged));assert.throws(()=>restoreBackup(damaged,target));
        await assert.rejects(readdir(target),{code:"ENOENT"});
      }
      verifyBackup(snapshot);assert.equal(inspectData(dataDir).counts.projects,2);
    });
    await t.test("missing configuration or pinned data never silently creates a fresh database",async()=>{
      const missingSettings=join(root,"missing-settings.json");assert.throws(()=>configuredData({settingsFile:missingSettings}));await assert.rejects(startServer({storageOptions:{settingsFile:missingSettings}}));await assert.rejects(readFile(missingSettings),{code:"ENOENT"});
      const absent=join(root,"unavailable-drive"),brokenSettings=join(root,"broken-settings.json");await writeFile(brokenSettings,JSON.stringify({version:1,dataDir:absent}));assert.throws(()=>openConfiguredData({settingsFile:brokenSettings}));await assert.rejects(startServer({storageOptions:{settingsFile:brokenSettings}}));await assert.rejects(readdir(absent),{code:"ENOENT"});
    });
    await t.test("restore refuses destinations inside its source directly and through symlinks",async()=>{
      const before=await fingerprint(snapshot);const link=join(root,"backup-files-link");await symlink(join(snapshot,"files"),link,"dir");
      for(const destination of [join(snapshot,"nested-restore"),join(snapshot,"files","nested-restore"),join(link,"nested-restore")]){
        assert.throws(()=>restoreBackup(snapshot,destination),/вне.*папк/);assert.deepEqual(await fingerprint(snapshot),before);await assert.rejects(readdir(destination),{code:"ENOENT"});
      }
    });
    await t.test("schema-only stores and malformed configuration are refused without changes",async()=>{
      const empty=join(root,"schema-only");server=await startServer({dataDir:empty});await server.stop();server=null;
      assert.equal(inspectData(empty).counts.users,0);const emptySettings=join(root,"empty-settings.json");await writeFile(emptySettings,JSON.stringify({version:1,dataDir:empty}));
      const before=await fingerprint(empty);assert.throws(()=>openConfiguredData({settingsFile:emptySettings}),/нет аккаунтов/);await assert.rejects(startServer({storageOptions:{settingsFile:emptySettings}}),/нет аккаунтов/);assert.deepEqual(await fingerprint(empty),before);
      const malformed=join(root,"malformed-settings.json");for(const content of ["{", "null", "[]", JSON.stringify({version:2,dataDir}),JSON.stringify({version:1,dataDir:"relative/path"})]){
        await writeFile(malformed,content);assert.throws(()=>configuredData({settingsFile:malformed}));await assert.rejects(backupData({settingsFile:malformed,destination:backups}));await assert.rejects(bindData(dataDir,{settingsFile:malformed,backupDestination:backups}));assert.equal(await readFile(malformed,"utf8"),content);
      }
      assert.equal(await readFile(settingsFile,"utf8"),pinned);
    });
    await t.test("SQLite online backup includes committed WAL rows while a nonmutating connection remains open",async()=>{
      const walData=join(root,"wal-data");restoreBackup(snapshot,walData);const walSettings=join(root,"wal-settings.json");await bindData(walData,{settingsFile:walSettings,backupDestination:backups});
      const db=new DatabaseSync(join(walData,"itd.sqlite"));try{
        assert.equal(db.prepare("PRAGMA journal_mode=WAL").get().journal_mode,"wal");db.exec("PRAGMA wal_autocheckpoint=0");
        const created=db.prepare("INSERT INTO projects(title,clientId) VALUES(?,?)").run("Committed in WAL",user.id);assert.ok((await readFile(join(walData,"itd.sqlite-wal"))).length>0);
        // No writes occur after this point; SQLite must still copy the committed WAL state.
        const before={database:await readFile(join(walData,"itd.sqlite")),wal:await readFile(join(walData,"itd.sqlite-wal")),files:await fingerprint(join(walData,"files")),settings:await readFile(walSettings,"utf8")};
        const saved=await backupData({settingsFile:walSettings,destination:backups});assert.deepEqual(await readFile(join(walData,"itd.sqlite")),before.database);assert.deepEqual(await readFile(join(walData,"itd.sqlite-wal")),before.wal);assert.deepEqual(await fingerprint(join(walData,"files")),before.files);assert.equal(await readFile(walSettings,"utf8"),before.settings);
        const copy=new DatabaseSync(join(saved,"itd.sqlite"),{readOnly:true});try{assert.equal(copy.prepare("SELECT title FROM projects WHERE id=?").get(created.lastInsertRowid).title,"Committed in WAL");}finally{copy.close();}assert.equal(verifyBackup(saved).counts.projects,2);
      }finally{db.close();}
    });
    await t.test("backups cannot be written inside data through direct or symlink destinations",async()=>{
      await assert.rejects(backupData({settingsFile,destination:join(dataDir,"backups")}),/вне.*папк/);
      const link=join(root,"data-link");await symlink(dataDir,link,"dir");await assert.rejects(backupData({settingsFile,destination:join(link,"backups")}),/вне.*папк/);
    });
  } finally {if(server)await server.stop();await rm(root,{recursive:true,force:true});}
});
