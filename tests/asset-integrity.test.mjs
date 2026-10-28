import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const current=resolve(import.meta.dirname,'..');
const original=process.env.ITD_ORIGINAL_DIR;
const hash=b=>createHash('sha256').update(b).digest('hex');
test('original images, fonts, project data and stylesheet remain byte-for-byte unchanged',{skip:!original},async()=>{
 const names=await readdir(join(original,'assets'));
 assert.deepEqual((await readdir(join(current,'assets'))).sort(),names.sort());
 for(const name of names)assert.equal(hash(await readFile(join(current,'assets',name))),hash(await readFile(join(original,'assets',name))),name);
 for(const name of ['site.css','projects.json','project-data.js'])assert.equal(hash(await readFile(join(current,name))),hash(await readFile(join(original,name))),name);
});
