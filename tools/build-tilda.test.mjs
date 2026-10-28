import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildTilda } from './build-tilda.mjs';
const root=resolve(import.meta.dirname,'..');
const builder=join(root,'tools/build-tilda.mjs');
test('T123 build preserves ordered scripts, removes document wrappers, rewrites URLs and extracts original picture',async()=>{
 const output=await mkdtemp(join(tmpdir(),'itd-tilda-build-'));
 try {
  await buildTilda({'--assets-base':'https://assets.example.test/itd/','--form-endpoint':'https://forms.example.test/api/forms','--output':output});
  const home=await readFile(join(output,'T123-HOME.html'),'utf8'),anketa=await readFile(join(output,'T123-ANKETA.html'),'utf8');
  for(const page of [home,anketa]){
   assert.doesNotMatch(page,/<\/?(?:html|head|body)(?:\s|>)/i);
   assert.doesNotMatch(page,/(?:src|href)=["'](?:assets\/|index\.html|anketa\.html)/i);
   assert.doesNotMatch(page,/data:image\/webp/);
   assert.match(page,/https:\/\/assets\.example\.test\/itd\//);
  }
  assert(home.indexOf('forms-config.js')<home.indexOf('form-client.js'));
  assert(home.indexOf('form-client.js')<home.indexOf('src="https://assets.example.test/itd/site.js'));
  assert.match(home,/href="\/anketa"/);
  assert.match(anketa,/href="\/"/);
  const original=await readFile(join(root,'anketa.html'),'utf8');
  const embedded=original.match(/src="data:image\/webp;base64,([A-Za-z0-9+/=\r\n]+)"/)[1];
  assert.deepEqual(await readFile(join(output,'public/assets/tilda-anketa-embedded-1.webp')),Buffer.from(embedded,'base64'));
  const config=await readFile(join(output,'public/forms-config.js'),'utf8');
  assert.match(config,/https:\/\/forms\.example\.test\/api\/forms/);
  const meta=JSON.parse(await readFile(join(output,'BUILD-STATUS.json'),'utf8'));
  assert.equal(meta.readyForPublication,true);
  for(const name of ['site.js','project-data.js'])assert.doesNotMatch(await readFile(join(output,'public',name),'utf8'),/["']assets\//);
 }finally{await rm(output,{recursive:true,force:true});}
});
test('builder rejects Make secret URL, insecure host and occupied/source output directories',async()=>{
 const output=await mkdtemp(join(tmpdir(),'itd-tilda-reject-'));
 try {
  for(const host of ['hook.make.com','hook.eu2.make.com','hook.integromat.com','us1.make.com']){
   await assert.rejects(buildTilda({'--form-endpoint':`https://${host}/secret`,'--output':output}),/public relay API/);
  }
  for(const args of [['--assets-base','http://assets.example.test/'],['--output',root],['--output',join(root,'integration')]])await assert.rejects(buildTilda({[args[0]]:args[1]}));
  await writeFile(join(output,'not-a-build.txt'),'keep');
  await assert.rejects(buildTilda({'--output':output}),/not an existing Tilda build/);
  assert.equal(await readFile(join(output,'not-a-build.txt'),'utf8'),'keep');
 }finally{await rm(output,{recursive:true,force:true});}
});
