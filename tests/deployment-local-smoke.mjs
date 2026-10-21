// Optional real-tool integration: loopback-only HTTPS and encrypted local restic repository.
// Run with ITD_CADDY_BIN and ITD_RESTIC_BIN pointing to verified executables.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import https from 'node:https';
import {createApp} from '../server.mjs';
import {bindData,backupData,restoreBackup} from '../data-storage.mjs';
const caddyBin=process.env.ITD_CADDY_BIN,resticBin=process.env.ITD_RESTIC_BIN;
assert(caddyBin&&resticBin,'Set paths to verified Caddy and restic executables.');
const root=await mkdtemp('/tmp/itd-local-deployment-');
const password=randomBytes(24).toString('hex');let app,caddy;
async function run(bin,args,env={}) {const child=spawn(bin,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);const [code]=await once(child,'exit');assert.equal(code,0,`${bin} ${args[0]} failed: ${err}`);return out;}
try {
 const portFinder=net.createServer();await new Promise(r=>portFinder.listen(0,'127.0.0.1',r));const tlsPort=portFinder.address().port;await new Promise(r=>portFinder.close(r));
 const origin=`https://localhost:${tlsPort}`,dataDir=join(root,'data');
 app=createApp({dataDir,adminEmail:'admin@example.test',adminPassword:password,internetMode:true,publicOrigin:origin,secureCookies:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const nodePort=app.server.address().port;
 let config=await readFile(new URL('../deploy/Caddyfile',import.meta.url),'utf8');
 config=config.replace('cabinet.example.test',`https://localhost:${tlsPort}`).replace('127.0.0.1:8000',`127.0.0.1:${nodePort}`).replace('    encode zstd gzip','    bind 127.0.0.1\n    tls internal\n    encode zstd gzip');
 config='{\n admin off\n auto_https disable_redirects\n skip_install_trust\n servers {\n protocols h1 h2\n }\n}\n'+config;
 const configFile=join(root,'Caddyfile');await writeFile(configFile,config);const caddyEnv={...process.env,XDG_DATA_HOME:join(root,'xdg-data'),XDG_CONFIG_HOME:join(root,'xdg-config')};
 caddy=spawn(caddyBin,['run','--config',configFile,'--adapter','caddyfile'],{env:caddyEnv,stdio:['ignore','ignore','pipe']});let log='';caddy.stderr.on('data',d=>log+=d);const caPath=join(root,'xdg-data/caddy/pki/authorities/local/root.crt');
 const waitUntil=Date.now()+15000;while(!existsSync(caPath)){assert(Date.now()<waitUntil&&caddy.exitCode===null,log);await new Promise(r=>setTimeout(r,50));}
 const ca=await readFile(caPath);
 async function req(path,body,cookie,extra={}) {return new Promise((resolve,reject)=>{const request=https.request({hostname:'127.0.0.1',servername:'localhost',port:tlsPort,path,ca,method:body?'POST':'GET',headers:{Host:`localhost:${tlsPort}`,Origin:origin,'X-ITD-Request':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra}},res=>{let data='';res.on('data',d=>data+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(data)}));});request.on('error',reject);request.end(body?JSON.stringify(body):undefined);});}
 let ready=false;while(!ready){try{ready=(await req('/api/runtime')).status===200;}catch{assert(Date.now()<waitUntil,log);await new Promise(r=>setTimeout(r,50));}}
 const login=await req('/api/login',{email:'admin@example.test',password});assert.equal(login.status,200);const cookie=login.headers['set-cookie'][0].split(';')[0];assert.match(login.headers['set-cookie'][0],/Secure/);assert.match(login.headers['strict-transport-security'],/max-age/);
 assert.equal((await req('/api/register',{name:'Fictional',email:'fake@example.test',password})).status,403);
 assert.equal((await req('/api/logout',{},cookie,{Origin:'https://foreign.example.test'})).status,403);
 assert.equal((await fetch(`http://127.0.0.1:${nodePort}/api/runtime`)).status,403);
 const p=await req('/api/projects',{title:'Private test project',clientId:null},cookie);assert.equal(p.status,201);
 const intent=await req(`/api/projects/${p.body.id}/upload-intents`,{},cookie);assert.equal(intent.status,201);
 const bytes=Buffer.from('Fictional confidential document for encrypted backup test');
 const uploaded=await req(`/api/projects/${p.body.id}/files`,{name:'document.txt',contentType:'text/plain',category:'document',data:bytes.toString('base64'),uploadIntent:intent.body.uploadIntent},cookie);assert.equal(uploaded.status,201);
 for(let i=1;i<=6;i++)assert.equal((await req('/api/password-recovery/requests',{email:`fake${i}@example.test`},null,{'X-Real-IP':`192.0.2.${i}`,'X-Forwarded-For':`198.51.100.${i}`})).status,i<=5?202:429);
 console.log('PASS: real loopback Caddy HTTPS, trusted certificate, mandatory Secure/HSTS, CSRF, closed registration, direct Node rejection and spoofed IP overwrite.');
 caddy.kill('SIGTERM');await once(caddy,'exit');caddy=null;await app.close();app=null;
 const settingsFile=join(root,'settings.json');await bindData(dataDir,{settingsFile});const backup=await backupData({settingsFile,destination:join(root,'copies')});
 const key=join(root,'restic-key');await writeFile(key,randomBytes(48).toString('hex'),{mode:0o600});const env={RESTIC_REPOSITORY:join(root,'encrypted-repository'),RESTIC_PASSWORD_FILE:key,RESTIC_CACHE_DIR:join(root,'cache')};
 await run(resticBin,['init'],env);await run(resticBin,['backup','--tag','itd-test',backup],env);await run(resticBin,['check','--read-data'],env);
 const decrypted=join(root,'decrypted');await run(resticBin,['restore',`latest:${resolve(backup)}`,'--target',decrypted,'--verify'],env);const restored=join(root,'restored');restoreBackup(decrypted,restored);
 app=createApp({dataDir:restored});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 assert.equal((await fetch(base+'/api/me',{headers:{Cookie:cookie}})).status,401);
 const fresh=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email:'admin@example.test',password})});assert.equal(fresh.status,200);const newCookie=fresh.headers.get('set-cookie').split(';')[0];
 const download=await fetch(base+`/api/files/${uploaded.body.id}/download`,{headers:{Cookie:newCookie}});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
 console.log('PASS: real restic encrypted repository backup/check/read/restore, original password retained, restored session revoked and document bytes preserved.');
} finally {if(caddy){caddy.kill('SIGTERM');await once(caddy,'exit').catch(()=>{});}if(app)await app.close();await rm(root,{recursive:true,force:true});}
