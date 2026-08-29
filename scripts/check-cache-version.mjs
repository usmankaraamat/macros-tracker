import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root=path.resolve(new URL('..',import.meta.url).pathname.replace(/^\/(.:)/,'$1'));
const sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');
const cache=sw.match(/const\s+CACHE\s*=\s*['"]([^'"]+)/);
const shellMatch=sw.match(/const\s+SHELL\s*=\s*(\[[\s\S]*?\]);/);
if(!cache||!shellMatch)throw new Error('Could not read CACHE or SHELL from sw.js');
const shell=JSON.parse(shellMatch[1].replace(/'/g,'"'));
const missing=shell.filter(p=>!fs.existsSync(path.join(root,p.replace(/^\.\//,''))));
if(missing.length)throw new Error(`Cached files missing: ${missing.join(', ')}`);
if(new Set(shell).size!==shell.length)throw new Error('Duplicate entry in service-worker SHELL');

try{
  execFileSync('git',['rev-parse','HEAD^'],{cwd:root,stdio:'ignore'});
  const changed=execFileSync('git',['diff','--name-only','HEAD^','HEAD'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
  const cached=new Set(shell.map(p=>p.replace(/^\.\//,'')));
  const affectsShell=changed.some(f=>cached.has(f.replace(/\\/g,'/')));
  if(affectsShell){
    if(!changed.includes('sw.js'))throw new Error('A cached app-shell file changed without sw.js');
    const old=execFileSync('git',['show','HEAD^:sw.js'],{cwd:root,encoding:'utf8'}).match(/const\s+CACHE\s*=\s*['"]([^'"]+)/);
    if(old&&old[1]===cache[1])throw new Error(`Cached files changed but CACHE is still ${cache[1]}`);
  }
}catch(e){
  if(e.message&&!/unknown revision|bad revision|Could not read|does not have any commits/.test(e.message))throw e;
}
console.log(`cache check ok: ${cache[1]}, ${shell.length} shell files`);
