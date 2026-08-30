// storage.js -- schema migration, stable record identity, and an IndexedDB durability
// mirror. localStorage remains the synchronous working set; IndexedDB is a second copy
// that can restore missing records after partial eviction without changing app semantics.
const DATA_SCHEMA_VERSION = 4;
const DATA_SCHEMA_KEY = 'ledger_schema_version';
const TOMBSTONE_KEY = 'ledger_entry_tombstones';
const CLEAR_KEY = 'ledger_day_clears';
const DURABLE_DB = 'eatify-durable-v1';
let _durableTimer = null, _durableDb = null;

function hashId(s){
  let h = 2166136261;
  for(let i=0;i<String(s).length;i++){ h ^= String(s).charCodeAt(i); h = Math.imul(h,16777619); }
  return (h>>>0).toString(36);
}
function newRecordId(prefix){
  if (typeof crypto !== 'undefined' && crypto.getRandomValues){
    const u=new Uint32Array(3); crypto.getRandomValues(u);
    return `${prefix||'r'}_${Array.from(u).map(n=>n.toString(36)).join('')}`;
  }
  return `${prefix||'r'}_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
function ensureEntryMeta(e,date,index){
  if(!e||typeof e!=='object')return e;
  if(!e._id)e._id='food_'+hashId(`${date}|${index}|${e.name||''}|${e.grams||0}|${e.partOf||''}`);
  if(!e.loggedAt&&e.at)e.loggedAt=e.at;
  if(!e.eatenAt&&e.at)e.eatenAt=e.at;
  if(!e.updatedAt)e.updatedAt=e.loggedAt||e.at||`${date}T00:00:00.000Z`;
  return e;
}
function ensureLedgerDay(list,date){
  return Array.isArray(list)?list.map((e,i)=>ensureEntryMeta(e,date,i)):[];
}
function ensureWorkoutMeta(w,date){
  if(!w||typeof w!=='object')w={date,exercises:[]};
  w.date=w.date||date; w._id=w._id||'workout_'+date; w._tombstones=w._tombstones||{};
  (w.exercises||[]).forEach((ex)=>{
    // One logical exercise block exists per movement/session, so this ID is
    // deterministic across devices; concurrent sets then merge into that block.
    ex._id=ex._id||`exercise_${hashId(`${date}|${ex.id||ex.name||''}|${ex.equipment||''}`)}`;
    ex.updatedAt=ex.updatedAt||ex.loggedAt||w.endedAt||w.startedAt||`${date}T00:00:00.000Z`;
    (ex.sets||[]).forEach((s,j)=>{
      s._id=s._id||`set_${hashId(`${ex._id}|${j}|${s.kg||0}|${s.reps||0}|${s.bw?'bw':''}`)}`;
      s.updatedAt=s.updatedAt||s.loggedAt||ex.updatedAt;
    });
  });
  return LedgerCore.normalizeWorkoutDay(w);
}
function entryTombstones(){try{return JSON.parse(localStorage.getItem(TOMBSTONE_KEY)||'{}');}catch(e){return {};}}
function dayClears(){try{return JSON.parse(localStorage.getItem(CLEAR_KEY)||'{}');}catch(e){return {};}}
function tombstoneEntry(date,id,stamp){
  if(!id)return;const all=entryTombstones(),list=all[date]||[],at=stamp||new Date().toISOString();
  const old=list.find(t=>t.id===id); if(old)old.deletedAt=at; else list.push({id,deletedAt:at});
  all[date]=list;localStorage.setItem(TOMBSTONE_KEY,JSON.stringify(all));
}
function untombstoneEntry(date,id){
  const all=entryTombstones();if(all[date]){all[date]=all[date].filter(t=>t.id!==id);if(!all[date].length)delete all[date];}
  localStorage.setItem(TOMBSTONE_KEY,JSON.stringify(all));
}
function clearDayRecords(date,records,stamp){
  const at=stamp||new Date().toISOString();(records||[]).forEach(r=>tombstoneEntry(date,r&&r._id,at));
  const c=dayClears();c[date]=at;localStorage.setItem(CLEAR_KEY,JSON.stringify(c));
}
function restoreDayRecords(date,records){
  const ids=new Set((records||[]).map(r=>r&&r._id).filter(Boolean));
  const all=entryTombstones(); if(all[date]){all[date]=all[date].filter(t=>!ids.has(t.id));if(!all[date].length)delete all[date];}
  localStorage.setItem(TOMBSTONE_KEY,JSON.stringify(all));
  const c=dayClears();delete c[date];localStorage.setItem(CLEAR_KEY,JSON.stringify(c));
}

function migrateLocalData(){
  const current=+(localStorage.getItem(DATA_SCHEMA_KEY)||0);
  // Migrations are idempotent because imports and sync can introduce old records later.
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i), dm=k&&k.match(/^ledger_(\d{4}-\d{2}-\d{2})$/),
      wm=k&&k.match(/^ledger_workout_(\d{4}-\d{2}-\d{2})$/);
    try{
      if(dm){const v=JSON.parse(localStorage.getItem(k));if(Array.isArray(v))localStorage.setItem(k,JSON.stringify(ensureLedgerDay(v,dm[1])));}
      if(wm){const v=JSON.parse(localStorage.getItem(k));localStorage.setItem(k,JSON.stringify(ensureWorkoutMeta(v,wm[1])));}
    }catch(e){}
  }
  if(current<DATA_SCHEMA_VERSION)localStorage.setItem(DATA_SCHEMA_KEY,String(DATA_SCHEMA_VERSION));
}

function durableAllowed(k){
  if(!/^ledger_/.test(k))return false;
  return !/^ledger_(usda_key|gemini_key|gemini_model|openrouter_key|sync_pass|supa_url|supa_key|rest_)/.test(k);
}
function durableSnapshot(){
  const values={};
  for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(durableAllowed(k))values[k]=localStorage.getItem(k);}
  return {schema:DATA_SCHEMA_VERSION,savedAt:new Date().toISOString(),values};
}
function openDurable(){
  if(_durableDb)return Promise.resolve(_durableDb);
  if(typeof indexedDB==='undefined')return Promise.resolve(null);
  return new Promise(resolve=>{
    const q=indexedDB.open(DURABLE_DB,1);
    q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('snapshots'))q.result.createObjectStore('snapshots');};
    q.onsuccess=()=>resolve(_durableDb=q.result);q.onerror=()=>resolve(null);
  });
}
async function durableRestore(){
  const db=await openDurable();if(!db)return;
  const snap=await new Promise(resolve=>{const q=db.transaction('snapshots','readonly').objectStore('snapshots').get('latest');q.onsuccess=()=>resolve(q.result);q.onerror=()=>resolve(null);});
  if(!snap||!snap.values)return;
  Object.keys(snap.values).forEach(k=>{if(durableAllowed(k)&&localStorage.getItem(k)==null)localStorage.setItem(k,snap.values[k]);});
}
async function durableMirrorNow(){
  clearTimeout(_durableTimer);_durableTimer=null;const db=await openDurable();if(!db)return;
  const snap=durableSnapshot();
  await new Promise(resolve=>{const q=db.transaction('snapshots','readwrite').objectStore('snapshots').put(snap,'latest');q.onsuccess=q.onerror=()=>resolve();});
}
function durableMirrorSoon(){clearTimeout(_durableTimer);_durableTimer=setTimeout(durableMirrorNow,700);}
document.addEventListener('visibilitychange',()=>{if(document.hidden&&_durableTimer)durableMirrorNow();});
