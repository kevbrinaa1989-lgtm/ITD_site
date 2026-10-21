import { readdirSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredData, verifyBackup } from '../data-storage.mjs';
export function pruneLocalBackups(parent, current, keep, dataDir) {
  if(!Number.isSafeInteger(keep)||keep<1)throw Error('Invalid local retention');
  if(lstatSync(parent).isSymbolicLink())throw Error('Backup root cannot be a symlink');
  const root=realpathSync(parent),data=realpathSync(dataDir),latest=realpathSync(current);
  const inside=(a,b)=>{const p=relative(a,b);return !p||(!p.startsWith('..')&&!isAbsolute(p));};
  if(inside(data,root)||inside(root,data)||resolve(root,latest)!==latest||!inside(root,latest)||relative(root,latest).includes('/'))throw Error('Unsafe backup retention directory');
  const candidates=[];
  for(const name of readdirSync(root)) {
    if(!/^ITD-\d{4}-\d{2}-\d{2}T/.test(name))continue;
    const folder=join(root,name),stat=lstatSync(folder);
    if(stat.isSymbolicLink()||!stat.isDirectory())continue;
    try {verifyBackup(folder);candidates.push(folder);}catch { /* Keep incomplete/unknown folders for manual inspection. */ }
  }
  if(!candidates.includes(latest))throw Error('Current verified backup is not in retention root');
  candidates.sort().reverse();
  const retained=new Set([latest,...candidates.filter(p=>p!==latest).slice(0,keep-1)]);
  for(const folder of candidates)if(!retained.has(folder)){verifyBackup(folder);rmSync(folder,{recursive:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  pruneLocalBackups(process.argv[2],process.argv[3],Number(process.argv[4]),configuredData());
