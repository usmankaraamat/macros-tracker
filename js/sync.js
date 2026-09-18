// sync.js -- Email-account multi-device sync over Supabase.

// ---- SYNC · Supabase --------------------------------------------------------
// Identity is the same email magic-link account used by hosted AI. RLS scopes
// the single sync document to auth.uid(). Merge is per-day last-write-wins
// (LedgerCore.mergeSyncStates); every sync is pull→merge→push so a push can
// never clobber a day it hasn't seen. All failures degrade to offline-only.
const SYNC_META_KEY = 'ledger_sync_meta';
let syncBusy = false, syncQueued = false, syncTimer = null;
let syncWaiters = [];

function supaUrl(){ return getKey(LS.supaUrl) || SUPA_DEFAULT_URL; }
function supaAnonKey(){ return getKey(LS.supaKey) || SUPA_DEFAULT_KEY; }
function syncConfigured(){ return !!(supaUrl() && supaAnonKey() && hostedAccountConfigured()); }
function setSyncDot(state, tip){
  const el = document.getElementById('syncDot');
  el.className = 'sync-dot ' + state;
  el.title = tip || {off:'Sync off — configure in Settings', ok:'Synced', pending:'Syncing…', err:'Sync error'}[state];
}
function syncMeta(){ try{ return JSON.parse(localStorage.getItem(SYNC_META_KEY)||'{}'); }catch(e){ return {}; } }
function stampSyncMeta(date){
  try{ const m = syncMeta(); m[date] = new Date().toISOString(); localStorage.setItem(SYNC_META_KEY, JSON.stringify(m)); }catch(e){}
}
function targetsStamp(){ return getKey('ledger_targets_updated'); }
function stampTargets(){ setKey('ledger_targets_updated', new Date().toISOString()); }

// Kept only so backups created by the retired passphrase flow remain importable.
async function sha256hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
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
async function supaFetch(path, opts){
  const url = supaUrl().replace(/\/+$/,'') + path;
  const k = supaAnonKey();
  const session = await hostedSession();
  if (!session) throw new Error('sign in required');
  const h = {apikey:k, Authorization:'Bearer '+session.access_token, 'Content-Type':'application/json'};
  return fetch(url, Object.assign({}, opts, {
    headers: Object.assign(h, (opts&&opts.headers)||{})
  }));
}
// One full cycle: pull remote → merge per-day → apply locally → push the merge back.
async function syncNow(){
  if (!syncConfigured()){ setSyncDot('off'); return {ok:false, error:new Error('sign in required')}; }
  if (syncBusy){
    syncQueued = true;
    return new Promise(resolve => syncWaiters.push(resolve));
  }
  syncBusy = true; setSyncDot('pending');
  try {
    const r = await supaFetch('/rest/v1/rpc/account_sync_get', {method:'POST', body:'{}'});
    if (!r.ok) throw new Error('pull '+r.status);
    const remote = await r.json();
    const merged = LedgerCore.mergeRecordStates(
      {days:collectDays(),meta:syncMeta(),tombstones:entryTombstones(),clears:dayClears()},
      remote || {days:{},meta:{},tombstones:{},clears:{}});
    Object.keys(merged.days).forEach(d=>{
      try { localStorage.setItem('ledger_'+d, JSON.stringify(merged.days[d])); } catch(e){}
    });
    try { localStorage.setItem(SYNC_META_KEY, JSON.stringify(merged.meta)); } catch(e){}
    try { localStorage.setItem(TOMBSTONE_KEY,JSON.stringify(merged.tombstones||{}));
          localStorage.setItem(CLEAR_KEY,JSON.stringify(merged.clears||{})); } catch(e){}
    if (remote && remote.targets && (remote.tUpdated||'') > targetsStamp()){
      try {
        localStorage.setItem('ledger_targets', JSON.stringify(remote.targets));
        if (remote.pen) localStorage.setItem('ledger_pen', JSON.stringify(remote.pen));
        setKey('ledger_targets_updated', remote.tUpdated);
        loadTargets(); initFoods();
        if(typeof resetTernToDefaults==='function')resetTernToDefaults();
        fillTargetInputs();
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
    const km = LedgerCore.mergeWorkoutStates(
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
    migrateLocalData(); initFoods(); load(); updateDayLabel(); render();
    const state = { v:1, days: merged.days, meta: merged.meta,
      targets: {floor:FLOOR_M, ceil:CEIL_M, pCfg:P_CFG, cCap:C_CAP, fCap:F_CAP, maint:MAINT, profile:PROFILE, trendStart:TREND_START, goalTargets:GOAL_TARGETS, goalTargetDate:GOAL_TARGET_DATE, goal:GOAL, mealPlan:MEAL_PLAN, train:TRAIN, ternDefaults:TERN_DEFAULTS},
      pen: {k:Math.round((INFLATE-1)*100), p:Math.round((1-DEDUCT)*100)},
      tUpdated: targetsStamp(),
      templates: templates(), tplUpdated: tplStamp(),
      supps: supps(), suppsUpdated: suppsStamp(),
      suppLog: sm.days, sMeta: sm.meta,
      workouts: km.days, wkMeta: km.meta,
      exercises: exerciseCatalog(), exUpdated: catalogStamp(),
      tombstones:merged.tombstones||{}, clears:merged.clears||{}, schema:DATA_SCHEMA_VERSION,
      weights: wm.days, wMeta: wm.meta,
      measures: mm.days, mMeta: mm.meta };
    const p = await supaFetch('/rest/v1/rpc/account_sync_put', {
      method:'POST', body: JSON.stringify({p_blob: state})
    });
    if (!p.ok) throw new Error('push '+p.status);
    setSyncDot('ok');
    return {ok:true};
  } catch(e){
    setSyncDot('err', 'Sync error: ' + e.message);
    return {ok:false, error:e};
  } finally {
    syncBusy = false;
    if (syncQueued){
      syncQueued = false;
      const waiters = syncWaiters.splice(0);
      syncNow().then(result => waiters.forEach(resolve => resolve(result)));
    }
  }
}
function scheduleSync(){
  durableMirrorSoon();
  if (!syncConfigured()) return;
  setSyncDot('pending');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 3000);       // debounce bursts of edits into one cycle
}
document.addEventListener('visibilitychange', ()=>{
  if (!document.hidden) { syncNow(); return; }           // tab back in focus → pick up other devices' edits
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; syncNow(); }  // leaving with edits pending → flush now
});
