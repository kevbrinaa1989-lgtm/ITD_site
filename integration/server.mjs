import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const BODY_LIMIT = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(['calculation_request', 'design_questionnaire']);
const message = 'Не удалось отправить данные. Попробуйте ещё раз';
const problem = (status, code) => Object.assign(new Error(code), {status, code});
const canonical = value => JSON.stringify(value && typeof value === 'object' ? (Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))]))) : value);
function webhook(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !/^hook(?:\.[a-z0-9-]+)*\.(make\.com|integromat\.com)$/.test(u.hostname) || u.username || u.password || u.port || u.search || u.hash || !/^\/[A-Za-z0-9_-]+$/.test(u.pathname)) throw Error();
    return u.href;
  } catch { throw Error('MAKE_WEBHOOK_URL должен быть HTTPS-адресом Custom Webhook Make.'); }
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem(400, 'invalid_payload');
  if (!TYPES.has(input.form_type) || !UUID.test(input.request_id || '') || input.consent !== true) throw problem(400, 'invalid_payload');
  if (input.website) throw problem(400, 'invalid_payload');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || typeof input.phone !== 'string' || !/^[+\d\s().-]+$/.test(input.phone) || input.phone.replace(/\D/g, '').length < 10 || input.phone.replace(/\D/g, '').length > 15) throw problem(400, 'invalid_contacts');
  if (typeof input.submitted_at !== 'string' || !Number.isFinite(Date.parse(input.submitted_at))) throw problem(400, 'invalid_date');
  if (input.form_type === 'design_questionnaire' && (!input.answers_json || typeof input.answers_json !== 'object' || Array.isArray(input.answers_json) || typeof input.answers_text !== 'string')) throw problem(400, 'missing_answers');
  if ((input.form_type === 'design_questionnaire' || (input.area !== undefined && input.area !== '')) && (!['string','number'].includes(typeof input.area) || !Number.isFinite(Number(input.area)) || Number(input.area)<1 || Number(input.area)>100000)) throw problem(400, 'invalid_area');
  if (input.email && (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))) throw problem(400, 'invalid_email');
  let page; try { page = new URL(input.page_url); } catch { throw problem(400, 'invalid_page'); }
  if (page.origin !== 'https://itdstudio.ru') throw problem(400, 'invalid_page');
  const output = {...input, name:input.name.trim(), source_site:'itdstudio.ru'};
  delete output.website;
  return output;
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw problem(415, 'json_required');
  const chunks=[]; let length=0;
  for await (const chunk of req) { length += chunk.length; if (length > BODY_LIMIT) throw problem(413, 'body_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw problem(400, 'invalid_json'); }
}

export function createRelay(options = {}) {
  const endpoint = webhook(options.webhookURL ?? process.env.MAKE_WEBHOOK_URL);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const dataFile = options.dataFile || process.env.ITD_FORMS_DB;
  if (!dataFile) throw Error('Укажите ITD_FORMS_DB: отдельный постоянный файл служебной базы заявок вне папки публичного сайта.');
  mkdirSync(dirname(resolve(dataFile)), {recursive:true, mode:0o700});
  const lease = new DatabaseSync(dataFile + '.lock.sqlite');
  try { lease.exec('CREATE TABLE IF NOT EXISTS lease(id INTEGER); BEGIN EXCLUSIVE'); } catch { lease.close(); throw Error('Обработчик уже запущен для этой служебной базы.'); }
  const db = new DatabaseSync(dataFile);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','delivered','unknown')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS rate_limits (ip_hash TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);");
  // A process restart cannot establish whether an in-flight Make execution completed.
  db.prepare("UPDATE submissions SET status='unknown', updated_at=? WHERE status='pending'").run(Date.now());
  const origin = options.allowedOrigin || 'https://itdstudio.ru';
  const rateCount = options.rateCount ?? 8;
  const trustLocalProxy = options.trustLocalProxy ?? process.env.ITD_TRUST_LOCAL_PROXY === '1';
  const inFlight = new Set();
  let closing = false;
  const server = http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    const send = (status, data) => {if(!res.destroyed){res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}};
    try {
      if (req.url !== '/api/forms') throw problem(404,'not_found');
      if (req.headers.origin !== origin) throw problem(403,'origin_denied');
      res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
      if (req.method === 'OPTIONS') {res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.writeHead(204);res.end();return;}
      if (req.method !== 'POST') throw problem(405,'method_not_allowed');
      if (!endpoint || closing) throw problem(503,'not_configured');
      let clientIP = req.socket.remoteAddress || '';
      if (trustLocalProxy) {
        if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(clientIP) || typeof req.headers['x-real-ip'] !== 'string' || !isIP(req.headers['x-real-ip'])) throw problem(403,'proxy_required');
        clientIP = req.headers['x-real-ip'];
      }
      if(clientIP.startsWith('::ffff:') && isIP(clientIP.slice(7)) === 4)clientIP=clientIP.slice(7);
      const ipHash = createHash('sha256').update(clientIP).digest('hex');
      const now=Date.now(), windowStart=now-600000;
      db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(windowStart);
      const ip = db.prepare('SELECT count FROM rate_limits WHERE ip_hash=?').get(ipHash);
      if (ip && ip.count >= rateCount) {res.setHeader('Retry-After','600');throw problem(429,'rate_limited');}
      db.prepare('INSERT INTO rate_limits(ip_hash,count,window_start) VALUES(?,1,?) ON CONFLICT(ip_hash) DO UPDATE SET count=count+1').run(ipHash,now);
      const payload = validate(await body(req));
      const digest = createHash('sha256').update(canonical(payload)).digest('hex');
      const existing = db.prepare('SELECT digest,status FROM submissions WHERE id=?').get(payload.request_id);
      if (existing) {
        if (existing.digest !== digest) throw problem(409,'id_reused_with_changes');
        if (existing.status === 'delivered') {send(200,{ok:true,request_id:payload.request_id});return;}
        throw problem(409, existing.status === 'pending' ? 'processing' : 'delivery_unconfirmed');
      }
      db.prepare("INSERT INTO submissions(id,digest,status,created_at,updated_at) VALUES(?,?,'pending',?,?)").run(payload.request_id,digest,now,now);
      const operation = (async () => {
        try {
          const response = await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(options.timeoutMs ?? 20000)});
          const responseChunks=[]; let responseBytes=0;
          for await(const chunk of response.body || []) { responseBytes+=chunk.length; if(responseBytes>65536)throw problem(502,'delivery_unconfirmed'); responseChunks.push(Buffer.from(chunk)); }
          const text=Buffer.concat(responseChunks).toString('utf8');
          let result; try {result=JSON.parse(text);}catch{throw problem(502,'delivery_unconfirmed');}
          if (!response.ok || result?.ok !== true || result.request_id !== payload.request_id || result.delivery?.sheets !== true || result.delivery?.telegram !== true) throw problem(502,'delivery_unconfirmed');
          db.prepare("UPDATE submissions SET status='delivered',updated_at=? WHERE id=?").run(Date.now(),payload.request_id);
          send(200,{ok:true,request_id:payload.request_id});
        } catch {
          db.prepare("UPDATE submissions SET status='unknown',updated_at=? WHERE id=?").run(Date.now(),payload.request_id);
          send(502,{ok:false,code:'delivery_unconfirmed',message,request_id:payload.request_id});
        }
      })();
      inFlight.add(operation);try{await operation;}finally{inFlight.delete(operation);}
    } catch(error) {send(error.status || 500,{ok:false,code:error.code || 'internal_error',message});}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return {server, async close(){closing=true;if(server.listening)await new Promise(resolve=>server.close(resolve));await Promise.allSettled(inFlight);db.close();lease.close();}};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app=createRelay();const port=Number(process.env.PORT || 8081);
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('Некорректный PORT');
    app.server.listen(port,'127.0.0.1',()=>console.log('ITD forms: обработчик запущен на локальном порту '+port));
    app.server.on('error',()=>{console.error('Не удалось запустить обработчик заявок. Проверьте порт и права доступа.');process.exitCode=1;void app.close();});
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.close());
  } catch {console.error('Не удалось запустить обработчик. Проверьте конфигурацию и доступ к постоянной папке.');process.exitCode=1;}
}
