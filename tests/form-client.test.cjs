const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {createSubmission} = require('../form-client.js');
const fields = {form_type:'design_questionnaire',name:'TEST',phone:'+79990000000',consent:true,website:'',answers_json:{styles:['Лофт','Минимализм'],comments:'я'.repeat(12000)},answers_text:'ТЕСТ'};
const accepted = payload => ({status:200,json:async()=>({ok:true,request_id:payload.request_id})});
test('transport preserves answers, assigns source and validates acknowledgement', async()=>{
 let payload;
 const client=createSubmission({endpoint:'https://forms.example.test/api/forms',fetch:async(url,opts)=>{payload=JSON.parse(opts.body);assert.equal(opts.credentials,'omit');return accepted(payload)}});
 await client.send(fields);
 assert.equal(payload.source_site,'itdstudio.ru');assert.deepEqual(payload.answers_json,fields.answers_json);assert.match(payload.request_id,/^[a-f0-9-]{36}$/);assert.equal(Number.isNaN(Date.parse(payload.submitted_at)),false);
});
test('double click cannot cause second delivery and accepted retry is idempotent',async()=>{
 let release,calls=0;
 const client=createSubmission({endpoint:'https://forms.example.test/api/forms',fetch:async(url,opts)=>{calls++;await new Promise(r=>release=r);return accepted(JSON.parse(opts.body))}});
 const pending=client.send(fields);assert.equal(client.pending,true);await assert.rejects(client.send(fields));release();await pending;await client.send(fields);assert.equal(calls,1);
});
test('network error retry keeps original id and timestamp; changed answers get a new id',async()=>{
 const sent=[];
 const client=createSubmission({endpoint:'https://forms.example.test/api/forms',fetch:async(url,opts)=>{const p=JSON.parse(opts.body);sent.push(p);if(sent.length===1)throw Error('offline');return accepted(p)}});
 await assert.rejects(client.send(fields));await client.send(fields);await client.send({...fields,name:'SECOND TEST'});
 assert.equal(sent[0].request_id,sent[1].request_id);assert.equal(sent[0].submitted_at,sent[1].submitted_at);assert.notEqual(sent[1].request_id,sent[2].request_id);
});
test('HTTP error, missing acknowledgement and wrong id never become success',async()=>{
 for(const response of [{status:500,json:async()=>({ok:true})},{status:202,json:async()=>({ok:true})},{status:200,json:async()=>({ok:true,request_id:'other'})},{status:200,json:async()=>{throw Error('not JSON')}}]){
  const c=createSubmission({endpoint:'https://forms.example.test/api/forms',fetch:async()=>response});await assert.rejects(c.send(fields));assert.equal(c.pending,false);
 }
});
test('timeout aborts and permits retry without creating a second id',async()=>{
 const sent=[];
 const c=createSubmission({endpoint:'https://forms.example.test/api/forms',timeoutMs:5,fetch:async(url,opts)=>{const p=JSON.parse(opts.body);sent.push(p);if(sent.length===1)return new Promise((res,rej)=>opts.signal.addEventListener('abort',()=>rej(Error('timeout'))));return accepted(p)}});
 await assert.rejects(c.send(fields));await c.send(fields);assert.equal(sent[0].request_id,sent[1].request_id);
});
test('no delivery without consent, for honeypot, missing configuration or public Make URL',async()=>{
 let calls=0;
 for(const endpoint of ['', 'http://forms.example.test/api/forms','https://hook.eu2.make.com/SECRET','https://hook.integromat.com/SECRET']){
  const c=createSubmission({endpoint,fetch:async()=>{calls++;}});await assert.rejects(c.send(fields));
 }
 const c=createSubmission({endpoint:'https://forms.example.test/api/forms',fetch:async()=>{calls++;}});
 await assert.rejects(c.send({...fields,consent:false}));await assert.rejects(c.send({...fields,website:'spam'}));assert.equal(calls,0);
});
test('cryptographic fallback produces a valid UUIDv4',async()=>{
 const context={URL,AbortController,setTimeout,clearTimeout,crypto:{getRandomValues:a=>webcrypto.getRandomValues(a)}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../form-client.js'),'utf8'),context);
 let id;const c=context.ITDForms.createSubmission({endpoint:'https://forms.example.test/api/forms',fetch:async(url,opts)=>{const p=JSON.parse(opts.body);id=p.request_id;return accepted(p)}});await c.send(fields);assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
