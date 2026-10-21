import { crc32, inflateRawSync, inflateSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_EXPANDED = 100 * 1024 * 1024;
const types = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',zip:'application/zip',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const invalid = () => { throw Object.assign(new Error('Содержимое файла повреждено, не поддерживается или не соответствует выбранному формату.'), {status:415}); };
const check = condition => { if (!condition) invalid(); };
function dimensions(width,height) { check(width>0 && height>0 && width<=32768 && height<=32768 && width*height<=40000000); }
function png(bytes) {
  check(bytes.length>=45 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  let offset=8, header=false, end=false, data=[], imageHeader, palette=false;
  while(offset<bytes.length) {
    check(offset+12<=bytes.length); const length=bytes.readUInt32BE(offset), type=bytes.toString('ascii',offset+4,offset+8);
    check(length<=bytes.length-offset-12 && /^[A-Za-z]{4}$/.test(type));
    const body=bytes.subarray(offset+8,offset+8+length);
    check(crc32(bytes.subarray(offset+4,offset+8+length))===bytes.readUInt32BE(offset+8+length));
    if(!header) {
      check(type==='IHDR' && length===13); dimensions(body.readUInt32BE(0),body.readUInt32BE(4));
      const allowed={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      check(allowed[body[9]]?.includes(body[8]) && body[10]===0 && body[11]===0 && body[12]<=1); header=true; imageHeader=body;
    } else check(type!=='IHDR');
    if(type==='PLTE'){check(length>0 && length<=768 && length%3===0);palette=true;}
    if(type==='IDAT') data.push(body);
    offset+=12+length;
    if(type==='IEND') {check(length===0 && offset===bytes.length);end=true;break;}
  }
  check(end && data.length>0);
  const decoded=inflateSync(Buffer.concat(data),{maxOutputLength:64*1024*1024});
  const width=imageHeader.readUInt32BE(0),height=imageHeader.readUInt32BE(4),depth=imageHeader[8],color=imageHeader[9],channels={0:1,2:3,3:1,4:2,6:4}[color];
  if(color===3)check(palette);
  const passes=imageHeader[12]===0?[[0,0,1,1]]:[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
  let pos=0;
  for(const [x,y,dx,dy] of passes){const w=Math.max(0,Math.ceil((width-x)/dx)),h=Math.max(0,Math.ceil((height-y)/dy));if(!w||!h)continue;const row=Math.ceil(w*channels*depth/8)+1;check(pos+row*h<=decoded.length);for(let i=0;i<h;i++){check(decoded[pos]<=4);pos+=row;}}
  check(pos===decoded.length);
}
function jpeg(bytes) {
  check(bytes.length>12 && bytes[0]===255 && bytes[1]===216 && bytes.at(-2)===255 && bytes.at(-1)===217);
  let offset=2, frame=false;
  while(offset<bytes.length-2) {
    check(bytes[offset++]===255); while(bytes[offset]===255)offset++;
    const marker=bytes[offset++]; check(marker!==0 && marker!==216 && marker!==217);
    if(marker===1 || (marker>=208 && marker<=215))continue;
    check(offset+2<=bytes.length);const length=bytes.readUInt16BE(offset);check(length>=2 && offset+length<=bytes.length-2);
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
      check(length>=8);dimensions(bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3));
      const channels=bytes[offset+7];check(channels>0 && length===8+channels*3);frame=true;
    }
    if(marker===218) {check(frame && length>=6 && offset+length<bytes.length-2);return;}
    offset+=length;
  }
  invalid();
}
function webp(bytes) {
  check(bytes.length>=20 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP' && bytes.readUInt32LE(4)+8===bytes.length);
  let frame=false, extended=false;
  function chunks(start,end,nested=false) {
    let offset=start;
    while(offset<end) {
      check(offset+8<=end); const type=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),pos=offset+8;
      check(length<=end-pos);const body=bytes.subarray(pos,pos+length);
      if(type==='VP8 ') {check(length>=11 && body.subarray(3,6).equals(Buffer.from([157,1,42])) && (body[0]&1)===0);dimensions(body.readUInt16LE(6)&16383,body.readUInt16LE(8)&16383);frame=true;}
      if(type==='VP8L') {check(length>=6 && body[0]===47 && (body[4]&224)===0);const bits=body.readUInt32LE(1);dimensions((bits&16383)+1,((bits>>>14)&16383)+1);frame=true;}
      if(type==='VP8X') {check(!nested && !extended && length===10);dimensions(body.readUIntLE(4,3)+1,body.readUIntLE(7,3)+1);extended=true;}
      if(type==='ANMF') {check(!nested && extended && length>=24);chunks(pos+16,pos+length,true);}
      offset=pos+length+(length&1);check(offset<=end);
    }
    check(offset===end);
  }
  chunks(12,bytes.length);check(frame);
}
function pdf(bytes) {
  const head=bytes.subarray(0,16).toString('latin1');check(/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n|\s)/.test(head));
  const tail=bytes.subarray(Math.max(0,bytes.length-2048)).toString('latin1');
  const end=/startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);check(end);
  const offset=Number(end[1]);check(Number.isSafeInteger(offset) && offset>0 && offset<bytes.length);
  const target=bytes.subarray(offset,Math.min(bytes.length,offset+128)).toString('latin1');
  check(/^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(target));
  const text=bytes.toString('latin1');check(/\b\d+\s+\d+\s+obj\b/.test(text) && /\bendobj\b/.test(text) && /\/Root\b/.test(text));
}
function text(bytes) {
  const decoded=utf8.decode(bytes);check(decoded.length>0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded));
}
function zip(bytes) {
  check(bytes.length>=22);let eocd=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) {
    if(bytes.readUInt32LE(i)===0x06054b50 && i+22+bytes.readUInt16LE(i+20)===bytes.length){eocd=i;break;}
  }
  check(eocd>=0 && bytes.readUInt16LE(eocd+4)===0 && bytes.readUInt16LE(eocd+6)===0);
  const count=bytes.readUInt16LE(eocd+10),size=bytes.readUInt32LE(eocd+12),start=bytes.readUInt32LE(eocd+16);
  check(count<=2048 && bytes.readUInt16LE(eocd+8)===count && start+size===eocd);
  const entries=new Map(), ranges=[];let offset=start,total=0;
  for(let index=0;index<count;index++) {
    check(offset+46<=eocd && bytes.readUInt32LE(offset)===0x02014b50);
    const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),crc=bytes.readUInt32LE(offset+16),packed=bytes.readUInt32LE(offset+20),expanded=bytes.readUInt32LE(offset+24);
    const nameLength=bytes.readUInt16LE(offset+28),extraLength=bytes.readUInt16LE(offset+30),commentLength=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
    check(!(flags&0x2041) && [0,8].includes(method) && packed!==0xffffffff && expanded!==0xffffffff && local!==0xffffffff && bytes.readUInt16LE(offset+34)===0);
    check(offset+46+nameLength+extraLength+commentLength<=eocd && expanded<=50*1024*1024);
    total+=expanded;check(total<=MAX_EXPANDED);
    const nameBytes=bytes.subarray(offset+46,offset+46+nameLength),name=(flags&2048)?utf8.decode(nameBytes):nameBytes.toString('latin1');
    check(name && !/[\\\x00-\x1f\x7f]/.test(name) && !name.startsWith('/') && !/^[A-Za-z]:/.test(name) && !name.split('/').some(part=>part==='..'||part==='.') && !entries.has(name));
    const mode=bytes.readUInt32LE(offset+38)>>>16;check((mode&0xf000)!==0xa000);
    check(local+30<=start && bytes.readUInt32LE(local)===0x04034b50 && bytes.readUInt16LE(local+6)===flags && bytes.readUInt16LE(local+8)===method);
    const localName=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),dataStart=local+30+localName+localExtra;
    check(localName===nameLength && bytes.subarray(local+30,local+30+localName).equals(nameBytes) && dataStart<=start && packed<=start-dataStart);
    if(!(flags&8))check(bytes.readUInt32LE(local+14)===crc && bytes.readUInt32LE(local+18)===packed && bytes.readUInt32LE(local+22)===expanded);
    ranges.push([local,dataStart+packed]);
    const content=bytes.subarray(dataStart,dataStart+packed);
    const decoded=method===0?content:inflateRawSync(content,{maxOutputLength:expanded+1});
    check(decoded.length===expanded && crc32(decoded)===crc);
    if(name.endsWith('/'))check(expanded===0);
    entries.set(name,decoded);offset+=46+nameLength+extraLength+commentLength;
  }
  check(offset===eocd);ranges.sort((a,b)=>a[0]-b[0]);
  for(let i=1;i<ranges.length;i++)check(ranges[i-1][1]<=ranges[i][0]);
  return entries;
}
function xml(bytes) {
  const encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':bytes[0]===60&&bytes[1]===0?'utf-16le':bytes[0]===0&&bytes[1]===60?'utf-16be':'utf-8';
  return new TextDecoder(encoding,{fatal:true}).decode(bytes);
}
function office(entries,ext) {
  const path=ext==='docx'?'word/document.xml':'xl/workbook.xml';
  check(entries.has('[Content_Types].xml') && entries.has(path));
  const types=xml(entries.get('[Content_Types].xml')), document=xml(entries.get(path));
  check(!/<!DOCTYPE|<!ENTITY/i.test(types+document));
  check(/<(?:\w+:)?Types\b/.test(types) && /schemas\.openxmlformats\.org\/package\/2006\/content-types/.test(types));
  check(ext==='docx' ? /<(?:\w+:)?document\b/.test(document) && /wordprocessingml\/2006\/main/.test(document) : /<(?:\w+:)?workbook\b/.test(document) && /spreadsheetml\/2006\/main/.test(document));
}
export function validateUploadContent(ext,bytes,fail) {
  try {
    check(Buffer.isBuffer(bytes) && bytes.length>0 && bytes.length<=10*1024*1024);
    if(ext==='png')png(bytes);else if(ext==='jpg'||ext==='jpeg')jpeg(bytes);else if(ext==='webp')webp(bytes);else if(ext==='pdf')pdf(bytes);else if(ext==='txt')text(bytes);
    else if(['zip','docx','xlsx'].includes(ext)){const entries=zip(bytes);if(ext!=='zip')office(entries,ext);}
    else invalid();
  } catch(error) {
    const message=error.status===415?error.message:'Содержимое файла повреждено или превышает допустимые ограничения формата.';
    if(fail)fail(415,message);
    throw Object.assign(new Error(message),{status:415});
  }
}
export function validateUploadFile({name,contentType,bytes}) {
  const ext=typeof name==='string'?name.split('.').pop().toLowerCase():'';
  check(types[ext] && contentType===types[ext]);
  validateUploadContent(ext,bytes);
}
