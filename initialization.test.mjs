import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { bindData, backupData, verifyBackup, restoreBackup, configuredData, inspectData } from "./data-storage.mjs";
import { initializeData } from "./initialize-data.mjs";

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

async function assertSecretAbsent(folder, password) {
  for (const entry of await readdir(folder,{withFileTypes:true})) {
    const path=join(folder,entry.name);
    if(entry.isDirectory())await assertSecretAbsent(path,password);
    else assert.equal((await readFile(path)).includes(Buffer.from(password)),false,`Plaintext password in ${entry.name}`);
  }
}

test("fresh initialization creates private administrator storage that survives restart and restore",async()=>{
  const root=await mkdtemp(join(tmpdir(),"itd-init-test-"));const settingsFile=join(root,"settings","storage.json"),dataRoot=join(root,"private-data");
  const password=randomBytes(24).toString("hex"),clientPassword=randomBytes(24).toString("hex"),adminEmail="owner@example.test",clientEmail="client@example.test";
  let server;
  try {
    const initialized=await initializeData({adminEmail:" OWNER@example.test ",adminPassword:password,settingsFile,dataRoot});
    assert.equal(initialized.counts.users,1);assert.equal(initialized.counts.projects,0);assert.equal(initialized.counts.files,0);assert.match(initialized.dataDir,new RegExp(`${dataRoot.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}/data-`));
    assert.equal(configuredData({settingsFile}),initialized.dataDir);verifyBackup(initialized.backupDir);
    const db=new DatabaseSync(join(initialized.dataDir,"itd.sqlite"),{readOnly:true});try{const users=db.prepare("SELECT email,role,password FROM users").all();assert.equal(users.length,1);assert.equal(users[0].email,adminEmail);assert.equal(users[0].role,"admin");assert.notEqual(users[0].password,password);assert.match(users[0].password,/^[a-f0-9]{32}:[a-f0-9]{128}$/);}finally{db.close();}
    await assertSecretAbsent(root,password);
    const before=await fingerprint(root);await assert.rejects(initializeData({adminEmail,adminPassword:password,settingsFile,dataRoot}),/уже|повтор|создан/i);assert.deepEqual(await fingerprint(root),before);
    server=await startServer({storageOptions:{settingsFile}},{cwd:root,env:{ITD_ADMIN_EMAIL:"forgotten-old-admin@example.test",ITD_ADMIN_PASSWORD:randomBytes(24).toString("hex")}});const admin=await login(server,adminEmail,password);
    const {user}=await json(server,"/api/register",{method:"POST",body:{name:"Demo client",email:clientEmail,password:clientPassword}},201);assert.equal(user.role,"client");
    const project=await json(server,"/api/projects",{method:"POST",cookie:admin,body:{title:"Project after fresh setup",clientId:user.id}},201);
    const file=await json(server,`/api/projects/${project.id}/files`,{method:"POST",cookie:admin,body:{name:"contract.txt",category:"document",contentType:"text/plain",data:Buffer.from("Signed temporary document").toString("base64")}},201);
    await server.stop();server=null;
    const reopened=new DatabaseSync(join(initialized.dataDir,"itd.sqlite"),{readOnly:true});try{const accounts=reopened.prepare("SELECT email,role FROM users ORDER BY email").all();assert.equal(accounts.length,2);assert.equal(accounts.some(account=>account.email==="forgotten-old-admin@example.test"),false);assert.deepEqual(accounts.filter(account=>account.role==="admin").map(account=>account.email),[adminEmail]);}finally{reopened.close();}
    server=await startServer({storageOptions:{settingsFile}},{cwd:dataRoot});const client=await login(server,clientEmail,clientPassword);await login(server,adminEmail,password);
    const {projects}=await json(server,"/api/projects",{cookie:client});assert.equal(projects.length,1);assert.equal(projects[0].id,project.id);assert.equal(projects[0].title,"Project after fresh setup");assert.equal(projects[0].files[0].id,file.id);
    await server.stop();server=null;
    const backup=await backupData({settingsFile,destination:join(root,"manual-backups")});assert.equal(verifyBackup(backup).counts.users,2);
    const restored=join(root,"restored-data"),restoredSettings=join(root,"restored-settings.json");restoreBackup(backup,restored);await bindData(restored,{settingsFile:restoredSettings,backupDestination:join(root,"restore-backups")});
    server=await startServer({storageOptions:{settingsFile:restoredSettings}},{cwd:root});const restoredClient=await login(server,clientEmail,clientPassword);await login(server,adminEmail,password);
    const result=await json(server,"/api/projects",{cookie:restoredClient});assert.equal(result.projects[0].title,projects[0].title);
    const response=await request(server,`/api/files/${file.id}/download`,{cookie:restoredClient});assert.equal(response.status,200);assert.equal(await response.text(),"Signed temporary document");
    await server.stop();server=null;await assertSecretAbsent(root,password);await assertSecretAbsent(root,clientPassword);
  }finally{if(server)await server.stop();await rm(root,{recursive:true,force:true});}
});

test("fresh setup archives previous pointers without touching old data or opening unavailable folders",async()=>{
  const root=await mkdtemp(join(tmpdir(),"itd-init-previous-test-"));const password=randomBytes(24).toString("hex");
  let oldServer;
  try {
    const oldData=join(root,"old-data");oldServer=await startServer({dataDir:oldData,adminEmail:"old@example.test",adminPassword:password});await oldServer.stop();oldServer=null;
    const oldBefore=await fingerprint(oldData);
    for(const [name,previous] of [["valid",JSON.stringify({version:1,dataDir:oldData})],["unavailable",JSON.stringify({version:1,dataDir:join(root,"unavailable")})],["malformed","{ previous malformed settings"]]){
      const settingsFile=join(root,`${name}.json`),dataRoot=join(root,`${name}-new-root`);await writeFile(settingsFile,previous);
      const result=await initializeData({adminEmail:"new@example.test",adminPassword:password,settingsFile,dataRoot});
      assert.equal(configuredData({settingsFile}),result.dataDir);assert.equal(await readFile(result.previousSettings,"utf8"),previous);assert.deepEqual(await fingerprint(oldData),oldBefore);assert.equal(inspectData(result.dataDir).counts.users,1);verifyBackup(result.backupDir);
      const updated=JSON.parse(await readFile(settingsFile,"utf8"));assert.equal(updated.freshSetup,true);
      const before=await fingerprint(dataRoot);const config=await readFile(settingsFile,"utf8");await assert.rejects(initializeData({adminEmail:"new@example.test",adminPassword:password,settingsFile,dataRoot}));assert.deepEqual(await fingerprint(dataRoot),before);assert.equal(await readFile(settingsFile,"utf8"),config);assert.equal(await readFile(result.previousSettings,"utf8"),previous);
    }
    await assert.rejects(readdir(join(root,"unavailable")),{code:"ENOENT"});
  }finally{if(oldServer)await oldServer.stop();await rm(root,{recursive:true,force:true});}
});

test("invalid initialization inputs create neither settings nor data",async()=>{
  const root=await mkdtemp(join(tmpdir(),"itd-init-invalid-test-"));
  try{
    for(const options of [{adminEmail:"invalid",adminPassword:randomBytes(24).toString("hex")},{adminEmail:"owner@example.test",adminPassword:"short"}]){
      await assert.rejects(initializeData({...options,settingsFile:join(root,"storage.json"),dataRoot:join(root,"data")}));assert.deepEqual(await readdir(root),[]);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
