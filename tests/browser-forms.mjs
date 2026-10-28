// Dependency-free Chromium integration. Uses fictitious data and a local mock relay.
// CHROMIUM_BIN=/path/to/chromium node tests/browser-forms.mjs
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=resolve(import.meta.dirname,'..'),tmp=await mkdtemp('/tmp/itd-browser-');
const requests=[],errors=[];let mode='ok',browser,ws;
const tildaDir=process.env.ITD_TILDA_BUILD,originalDir=process.env.ITD_ORIGINAL_DIR;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/api/forms'){
   let body='';for await(const p of req)body+=p;
   const data=JSON.parse(body);requests.push(data);
   if(mode==='network'){res.destroy();return;}
   if(mode==='delay')await new Promise(r=>setTimeout(r,500));
   res.setHeader('Content-Type','application/json');
   if(mode==='error'){res.writeHead(503);res.end(JSON.stringify({ok:false}));return;}
   res.end(JSON.stringify({ok:true,request_id:mode==='wrong-id'?'invalid':data.request_id}));return;
  }
  let pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);
  const sourceRoot=originalDir&&pathname.startsWith('/__original__/')?resolve(originalDir):root;
  const relativePath=sourceRoot!==root?pathname.slice('/__original__'.length):pathname;
  const file=resolve(sourceRoot,'.'+(relativePath==='/'?'/index.html':relativePath));
  if(!file.startsWith(sourceRoot+'/'))throw Error();
  let bytes;
  if(tildaDir && ['/index.html','/anketa.html'].includes(pathname)){
    const fragment=await readFile(join(tildaDir,pathname==='/index.html'?'T123-HOME.html':'T123-ANKETA.html'),'utf8');
    bytes=Buffer.from('<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"></head><body><div id=allrecords class=t-records><div class=t-rec><div class=t123>'+fragment+'</div></div></div></body></html>');
  }else bytes=await readFile(file);
  if(extname(file)==='.html')bytes=Buffer.from(bytes.toString().replace('<head>','<head><script>window.ITD_FORMS_ENDPOINT=location.origin+"/api/forms";window.__opened=[];window.open=(...args)=>{window.__opened.push(args);return null};</script>'));
  res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');res.end(bytes);
 }catch{res.writeHead(404);res.end('not found');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let nextId=0;const pending=new Map();
function command(method,params={}){return new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+': '+r.exceptionDetails.exception?.description);return r.result.value;}
async function wait(expression){const until=Date.now()+12000;while(!(await evaluate(expression))){if(Date.now()>until)throw Error('Timed out: '+expression);await pause(40);}}
const click=s=>evaluate(`document.querySelector(${JSON.stringify(s)}).click()`);
const fill=(s,v)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(s)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const check=s=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(s)});e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
async function go(path='/index.html'){await command('Page.navigate',{url:origin+path});await wait('document.readyState==="complete"');await pause(100);}
async function contact(){await click('[data-open-contact]');await wait('document.querySelector("#contact-dialog").open');await fill('#contact-name','ТЕСТ ITD');await fill('#contact-phone-input','+7 000 000-00-00');await check('#contact-consent');}
async function done(){await wait('!document.querySelector("#contact-ready").hidden');assert.equal(await evaluate('window.__opened.length'),0);}
try{
 browser=spawn(process.env.CHROMIUM_BIN||'/usr/bin/chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${tmp}/profile`,'about:blank'],{stdio:['ignore','ignore','pipe']});
 let logs='';browser.stderr.on('data',b=>logs+=b);
 let port;for(let i=0;i<150;i++){try{port=(await readFile(join(tmp,'profile/DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await pause(40);}}
 assert(port,'Chromium did not start: '+logs);
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(targets.find(x=>x.type==='page').webSocketDebuggerUrl);await once(ws,'open');
 ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Fetch.requestPaused')intercept(m.params).catch(e=>errors.push(String(e)));});
 await command('Runtime.enable');await command('Page.enable');await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 if(tildaDir)await command('Fetch.enable',{patterns:[{urlPattern:'https://assets.example.test/*'},{urlPattern:'https://forms.example.test/*'}]});
 async function intercept({requestId,request}){
  const url=new URL(request.url);
  let body='',status=200,type='application/json';
  if(url.hostname==='assets.example.test'){
   const relative=url.pathname.replace(/^\/itd\//,'');
   try{body=(await readFile(join(tildaDir,'public',relative))).toString('base64');type=mime[extname(relative)]||'application/octet-stream';}catch{status=404;}
  }else if(request.method==='OPTIONS'){
   await command('Fetch.fulfillRequest',{requestId,responseCode:204,responseHeaders:[{name:'Access-Control-Allow-Origin',value:origin},{name:'Access-Control-Allow-Methods',value:'POST, OPTIONS'},{name:'Access-Control-Allow-Headers',value:'Content-Type'}]});return;
  }else{
   if(mode==='network'){await command('Fetch.failRequest',{requestId,errorReason:'ConnectionReset'});return;}
   const data=JSON.parse(request.postData);requests.push(data);
   if(mode==='delay')await pause(500);
   status=mode==='error'?503:200;
   body=Buffer.from(JSON.stringify(status===200?{ok:true,request_id:mode==='wrong-id'?'invalid':data.request_id}:{ok:false})).toString('base64');
  }
  await command('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:type},{name:'Access-Control-Allow-Origin',value:origin}],body});
 }

 for(const width of [1440,768,430,375]){
  await command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await go();
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`home overflow ${width}`);
  if(originalDir&&[1440,375].includes(width)){
   async function snapshot(){await evaluate('document.fonts.ready');await evaluate('(()=>{const s=document.createElement("style");s.textContent="*,*::before,*::after{animation:none!important;transition:none!important}";document.head.append(s);scrollTo(0,0);})()');await wait('[...document.images].filter(i=>i.getBoundingClientRect().top<900&&i.getBoundingClientRect().bottom>0).every(i=>i.complete)');await pause(150);return(await command('Page.captureScreenshot',{format:'png'})).data;}
   const changed=await snapshot();await go('/__original__/index.html');const original=await snapshot();
   assert.equal(changed,original,`first-screen visual regression at ${width}px`);await go();console.log(`PASS original/new first-screen screenshot identical at ${width}px`);
  }

  await contact();assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`modal overflow ${width}`);
  await click('#contact-submit');await done();
  await go('/anketa.html');assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),`anketa overflow ${width}`);
  console.log(`PASS layout and short submission at ${width}px`);
 }
 await go();await click('[data-open-contact]');const beforeInvalid=requests.length;await click('#contact-submit');await pause(100);assert.equal(requests.length,beforeInvalid);
 await fill('#contact-name','ТЕСТ');await fill('#contact-phone-input','+7 000 000-00-00');await click('#contact-submit');await pause(100);assert.equal(requests.length,beforeInvalid,'no consent');
 await check('#contact-consent');mode='delay';await evaluate('document.querySelector("#contact-form").requestSubmit();document.querySelector("#contact-form").requestSubmit()');await done();assert.equal(requests.length,beforeInvalid+1,'duplicate click');mode='ok';
 await go();await contact();mode='error';await click('#contact-submit');await wait('document.querySelector("#contact-feedback").textContent.includes("Не удалось")');const failed=requests.at(-1);assert.equal(await evaluate('document.querySelector("#contact-name").value'),'ТЕСТ ITD');mode='ok';await click('#contact-submit');await done();assert.equal(requests.at(-1).request_id,failed.request_id);
 for(const failure of ['wrong-id','network']){await go();await contact();mode=failure;await click('#contact-submit');await wait('document.querySelector("#contact-feedback").textContent.includes("Не удалось")');assert(await evaluate('document.querySelector("#contact-ready").hidden'));mode='ok';await click('#contact-submit');await done();}
 await go();await fill('#area','120');await fill('#package','max');await check('#supervision');await fill('#months','2');await click('#calc-discuss');await fill('#contact-name','ТЕСТ расчёт');await fill('#contact-phone-input','+7 000 000-00-00');await check('#contact-consent');await click('#contact-submit');await done();assert.equal(requests.at(-1).calculated_total,646000);assert.equal(requests.at(-1).package,'MAX');assert.equal(requests.at(-1).calculator_area,120);
 await go('/index.html#/projects/baltiyskiy');await click('#case-contact-button');await fill('#contact-name','ТЕСТ портфолио');await fill('#contact-phone-input','+7 000 000-00-00');await check('#contact-consent');await click('#contact-submit');await done();assert(requests.at(-1).project_name);assert.equal(requests.at(-1).project_view,'Страница проекта');
 await go('/anketa.html');await click('#next');assert.equal(await evaluate('document.querySelector("#step-number").textContent'),'01 / 05');
 await fill('#area','73');await fill('#object_address','ТЕСТ ЖК');await fill('#rooms','3 / 2');await check('[name=object_type]');await check('[name=stage]');await check('[name=docs]');await click('#next');
 await fill('#residents','ТЕСТ семья');await fill('#pets','ТЕСТ кот');await fill('#needs','ТЕСТ кабинет');await click('#next');await check('[name=styles][value="Современный"]');await check('[name=styles][value="Минимализм"]');await fill('#likes','ТЕСТ дерево');await check('[name=redev]');await click('#next');await check('[name=services][value="Дизайн-проект"]');await check('[name=services][value="Авторский надзор"]');await fill('#budget','3–6 млн ₽');await fill('#start','Через 1–3 месяца');const long='ТЕСТ длинного ответа '.repeat(500);await fill('#comments',long);await click('#next');await fill('#name','ТЕСТ анкета');await fill('#phone','+7 000 000-00-00');await fill('#email','test@example.invalid');const beforeConsent=requests.length;await click('#next');await pause(100);assert.equal(requests.length,beforeConsent);await check('#agreement');mode='error';await click('#next');await wait('document.querySelector("#form-feedback").textContent.includes("Не удалось")');const q=requests.at(-1);mode='ok';await click('#next');await wait('!document.querySelector("#form-done").hidden');assert.equal(requests.at(-1).request_id,q.request_id);assert.equal(q.form_type,'design_questionnaire');assert.equal(q.source_site,'itdstudio.ru');const answers=typeof q.answers_json==='string'?JSON.parse(q.answers_json):q.answers_json;assert.deepEqual(answers.styles,['Современный','Минимализм']);assert.equal(answers.services.length,2);assert.equal(answers.comments,long.trim());assert(q.answers_text.includes(long.trim()));assert.equal(await evaluate('window.__opened.length'),0);
 assert.equal(errors.length,0,errors.join('\n'));console.log('PASS required fields/consent, double submit, error/network/wrong-ack retry, calculator, portfolio, all questionnaire steps and full long answers; no Telegram popup or browser JS errors.');
}finally{
 if(ws)ws.close();if(browser){browser.kill('SIGTERM');await once(browser,'exit').catch(()=>{});}server.closeAllConnections();await new Promise(r=>server.close(r));await rm(tmp,{recursive:true,force:true});
}
