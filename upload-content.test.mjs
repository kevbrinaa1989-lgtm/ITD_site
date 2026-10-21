import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';
import { validateUploadFile, validateUploadContent } from './upload-content.mjs';

function chunk(type, data) {
  const header=Buffer.alloc(8);header.writeUInt32BE(data.length);header.write(type,4);
  const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type),data])));
  return Buffer.concat([header,data,crc]);
}
function png() {
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
}
function pdf() {
  let text='%PDF-1.4\n';const offsets=[0];
  for(const [i,body] of ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [] /Count 0 >>'].entries()) {offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${body}\nendobj\n`;}
  const xref=Buffer.byteLength(text);text+='xref\n0 3\n0000000000 65535 f \n';
  for(const offset of offsets.slice(1))text+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  return Buffer.from(text+`trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
// Minimal container builder lets corruption tests change fields without using a ZIP library.
function zip(entries, {deflate=false, flags=0, mode=0}={}) {
  const locals=[],central=[];let offset=0;
  for(const [name,value] of entries) {
    const filename=Buffer.from(name),bytes=Buffer.from(value),packed=deflate?deflateRawSync(bytes):bytes;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(deflate?8:0,8);local.writeUInt32LE(crc32(bytes),14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50);cd.writeUInt16LE(0x0314,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(flags,8);cd.writeUInt16LE(deflate?8:0,10);cd.writeUInt32LE(crc32(bytes),16);cd.writeUInt32LE(packed.length,20);cd.writeUInt32LE(bytes.length,24);cd.writeUInt16LE(filename.length,28);cd.writeUInt32LE((mode*65536)>>>0,38);cd.writeUInt32LE(offset,42);
    locals.push(local,filename,packed);central.push(cd,filename);offset+=local.length+filename.length+packed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
const typesXml='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
const docXml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>';
const workbookXml='<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>';
const mime={png:'image/png',jpg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',zip:'application/zip',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const accept=(ext,bytes)=>assert.doesNotThrow(()=>validateUploadFile({name:`sample.${ext}`,contentType:mime[ext],bytes}));
const reject=(ext,bytes)=>assert.throws(()=>validateUploadFile({name:`sample.${ext}`,contentType:mime[ext],bytes}),error=>error.status===415);

test('representative PNG and PDF containers and Unicode text are accepted',()=>{
  accept('png',png());accept('pdf',pdf());accept('txt',Buffer.from('Проект кухни\nСогласовано\t✓\r\n'));
});
test('a real one-pixel JPEG and WebP are accepted',()=>{
  const jpg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAB//2Q==','base64');
  const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64');
  accept('jpg',jpg);accept('webp',webp);
});
test('extension and declared MIME cannot disguise HTML or arbitrary bytes',()=>{
  for(const ext of Object.keys(mime).filter(ext=>ext!=='txt'))reject(ext,Buffer.from('<script>alert(1)</script>'));
  accept('txt',Buffer.from('<script>This remains downloaded plain text</script>'));
  assert.throws(()=>validateUploadFile({name:'x.png',contentType:'text/html',bytes:png()}),{status:415});
});
test('truncated and checksum-damaged PNGs fail',()=>{
  const bytes=png();reject('png',bytes.subarray(0,-1));const changed=Buffer.from(bytes);changed[changed.length-15]^=1;reject('png',changed);
  reject('png',Buffer.concat([bytes,Buffer.from('extra')]));
});
test('JPEG signatures alone and incomplete JPEG scan data fail',()=>{
  reject('jpg',Buffer.from([255,216,255,217]));reject('jpg',Buffer.from([255,216,255,224,0,2,255,217]));
});
test('WebP RIFF length and frame structure are required',()=>{
  const fake=Buffer.from('RIFF0000WEBPVP8 ');fake.writeUInt32LE(fake.length-8,4);reject('webp',fake);
});
test('PDF header-only, missing EOF and invalid xref offsets fail',()=>{
  reject('pdf',Buffer.from('%PDF-test'));reject('pdf',pdf().subarray(0,-8));reject('pdf',Buffer.from(pdf().toString().replace(/startxref\n\d+/, 'startxref\n999999')));
});
test('text rejects invalid UTF8, NUL and binary control bytes',()=>{
  for(const bytes of [Buffer.from([0xff,0xfe]),Buffer.from('hello\0there'),Buffer.from([65,1,66])])reject('txt',bytes);
});
test('stored and deflated ZIP containers, including empty archives, are accepted',()=>{
  accept('zip',zip([['readme.txt','hello'],['folder/',''],['folder/a.txt','Привет']]));
  accept('zip',zip([['readme.txt','hello'.repeat(100)]],{deflate:true}));accept('zip',zip([]));
});
test('ZIP header-only, truncated archives, corrupt bytes and contradictory sizes fail',()=>{
  reject('zip',Buffer.from('PK\x03\x04'));
  const bytes=zip([['a.txt','hello']]);reject('zip',bytes.subarray(0,-1));
  const crc=Buffer.from(bytes);crc[35]^=1;reject('zip',crc);
  const length=Buffer.from(bytes);length.writeUInt32LE(999,18);reject('zip',length);
});
test('unsafe ZIP names, symlinks, encrypted entries and unsupported compression fail',()=>{
  for(const name of ['../evil.txt','a/../evil','/tmp/x','C:/evil','a\\evil','folder/file:stream','./x','a\0b'])reject('zip',zip([[name,'x']]));
  reject('zip',zip([['link','target']],{mode:0xa1ff}));reject('zip',zip([['secret','x']],{flags:1}));
  const bytes=zip([['a','x']]);bytes.writeUInt16LE(99,8);reject('zip',bytes);
});
test('ZIP duplicate entries and expanded limits fail before decoding unbounded output',()=>{
  reject('zip',zip([['a','x'],['a','y']]));
  const bytes=zip([['bomb','x']],{deflate:true}),central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  bytes.writeUInt32LE(51*1024*1024,central+24);reject('zip',bytes);
});
test('DOCX and XLSX require actual bounded ZIP entries with relevant XML roots',()=>{
  accept('docx',zip([['[Content_Types].xml',typesXml],['word/document.xml',docXml]],{deflate:true}));
  accept('xlsx',zip([['[Content_Types].xml',typesXml],['xl/workbook.xml',workbookXml]]));
  reject('docx',zip([['readme.txt','not Office']]));reject('xlsx',zip([['[Content_Types].xml',typesXml],['word/document.xml',docXml]]));
  reject('docx',zip([['[Content_Types].xml',typesXml],['word/document.xml','<html>fake</html>']]));
  reject('docx',zip([['[Content_Types].xml',typesXml],['word/document.xml','<!DOCTYPE x [<!ENTITY x "xx">]>'+docXml]]));
});
test('validation cannot mutate the source bytes and injected fail receives415',()=>{
  const bytes=png(),before=Buffer.from(bytes);accept('png',bytes);assert.deepEqual(bytes,before);
  let observed;assert.throws(()=>validateUploadContent('txt',Buffer.from([0]),(status,message)=>{observed=status;throw Error(message);}));assert.equal(observed,415);
});

test('deflate payload cannot exceed its advertised bounded size',()=>{
  const bytes=zip([['compressed.txt','x'.repeat(1024*1024)]],{deflate:true});
  const central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  bytes.writeUInt32LE(1,22);bytes.writeUInt32LE(1,central+24);reject('zip',bytes);
});
test('Office XML accepts explicit UTF16 encoding',()=>{
  const unicode=Buffer.concat([Buffer.from([255,254]),Buffer.from(docXml,'utf16le')]);
  accept('docx',zip([['[Content_Types].xml',typesXml],['word/document.xml',unicode]]));
});
