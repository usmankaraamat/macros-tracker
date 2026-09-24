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

// Compare against the last deployed state, not just the previous commit: a push
// of several commits, or an uncommitted edit, used to slip a shell change past
// this check with the old CACHE still in place. CI passes BASE_SHA (the commit
// before the push); locally the base is HEAD when there are uncommitted
// changes, else the previous commit.
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});
function baseRef(){
  const env=(process.env.BASE_SHA||'').trim();
  if(env&&!/^0+$/.test(env)){
    try{git('cat-file','-e',`${env}^{commit}`);return env;}catch{}
  }
  try{
    if(git('status','--porcelain','--untracked-files=no').trim())return 'HEAD';
    git('rev-parse','--verify','HEAD^');
    return 'HEAD^';
  }catch{return null;}
}

const base=baseRef();
if(base){
  const cached=new Set(shell.map(p=>p.replace(/^\.\//,'')));
  const changed=git('diff','--name-only',base).trim().split(/\r?\n/).filter(Boolean);
  const shellChanged=changed.filter(f=>cached.has(f));
  if(shellChanged.length){
    let old=null;
    try{old=git('show',`${base}:sw.js`).match(/const\s+CACHE\s*=\s*['"]([^'"]+)/);}catch{}
    if(old&&old[1]===cache[1]){
      throw new Error(`${shellChanged.join(', ')} changed since ${base} but CACHE is still ${cache[1]}; bump it in sw.js`);
    }
  }
}
console.log(`cache check ok: ${cache[1]}, ${shell.length} shell files${base?` (compared with ${base})`:''}`);
