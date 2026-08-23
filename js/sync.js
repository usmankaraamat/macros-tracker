// sync.js -- End-to-end-encrypted multi-device sync over Supabase + WebCrypto.
// The server only ever stores ciphertext.

// ---- SYNC · Supabase + WebCrypto -------------------------------------------
// Identity is a passphrase: PBKDF2 derives 512 bits — half becomes the row id
// (unguessable), half an AES-GCM key. Same passphrase anywhere = same account.
// The server only ever stores ciphertext. Merge is per-day last-write-wins
// (LedgerCore.mergeSyncStates); every sync is pull→merge→push so a push can
// never clobber a day it hasn't seen. All failures degrade to offline-only.
const SYNC_META_KEY = 'ledger_sync_meta';
let syncCreds = null;                          // cached {id, key} for the current passphrase
let syncBusy = false, syncQueued = false, syncTimer = null;

function supaUrl(){ return getKey(LS.supaUrl) || SUPA_DEFAULT_URL; }
function supaAnonKey(){ return getKey(LS.supaKey) || SUPA_DEFAULT_KEY; }
// The backend is built in, so the passphrase alone turns sync on.
function syncConfigured(){ return !!(supaUrl() && supaAnonKey() && getKey(LS.pass)); }
function setSyncDot(state, tip){
  const el = document.getElementById('syncDot');
  el.className = 'sync-dot ' + state;
  el.title = tip || {off:'Sync off — configure in ⚙ Settings', ok:'Synced', pending:'Syncing…', err:'Sync error'}[state];
}
function syncMeta(){ try{ return JSON.parse(localStorage.getItem(SYNC_META_KEY)||'{}'); }catch(e){ return {}; } }
function stampSyncMeta(date){
  try{ const m = syncMeta(); m[date] = new Date().toISOString(); localStorage.setItem(SYNC_META_KEY, JSON.stringify(m)); }catch(e){}
}
function targetsStamp(){ return getKey('ledger_targets_updated'); }
function stampTargets(){ setKey('ledger_targets_updated', new Date().toISOString()); }

async function syncKeys(){
  if (syncCreds) return syncCreds;
  const enc = new TextEncoder();
  const mat = await crypto.subtle.importKey('raw', enc.encode(getKey(LS.pass)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    {name:'PBKDF2', salt: enc.encode('ledger-sync-v1'), iterations: 200000, hash:'SHA-256'}, mat, 512));
  const id = Array.from(bits.slice(0,32)).map(b=>b.toString(16).padStart(2,'0')).join('');
  const key = await crypto.subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt','decrypt']);
  return (syncCreds = {id, key});
}
// Hex SHA-256 of a string — used to bind a backup to a sync account (owner gate).
async function sha256hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
// btoa via chunks — String.fromCharCode(...bigArray) overflows the stack on large blobs.
function bufToB64(buf){
  const u = new Uint8Array(buf); let s = '';
  for (let i=0; i<u.length; i+=0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i+0x8000));
  return btoa(s);
}
function b64ToBuf(s){
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i=0; i<bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function syncEncrypt(obj){
  const {key} = await syncKeys();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return bufToB64(out.buffer);
}
async function syncDecrypt(b64s){
  const {key} = await syncKeys();
  const u = b64ToBuf(b64s);
  const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv: u.slice(0,12)}, key, u.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}
// Every stored day, INCLUDING empty ones — a cleared day is data and must propagate.
function collectDays(){
  const days = {};
  try {
    for (let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      const m = k && k.match(/^ledger_(\d{4}-\d{2}-\d{2})$/);
      if (!m) continue;
      try { const l = JSON.parse(localStorage.getItem(k)); if (Array.isArray(l)) days[m[1]] = l; } catch(e){}
    }
  } catch(e){}
  days[VIEW_DATE] = ledger;                    // on-screen state wins over its stored copy
  return days;
}
function supaFetch(path, opts){
  const url = supaUrl().replace(/\/+$/,'') + path;
  const k = supaAnonKey();
  // New-format publishable keys (sb_…) go in apikey only; legacy anon keys are JWTs
  // and PostgREST wants them in Authorization too.
  const h = {apikey:k, 'Content-Type':'application/json'};
  if (!k.startsWith('sb_')) h.Authorization = 'Bearer '+k;
  return fetch(url, Object.assign({}, opts, {
    headers: Object.assign(h, (opts&&opts.headers)||{})
  }));
}
// One full cycle: pull remote → merge per-day → apply locally → push the merge back.
async function syncNow(){
  if (!syncConfigured()){ setSyncDot('off'); return; }
  if (syncBusy){ syncQueued = true; return; }
  syncBusy = true; setSyncDot('pending');
  try {
    const {id} = await syncKeys();
    // Reads/writes go through SECURITY DEFINER RPCs (sync_get/sync_put) — anon has no
    // direct table access, so an attacker can't enumerate every row's ciphertext; you
    // can only fetch/write a row whose (unguessable) id you already hold.
    const r = await supaFetch('/rest/v1/rpc/sync_get', {method:'POST', body: JSON.stringify({p_id:id})});
    if (!r.ok) throw new Error('pull '+r.status);
    const remoteBlob = await r.json();            // scalar text: the stored blob, or null
    let remote = null;
    if (remoteBlob){
      try { remote = await syncDecrypt(remoteBlob); }
      catch(e){ throw new Error('cannot decrypt — passphrase collision or corrupt blob'); }
    }
    const merged = LedgerCore.mergeSyncStates({days: collectDays(), meta: syncMeta()}, remote || {days:{}, meta:{}});
    Object.keys(merged.days).forEach(d=>{
      try { localStorage.setItem('ledger_'+d, JSON.stringify(merged.days[d])); } catch(e){}
    });
    try { localStorage.setItem(SYNC_META_KEY, JSON.stringify(merged.meta)); } catch(e){}
    if (remote && remote.targets && (remote.tUpdated||'') > targetsStamp()){
      try {
        localStorage.setItem('ledger_targets', JSON.stringify(remote.targets));
        if (remote.pen) localStorage.setItem('ledger_pen', JSON.stringify(remote.pen));
        setKey('ledger_targets_updated', remote.tUpdated);
        loadTargets(); fillTargetInputs();
      } catch(e){}
    }
    if (remote && Array.isArray(remote.templates) && (remote.tplUpdated||'') > tplStamp()){
      try {
        localStorage.setItem('ledger_templates', JSON.stringify(remote.templates));
        setKey('ledger_tpl_updated', remote.tplUpdated);
        renderTemplates();
      } catch(e){}
    }
    if (remote && Array.isArray(remote.supps) && (remote.suppsUpdated||'') > suppsStamp()){
      try {
        localStorage.setItem('ledger_supps', JSON.stringify(remote.supps));
        setKey('ledger_supps_updated', remote.suppsUpdated);
      } catch(e){}
    }
    // Weights merge per-date like ledger days (values are kg numbers, same LWW rules).
    const wm = LedgerCore.mergeSyncStates(
      {days: weightsMap(), meta: weightsMeta()},
      {days: (remote && remote.weights) || {}, meta: (remote && remote.wMeta) || {}});
    saveWeights(wm.days, wm.meta);
    // Body measurements merge per-date like weights — the day value is a {key:cm} object,
    // which mergeSyncStates carries as a whole under the same LWW rules.
    const mm = LedgerCore.mergeSyncStates(
      {days: measureMap(), meta: measureMeta()},
      {days: (remote && remote.measures) || {}, meta: (remote && remote.mMeta) || {}});
    saveMeasures(mm.days, mm.meta);
    // Dose log is per-day arrays of supplement ids — the same shape ledger days have,
    // so the identical per-day LWW merge applies.
    const sm = LedgerCore.mergeSyncStates(
      {days: suppLog(), meta: suppLogMeta()},
      {days: (remote && remote.suppLog) || {}, meta: (remote && remote.sMeta) || {}});
    saveSuppLog(sm.days, sm.meta);
    // Training sessions are one object per day — the same shape the per-day LWW merge
    // already handles, so logging legs on the phone and arms on the PC is safe.
    const km = LedgerCore.mergeSyncStates(
      {days: allWorkouts(), meta: workoutMeta()},
      {days: (remote && remote.workouts) || {}, meta: (remote && remote.wkMeta) || {}});
    Object.keys(km.days).forEach(d=>{
      try { localStorage.setItem(WK_PREFIX+d, JSON.stringify(km.days[d])); } catch(e){}
    });
    saveWorkoutMeta(km.meta);
    // The exercise catalogue is one stamped list, like the supplement protocols.
    if (remote && Array.isArray(remote.exercises) && (remote.exUpdated||'') > catalogStamp()){
      try {
        localStorage.setItem('ledger_exercises', JSON.stringify(remote.exercises));
        setKey('ledger_exercises_updated', remote.exUpdated);
      } catch(e){}
    }
    load(); updateDayLabel(); render();        // reflect whatever the merge decided for the on-screen day
    const state = { v:1, days: merged.days, meta: merged.meta,
      targets: {floor:FLOOR_M, ceil:CEIL_M, pCfg:P_CFG, cCap:C_CAP, fCap:F_CAP, maint:MAINT, profile:PROFILE, trendStart:TREND_START, goalTargets:GOAL_TARGETS, goalTargetDate:GOAL_TARGET_DATE, goal:GOAL, mealPlan:MEAL_PLAN, train:TRAIN},
      pen: {k:Math.round((INFLATE-1)*100), p:Math.round((1-DEDUCT)*100)},
      tUpdated: targetsStamp(),
      templates: templates(), tplUpdated: tplStamp(),
      supps: supps(), suppsUpdated: suppsStamp(),
      suppLog: sm.days, sMeta: sm.meta,
      workouts: km.days, wkMeta: km.meta,
      exercises: exerciseCatalog(), exUpdated: catalogStamp(),
      weights: wm.days, wMeta: wm.meta,
      measures: mm.days, mMeta: mm.meta };
    const blob = await syncEncrypt(state);
    const p = await supaFetch('/rest/v1/rpc/sync_put', {
      method:'POST', body: JSON.stringify({p_id: id, p_blob: blob})   // upsert; server stamps updated_at
    });
    if (!p.ok) throw new Error('push '+p.status);
    setSyncDot('ok');
  } catch(e){
    setSyncDot('err', 'Sync error: ' + e.message);
  } finally {
    syncBusy = false;
    if (syncQueued){ syncQueued = false; syncNow(); }
  }
}
function scheduleSync(){
  if (!syncConfigured()) return;
  setSyncDot('pending');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 3000);       // debounce bursts of edits into one cycle
}
document.addEventListener('visibilitychange', ()=>{
  if (!document.hidden) { syncNow(); return; }           // tab back in focus → pick up other devices' edits
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; syncNow(); }  // leaving with edits pending → flush now
});
