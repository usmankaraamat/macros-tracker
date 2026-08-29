import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const LedgerCore=require('../core.js');
const html=fs.readFileSync(new URL('../tests.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(m=>m[1]).filter(s=>s.trim());
if(!scripts.length)throw new Error('No inline test script found');

class Element{
  constructor(){this.children=[];this.className='';this.textContent='';this.innerHTML='';}
  appendChild(child){this.children.push(child);return child;}
}
const nodes={out:new Element(),summary:new Element()};
const sandbox={LedgerCore,console,document:{
  getElementById:id=>nodes[id]||(nodes[id]=new Element()),
  createElement:()=>new Element()
}};
sandbox.globalThis=sandbox;
vm.createContext(sandbox);
vm.runInContext(scripts.join('\n')+'\n;globalThis.__testResult={passed,failed,summary:sum.textContent};',sandbox,{filename:'tests.html'});
const result=sandbox.__testResult;
console.log(result.summary);
if(result.failed)process.exit(1);
