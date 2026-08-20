// lift.js -- The Lift view: session parsing, progression trends, and the recomp
// check that reads strength against bodyweight.

// ---- LIFT: sessions, progression, and the recomp check --------------------
// Storage mirrors the day-ledger pattern — one key per day — so a session is edited,
// merged and synced under exactly the same last-write-wins rules the food log uses.
//   ledger_workout_YYYY-MM-DD  {date, split, exercises:[{id,name,sets:[{kg,reps,bw}],rir}]}
//   ledger_exercises           the canonical catalogue + aliases (seeded from core.js)
// An empty session is stored, not deleted: a cleared day is data and must propagate.
const WK_PREFIX = 'ledger_workout_';
function workoutFor(ds){
  try{
    const w = JSON.parse(localStorage.getItem(WK_PREFIX+ds)||'null');
    if (w && Array.isArray(w.exercises)) return w;
  }catch(e){}
  return { date: ds, split: splitForDate(ds), exercises: [] };
}
function allWorkouts(){
  const out = {};
  try{
    for (let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      const m = k && k.match(/^ledger_workout_(\d{4}-\d{2}-\d{2})$/);
      if (!m) continue;
      try{ const w = JSON.parse(localStorage.getItem(k)); if (w && Array.isArray(w.exercises)) out[m[1]] = w; }catch(e){}
    }
  }catch(e){}
  return out;
}
function workoutMeta(){ try{ return JSON.parse(localStorage.getItem('ledger_workout_meta')||'{}'); }catch(e){ return {}; } }
function saveWorkoutMeta(m){ try{ localStorage.setItem('ledger_workout_meta', JSON.stringify(m)); }catch(e){} }
function saveWorkout(w){
  try{ localStorage.setItem(WK_PREFIX+w.date, JSON.stringify(w)); }catch(e){}
  const m = workoutMeta(); m[w.date] = new Date().toISOString(); saveWorkoutMeta(m);
  scheduleSync();
}
function exerciseCatalog(){
  try{
    const c = JSON.parse(localStorage.getItem('ledger_exercises')||'null');
    if (Array.isArray(c) && c.length) return c;
  }catch(e){}
  return LedgerCore.SEED_EXERCISES.slice();
}
function catalogStamp(){ return getKey('ledger_exercises_updated'); }
function saveCatalog(list){
  try{ localStorage.setItem('ledger_exercises', JSON.stringify(list)); }catch(e){}
  setKey('ledger_exercises_updated', new Date().toISOString());
  scheduleSync();
}
// Weigh-ins as an ascending series — what bodyweight movements need to know their load.
function weightSeries(){
  const m = weightsMap();
  return Object.keys(m).filter(d=>+m[d]>0).sort().map(d=>({date:d, kg:+m[d]}));
}
// One pass over the stored sessions produces every exercise's history, so a page render
// scans localStorage once rather than once per exercise.
function liftTrends(all, W){
  const byKey = {}, names = {}, lastDate = {}, ids = {}, equips = {};
  Object.keys(all).sort().forEach(d=>{
    const deload = !!all[d].deload;
    (all[d].exercises||[]).forEach(ex=>{
      if (!ex || !ex.id) return;
      // Equipment is part of a lift's identity: the same movement on a Smith machine and a
      // free barbell are different lifts and must not share a trend line. Only an EXPLICIT
      // per-session equipment tag segments — existing data (no tag) stays one line per id.
      const key = ex.equipment ? ex.id + '@' + ex.equipment : ex.id;
      names[key] = ex.name || ex.id; lastDate[key] = d; ids[key] = ex.id;
      if (ex.equipment) equips[key] = ex.equipment;
      (byKey[key] = byKey[key] || []).push({date:d, sets:ex.sets||[], rir:ex.rir, deload:deload});
    });
  });
  return Object.keys(byKey).map(key=>({
    id: ids[key], key, equipment: equips[key]||null, lastDate: lastDate[key],
    t: LedgerCore.exerciseTrend(byKey[key], {name:names[key], weights:W})
  }));
}
const SET_TXT = s => s.bw ? (s.kg>0 ? `bw+${s.kg} × ${s.reps}` : `bw × ${s.reps}`) : `${s.kg}kg × ${s.reps}`;
// The form the repeat chip writes back — units are explicit so a light load can never be
// re-read as a set count on the way in.
const SET_IN = s => `${s.bw?'bw+':''}${s.kg}kgx${s.reps}`;

function liftStatus(msg, bad){
  const el = document.getElementById('liftStatus');
  if (!el) return;
  el.hidden = !msg;
  el.className = 'tactical' + (bad ? ' bad' : '');
  if (msg) announce(msg);
  el.innerHTML = msg || '';
}

// ---- rest timer -----------------------------------------------------------
// A 90-second rest between sets, started fresh on every logged set. It is a nudge,
// never a gate: logging is always allowed, and logging again just restarts the count,
// so an interrupted rest resets rather than stacking. Timing is anchored to a target
// timestamp so a throttled tab still reads the true remaining time on the next tick.
// Rest defaults are set by exercise class: a compound needs 2–3 min, an isolation ~90s.
// Short rest on compounds is exactly what drives the within-set rep drop-off, so the timer
// stops being a flat 90 and reads the movement it just followed. Per-exercise overrides live
// on the catalogue record (restSec); the class default is the fallback.
const REST_COMPOUND = 150, REST_ISOLATION = 90, REST_DEFAULT = 90;
// The target time AND the total are mirrored to localStorage, so a rest survives the app being
// evicted in the background: on relaunch, resumeRestTimer reads them and shows the true
// remaining time rather than a fresh (reset) count. The countdown itself is JS, so it can only
// redraw when the app is alive — it cannot chime while the OS has the app killed; it catches up
// the moment you return.
const REST_KEY = 'ledger_rest_end', REST_TOTAL_KEY = 'ledger_rest_total';
let restEnd = 0, restTotal = REST_DEFAULT, restInt = null, restDone = false;
function fmtRest(sec){ const m = Math.floor(sec/60); return m + ':' + String(sec % 60).padStart(2,'0'); }
// The rest a set of just-logged exercises earns: the longest of their per-exercise rests, so a
// session mixing a compound and an isolation rests for the compound.
function restSecondsFor(exercises){
  const cat = exerciseCatalog();
  const byId = {}; cat.forEach(c=>{ if (c && c.id) byId[c.id] = c; });
  let secs = 0;
  (exercises||[]).forEach(x=>{
    const rec = byId[x.id] || x;
    const meta = LedgerCore.exerciseMeta(rec);
    const s = +rec.restSec > 0 ? +rec.restSec
            : meta.pattern === 'compound' ? REST_COMPOUND
            : meta.pattern === 'isolation' ? REST_ISOLATION : REST_DEFAULT;
    if (s > secs) secs = s;
  });
  return secs > 0 ? secs : REST_DEFAULT;
}
function startRestTimer(seconds){
  restTotal = +seconds > 0 ? +seconds : REST_DEFAULT;
  restEnd = Date.now() + restTotal*1000;
  restDone = false;
  try{ localStorage.setItem(REST_KEY, String(restEnd)); localStorage.setItem(REST_TOTAL_KEY, String(restTotal)); }catch(e){}
  const el = document.getElementById('restTimer');
  if (el){ el.hidden = false; el.className = 'rest-timer'; }
  if (!restInt) restInt = setInterval(tickRestTimer, 200);
  tickRestTimer();
}
function stopRestTimer(){
  if (restInt){ clearInterval(restInt); restInt = null; }
  restEnd = 0; restDone = false;
  try{ localStorage.removeItem(REST_KEY); localStorage.removeItem(REST_TOTAL_KEY); }catch(e){}
  const el = document.getElementById('restTimer');
  if (el){ el.hidden = true; el.className = 'rest-timer'; }
}
// On launch, pick up a rest that was still running when the app was last backgrounded or
// killed. A stored end in the future resumes the live countdown; a past one is stale and
// simply cleared, so a long-finished rest never reappears.
function resumeRestTimer(){
  let end = 0, total = 0;
  try{ end = +localStorage.getItem(REST_KEY) || 0; total = +localStorage.getItem(REST_TOTAL_KEY) || 0; }catch(e){}
  if (end > Date.now()){
    restEnd = end; restTotal = total > 0 ? total : REST_DEFAULT; restDone = false;
    const el = document.getElementById('restTimer');
    if (el){ el.hidden = false; el.className = 'rest-timer'; }
    if (!restInt) restInt = setInterval(tickRestTimer, 200);
    tickRestTimer();
  } else if (end){
    try{ localStorage.removeItem(REST_KEY); }catch(e){}
  }
}
function tickRestTimer(){
  const el = document.getElementById('restTimer');
  if (!el){ if (restInt){ clearInterval(restInt); restInt = null; } return; }
  const fill = document.getElementById('restTimerFill');
  const time = document.getElementById('restTimerTime');
  const label = document.getElementById('restTimerLabel');
  const remMs = restEnd - Date.now();
  if (remMs <= 0){
    if (fill) fill.style.width = '0%';
    if (time) time.textContent = '0:00';
    if (label) label.textContent = 'Rest complete — next set';
    el.className = 'rest-timer done';
    if (!restDone){ restDone = true; restChime(); haptic(60); announce('Rest complete'); }
    try{ localStorage.removeItem(REST_KEY); }catch(e){}   // the rest is over; nothing left to resume
    if (restInt){ clearInterval(restInt); restInt = null; }   // hold the "done" state until the next log or Skip
    return;
  }
  const remSec = Math.ceil(remMs/1000);
  if (fill) fill.style.width = Math.max(0, Math.min(100, remMs/(restTotal*1000)*100)) + '%';
  if (time) time.textContent = fmtRest(remSec);
  if (label) label.textContent = 'Rest · ' + fmtRest(restTotal);
}
// A short two-note chime when the rest is up. Best-effort — silently a no-op where the
// Web Audio API is unavailable or blocked.
function restChime(){
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    [784, 1046].forEach((f,i)=>{
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      const t = now + i*0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.18);
    });
    setTimeout(()=>{ try{ ctx.close(); }catch(e){} }, 900);
  }catch(e){}
}
(function bindRestSkip(){
  const skip = document.getElementById('restTimerSkip');
  if (skip) skip.onclick = stopRestTimer;
  resumeRestTimer();   // restore a rest that outlived a background eviction
})();

// ---- live "last time" preview ---------------------------------------------
// While an exercise name is being typed, its last session is shown below the logger —
// the top set above all, so the next top set can be judged against it. Rebuilt from the
// same trend pass the page already computes; cached so a keystroke does not rescan storage.
let liftPreviewData = null;
function setLiftPreviewData(all, W, rows){
  const byId = {};
  (rows||[]).forEach(r=>{ byId[r.id] = r; });
  liftPreviewData = { all, W, byId };
}
// The exercise name on the line the cursor sits in — reusing the logger's own grammar so
// "bench", "bench 60", and "bench 60kg 8" all resolve to the same name while it is typed.
function currentLiftName(){
  const inp = document.getElementById('liftInput');
  if (!inp) return '';
  const val = inp.value || '';
  const pos = inp.selectionStart != null ? inp.selectionStart : val.length;
  const start = val.lastIndexOf('\n', pos - 1) + 1;
  let end = val.indexOf('\n', pos);
  if (end < 0) end = val.length;
  const p = LedgerCore.parseWorkoutLine(val.slice(start, end));
  return p ? (p.name || '').trim() : '';
}
function renderLiftPreview(){
  const el = document.getElementById('liftPreview');
  if (!el) return;
  const name = currentLiftName();
  if (name.length < 2){ el.hidden = true; el.innerHTML = ''; return; }
  if (!liftPreviewData){
    const all = allWorkouts(), W = weightSeries();
    setLiftPreviewData(all, W, liftTrends(all, W));
  }
  const data = liftPreviewData;
  const m = LedgerCore.matchExercise(name, exerciseCatalog());
  const id = m ? m.exercise.id : LedgerCore.exerciseId(name);
  // The most recent PRIOR session with this lift — "last time", so today's own entry
  // (which is what is being typed) is never what we compare against.
  const dates = Object.keys(data.all).filter(d=>d !== VIEW_DATE).sort();
  let last = null;
  for (let i=dates.length-1; i>=0 && !last; i--){
    const ex = (data.all[dates[i]].exercises||[]).filter(e=>e.id === id)[0];
    if (ex && (ex.sets||[]).length) last = { date: dates[i], ex };
  }
  if (!last){ el.hidden = true; el.innerHTML = ''; return; }   // nothing logged before → nothing to gauge against
  const bwKg = LedgerCore.weightAt(data.W, last.date);
  // Top set = the heaviest effective load; that is the number the next top set aims to beat.
  // Falls back to most reps for a bodyweight lift with no weigh-in to resolve a load.
  let top = null, topLoad = -1, topReps = -1;
  (last.ex.sets||[]).forEach(s=>{
    const load = LedgerCore.setLoad(s, bwKg);
    if (load != null){ if (load > topLoad){ topLoad = load; top = s; } }
    else if (topLoad < 0 && (+s.reps||0) > topReps){ topReps = +s.reps||0; top = s; }
  });
  const mtr = LedgerCore.sessionMetrics(last.ex.sets, { bodyweightKg: bwKg, rir: last.ex.rir });
  const row = data.byId[id], t = row && row.t;
  const verdict = t && t.verdict && t.verdict !== 'thin'
    ? `<span class="verdict v-${t.verdict}">${VERDICT_LABEL[t.verdict]||t.verdict}</span>` : '';
  const trendLine = t && t.verdict !== 'thin' && t.last != null
    ? `<div class="lift-sub">${t.cls==='volume'?'capacity':'e1RM'} ${t.last.toFixed(1)}${t.cls==='volume'?'':' kg'} · ${pctTxt(t.pctPerMonth)}</div>`
    : '';
  const rir = last.ex.rir != null ? ` · ${last.ex.rir} RIR` : '';
  el.hidden = false;
  el.innerHTML = `
    <div class="lift-ex-head">
      <span class="lift-pv-tag">Last time · ${last.date}</span>${verdict}
    </div>
    <div class="lift-pv-top">Top set <b>${top ? SET_TXT(top) : '—'}</b></div>
    <div class="lift-sets">${(last.ex.sets||[]).map(SET_TXT).join('  ·  ')}</div>
    <div class="lift-sub">${mtr.sets} set${mtr.sets===1?'':'s'} · ${Math.round(mtr.volume).toLocaleString()} kg volume`
      + (mtr.bestE1RM ? ` · best e1RM ${mtr.bestE1RM.toFixed(1)} kg` : '') + rir + `</div>
    ${trendLine}`;
}

// ---- logging: parse → confirm → commit ----
let liftPending = null;
document.getElementById('liftBtn').onclick = ()=>{
  const txt = document.getElementById('liftInput').value.trim();
  if (!txt){ liftStatus('Type your sets — one exercise per line, commas between sets.'); return; }
  liftPending = LedgerCore.parseWorkout(txt, exerciseCatalog());
  // Start the rest the moment a set reads cleanly — this is when you've finished lifting,
  // even though the sets aren't committed until "Add to session". Commit restarts it, so
  // whichever button you press, the rest is running.
  if (liftPending.exercises.length) startRestTimer(restSecondsFor(liftPending.exercises));
  renderLiftPending();
};
document.getElementById('liftInput').addEventListener('keydown', e=>{
  if (e.key==='Enter' && (e.ctrlKey||e.metaKey)) document.getElementById('liftBtn').click();
});
// Keep the "last time" preview tracking the line under the cursor as it is typed or moved.
['input','click','keyup'].forEach(ev=>
  document.getElementById('liftInput').addEventListener(ev, renderLiftPreview));
// The non-blocking load-jump guardrail, shown inline at review time. Compares the proposed
// top set against this lift's recent history and, if it is a big weekly jump, says so — it
// informs, it never gates. Returns an HTML string ('' when there is nothing to flag).
function liftJumpNotice(x){
  const all = allWorkouts(), W = weightSeries();
  const bwKg = LedgerCore.weightAt(W, VIEW_DATE);
  const proposed = (x.sets||[]).reduce((m,s)=>{ const l = LedgerCore.setLoad(s, bwKg); return l!=null && l>m ? l : m; }, 0);
  if (!(proposed > 0)) return '';
  const history = Object.keys(all).filter(d=>d!==VIEW_DATE).map(d=>{
    const e = (all[d].exercises||[]).filter(e=>e.id===x.id)[0];
    return e ? { date: d, sets: e.sets, bodyweightKg: LedgerCore.weightAt(W, d) } : null;
  }).filter(Boolean);
  const meta = LedgerCore.exerciseMeta(exerciseCatalog().filter(c=>c.id===x.id)[0] || x);
  const chk = LedgerCore.loadJumpCheck(proposed, history, {
    asOf: VIEW_DATE, bodyweightKg: bwKg, equipment: meta.equipment, pattern: meta.pattern });
  if (chk.severity === 'none') return '';
  return `<div class="lift-jump ${chk.severity}">⚠ ${Math.round(proposed)} kg — ${escapeHtml(chk.message)}</div>`;
}
// Within-exercise rep drop-off at a fixed load — high drop-off usually means rest was too
// short. Only shown for straight sets at one load; a mixed-load exercise says nothing here.
const FATIGUE_LABEL = { ok:'', elevated:'elevated', high:'high' };
function fatigueLine(ex){
  const f = LedgerCore.fatigueIndex(ex.sets, { rir: ex.rir });
  if (!f.applicable || f.flag === 'ok') return '';
  const pct = Math.round(f.rawDropoff * 100);
  const tone = f.flag === 'high' ? 'bad' : 'warn';
  const why = f.flag === 'high' ? ' — typically 10–20%. Often means rest is too short.' : '';
  return `<div class="lift-sub lift-fatigue ${tone}">Rep drop-off ${pct}% (${FATIGUE_LABEL[f.flag]})${why}</div>`;
}
function renderLiftPending(){
  const el = document.getElementById('liftPending'), aiBtn = document.getElementById('liftAiBtn');
  if (!el) return;
  if (!liftPending){ el.innerHTML=''; aiBtn.hidden = true; liftStatus(''); return; }
  const ex = liftPending.exercises, errs = liftPending.errors;
  // The AI is offered only for what the grammar could not read — never as the first resort.
  aiBtn.hidden = !(errs.length && hasAI());
  if (!ex.length){
    el.innerHTML = '';
    liftStatus(errs.length
      ? `Couldn't read: ${errs.map(e=>escapeHtml(e.line)+' <span class="ink-dim">('+e.reason+')</span>').join(' · ')}`
      : 'Nothing to log.', true);
    return;
  }
  liftStatus(errs.length
    ? `${errs.length} line${errs.length>1?'s':''} unread: ${errs.map(e=>escapeHtml(e.line)).join(' · ')}`
    : 'Check the sets below, then add them.');
  el.innerHTML = ex.map((x,i)=>`
    <div class="lift-ex">
      <div class="lift-ex-head">
        <span class="lift-ex-name">${escapeHtml(x.name)}</span>
        ${x.matched ? '' : '<span class="lift-tag">new exercise</span>'}
        ${x.viaAI ? '<span class="lift-tag">read by AI — check it</span>' : ''}
      </div>
      <div class="lift-sets">${x.sets.map(SET_TXT).join('  ·  ')}</div>
      ${liftJumpNotice(x)}
      <div class="lift-rir"><label for="plr${i}" title="How many more reps you had in you on your hardest set. Guess it — only the change over time is ever read, so a consistent personal bias cancels out.">Reps left in the tank on your hardest set</label>
        <input type="number" id="plr${i}" data-pr="${i}" min="0" max="10" step="1"
               value="${x.rir==null?'':x.rir}" placeholder="–"></div>
    </div>`).join('') +
    `<div class="footer-actions" style="grid-template-columns:1fr 1fr;margin-top:6px">
       <button type="button" class="ghost" id="liftCancel">Cancel</button>
       <button type="button" id="liftConfirm">Add to session</button></div>`;
  el.querySelectorAll('input[data-pr]').forEach(inp=>{
    inp.onchange = ()=>{
      const v = inp.value.trim();
      liftPending.exercises[+inp.dataset.pr].rir = v==='' ? null : Math.max(0, Math.min(10, +v||0));
    };
  });
  document.getElementById('liftConfirm').onclick = liftCommit;
  document.getElementById('liftCancel').onclick = ()=>{ liftPending=null; renderLiftPending(); };
}
function liftCommit(){
  if (!liftPending || !liftPending.exercises.length) return;
  const w = workoutFor(VIEW_DATE);
  w.date = VIEW_DATE; w.split = splitForDate(VIEW_DATE);
  let cat = exerciseCatalog(), added = 0;
  liftPending.exercises.forEach(x=>{
    // A lift the catalogue has never seen joins it on first use — that is what keeps
    // every later spelling of it landing on the same trend line.
    if (!cat.some(c=>c.id===x.id)){ cat = cat.concat([{id:x.id, name:x.name, aliases:[]}]); added++; }
    const cur = w.exercises.filter(e=>e.id===x.id)[0];
    if (cur){ cur.sets = (cur.sets||[]).concat(x.sets); if (x.rir!=null) cur.rir = x.rir; }
    else w.exercises.push({id:x.id, name:x.name, sets:x.sets.slice(), rir: x.rir==null?null:x.rir});
  });
  const n = liftPending.exercises.length;
  const restSecs = restSecondsFor(liftPending.exercises);
  if (added) saveCatalog(cat);
  saveWorkout(w);
  liftPending = null;
  document.getElementById('liftInput').value = '';
  haptic(); startRestTimer(restSecs); render();
  toast(`Logged ${n} ${n === 1 ? 'exercise' : 'exercises'}` +
        (added ? ` · ${added} new in the catalogue` : ''));
}
// Fallback only: hand the AI the lines the grammar rejected and nothing else. It returns
// sets, never analysis — every number it emits is shown for confirmation before it lands.
document.getElementById('liftAiBtn').onclick = async ()=>{
  const lines = ((liftPending && liftPending.errors) || []).map(e=>e.line).filter(Boolean);
  if (!lines.length) return;
  const btn = document.getElementById('liftAiBtn');
  btn.disabled = true;
  liftStatus('<span class="spin"></span>Reading those lines…');
  try {
    const prompt =
`You convert gym set logs into structured JSON for a training tracker.
Transcribe only what is written. Never invent an exercise, a weight or a rep count that is not stated, and never total or average anything.
Return JSON: {"exercises":[{"name":<the exercise exactly as the user wrote it>,"rir":<reps in reserve if stated, else null>,"sets":[{"kg":<load in kilograms; 0 for a bodyweight movement with no added load>,"reps":<number>,"bw":<true only for a bodyweight movement such as a pull-up, dip or push-up>}]}]}
Expand shorthand: with a weight stated, "3x12" means three sets of twelve reps. Convert pounds to kilograms. One entry per exercise. Output JSON only, no prose.
Lines:
"""${lines.join('\n')}"""`;
    const txt = await aiComplete(prompt);
    let parsed;
    try { parsed = JSON.parse(txt); } catch(e){ parsed = LedgerCore.repairJson(txt); }
    const list = (parsed && (Array.isArray(parsed) ? parsed : parsed.exercises)) || [];
    const cat = exerciseCatalog();
    const got = list.map(e=>{
      const nm = String((e && e.name) || '').trim();
      const sets = ((e && e.sets) || []).map(s=>({
        kg: Math.max(0, +s.kg||0), reps: Math.round(+s.reps||0), bw: !!s.bw
      })).filter(s => s.reps>0 && (s.bw || s.kg>0));
      if (!nm || !sets.length) return null;
      const m = LedgerCore.matchExercise(nm, cat);
      return { raw: nm, name: m ? m.exercise.name : nm.charAt(0).toUpperCase()+nm.slice(1),
               id: m ? m.exercise.id : LedgerCore.exerciseId(nm), matched: !!m,
               sets: sets.map(s => s.bw ? {kg:s.kg, reps:s.reps, bw:true} : {kg:s.kg, reps:s.reps}),
               rir: (e.rir==null || e.rir==='') ? null : Math.max(0, Math.min(10, +e.rir||0)),
               bw: sets.some(s=>s.bw), viaAI: true };
    }).filter(Boolean);
    if (!got.length) throw new Error('the AI could not read those lines either');
    liftPending = { exercises: liftPending.exercises.concat(got), unresolved: [], errors: [] };
    renderLiftPending();
    liftStatus(`Read by ${escapeHtml(AI_VIA)} — check the numbers before adding.`);
  } catch(err){
    liftStatus('AI read failed: '+escapeHtml(err.message), true);
  } finally { btn.disabled = false; }
};

// ---- rendering ----
// The index of the logged exercise currently being edited in place, or null. Editing lets
// you fix a wrong name or a mis-typed set without deleting the whole exercise and re-logging
// it — the friction of "one bad set means start over" that the delete-only card forced.
let liftEditIdx = null;
// One exercise as a text line the parser round-trips: "Name  60kgx8, 60kgx7". rir is edited
// in its own field, so it is deliberately left off the sets line here.
function exerciseEditLine(ex){ return (ex.sets||[]).map(SET_IN).join(', '); }
function renderLiftSession(all, W){
  const w = all[VIEW_DATE] || workoutFor(VIEW_DATE);
  document.getElementById('liftDate').textContent = VIEW_DATE===ACTIVE_DATE ? 'today' : VIEW_DATE;
  document.getElementById('liftSplit').textContent = ' · ' + splitForDate(VIEW_DATE);
  const el = document.getElementById('liftSession');
  if (!(w.exercises||[]).length){
    el.innerHTML = '<div class="empty">Nothing logged for this day.</div>';
    liftEditIdx = null;
    return;
  }
  if (liftEditIdx != null && liftEditIdx >= w.exercises.length) liftEditIdx = null;
  const bwKg = LedgerCore.weightAt(W, VIEW_DATE);
  el.innerHTML = w.exercises.map((ex,i)=>{
    if (i === liftEditIdx) return renderLiftExEditor(ex, i);
    const m = LedgerCore.sessionMetrics(ex.sets, {bodyweightKg: bwKg, rir: ex.rir});
    const warmN = (ex.sets||[]).filter(s=>s.warmup).length;
    return `<div class="lift-ex">
      <div class="lift-ex-head">
        <span class="lift-ex-name">${escapeHtml(ex.name)}</span>
        <span class="lift-ex-btns">
          <button type="button" class="lift-edit" data-le="${i}" aria-label="Edit ${escapeAttr(ex.name)}" title="Edit">✎</button>
          <button type="button" class="lift-del" data-lx="${i}" aria-label="Remove ${escapeAttr(ex.name)} from this session" title="Remove">✕</button>
        </span>
      </div>
      <div class="lift-sets">${(ex.sets||[]).map((s,si)=>
        `<button type="button" class="set-chip${s.warmup?' warm':''}" data-set="${i}.${si}" title="Tap to toggle warm-up">${SET_TXT(s)}${s.warmup?' <span class="wu">wu</span>':''}</button>`
        ).join(' ')}</div>
      <div class="lift-sub">${m.sets} set${m.sets===1?'':'s'} · ${Math.round(m.volume).toLocaleString()} kg volume`
      + (m.bestE1RM ? ` · best e1RM ${m.bestE1RM.toFixed(1)} kg` : '')
      + (warmN ? ` · ${warmN} warm-up${warmN===1?'':'s'} excluded` : '')
      + (m.incomplete ? ` · <span style="color:var(--brass)">log a weight to score this</span>` : '') + `</div>`
      + fatigueLine(ex) + `
      <div class="lift-rir"><label for="slr${i}" title="How many more reps you had in you on your hardest set. Guess it — only the change over time is ever read, so a consistent personal bias cancels out.">Reps left in the tank on your hardest set</label>
        <input type="number" id="slr${i}" data-lr="${i}" min="0" max="10" step="1"
               value="${ex.rir==null?'':ex.rir}" placeholder="–"></div>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-le]').forEach(s=>{
    s.onclick = ()=>{ liftEditIdx = +s.dataset.le; renderLiftSession(allWorkouts(), weightSeries()); };
  });
  el.querySelectorAll('[data-lx]').forEach(s=>{
    s.onclick = ()=>{
      const i = +s.dataset.lx, cur = workoutFor(VIEW_DATE);
      const ex = cur.exercises[i];
      if (!ex) return;
      if (liftEditIdx === i) liftEditIdx = null;
      cur.exercises.splice(i,1); saveWorkout(cur); render();
      toast(`Removed ${ex.name}`, { undo: ()=>{
        const back = workoutFor(VIEW_DATE);
        back.exercises.splice(i, 0, ex); saveWorkout(back); render();
      } });
    };
  });
  // Tap a set to toggle it as a warm-up — excluded from volume, top set, e1RM and fatigue.
  el.querySelectorAll('[data-set]').forEach(btn=>{
    btn.onclick = ()=>{
      const [i,si] = btn.dataset.set.split('.').map(Number);
      const cur = workoutFor(VIEW_DATE), s = cur.exercises[i] && cur.exercises[i].sets[si];
      if (!s) return;
      if (s.warmup) delete s.warmup; else s.warmup = true;
      saveWorkout(cur); render();
    };
  });
  el.querySelectorAll('input[data-lr]').forEach(inp=>{
    inp.onchange = ()=>{
      const i = +inp.dataset.lr, cur = workoutFor(VIEW_DATE), v = inp.value.trim();
      if (!cur.exercises[i]) return;
      cur.exercises[i].rir = v==='' ? null : Math.max(0, Math.min(10, +v||0));
      saveWorkout(cur); render();
    };
  });
  // Deload marker: a deliberate light day should not read as regression, so it can be excluded
  // from every lift's trend fit while still being kept as the session you actually did.
  const foot = document.createElement('label');
  foot.className = 'lift-deload';
  foot.innerHTML = `<input type="checkbox" id="liftDeload"${w.deload?' checked':''}> `
    + `Deload day <span class="ink-dim">— logged, but excluded from progression trends</span>`;
  el.appendChild(foot);
  const dcb = document.getElementById('liftDeload');
  if (dcb) dcb.onchange = ()=>{
    const cur = workoutFor(VIEW_DATE);
    if (dcb.checked) cur.deload = true; else delete cur.deload;
    saveWorkout(cur); render();
    toast(dcb.checked ? 'Marked as a deload — kept out of trends' : 'Deload flag cleared');
  };
  bindLiftEditor(w);
}
// The inline editor a logged exercise turns into. Name and sets are free text so a rename
// ("Cable Overhead Extensions" → "Triceps Overhead Extensions") re-matches the catalogue and
// keeps the trend line intact; the sets reuse the same grammar as the main logger.
function renderLiftExEditor(ex, i){
  return `<div class="lift-ex lift-ex-editing">
    <div class="lift-ex-head"><span class="lift-ex-name">Editing</span></div>
    <label for="leName${i}" class="lift-edit-lbl">Exercise</label>
    <input type="text" id="leName${i}" class="lift-edit-in" value="${escapeAttr(ex.name)}">
    <label for="leSets${i}" class="lift-edit-lbl">Sets <span class="ink-dim">— e.g. 60kgx8, 60kgx7 · bwx12 · bw+10kgx8</span></label>
    <input type="text" id="leSets${i}" class="lift-edit-in" value="${escapeAttr(exerciseEditLine(ex))}">
    <label for="leRir${i}" class="lift-edit-lbl">Reps left in the tank on your hardest set</label>
    <input type="number" id="leRir${i}" class="lift-edit-in" min="0" max="10" step="1" value="${ex.rir==null?'':ex.rir}" placeholder="–">
    <div class="tactical bad" id="leMsg${i}" hidden></div>
    <div class="footer-actions" style="grid-template-columns:1fr 1fr;margin-top:8px">
      <button type="button" class="ghost" data-lecancel="${i}">Cancel</button>
      <button type="button" data-lesave="${i}">Save</button>
    </div>
  </div>`;
}
function bindLiftEditor(w){
  const el = document.getElementById('liftSession');
  const cancel = el.querySelector('[data-lecancel]');
  if (cancel) cancel.onclick = ()=>{ liftEditIdx = null; renderLiftSession(allWorkouts(), weightSeries()); };
  const save = el.querySelector('[data-lesave]');
  if (!save) return;
  save.onclick = ()=>{
    const i = +save.dataset.lesave;
    const nameV = (document.getElementById('leName'+i).value||'').trim();
    const setsV = (document.getElementById('leSets'+i).value||'').trim();
    const rirRaw = (document.getElementById('leRir'+i).value||'').trim();
    const msg = document.getElementById('leMsg'+i);
    const fail = t => { msg.hidden = false; msg.textContent = t; };
    if (!nameV) return fail('Give the exercise a name.');
    if (!setsV) return fail('Enter at least one set — or use ✕ to remove the exercise.');
    // Reuse the logger's grammar: one line of "name sets" parses to the same shape we store.
    const parsed = LedgerCore.parseWorkout(nameV + ' ' + setsV, exerciseCatalog());
    const p = parsed.exercises[0];
    if (!p || !p.sets.length) return fail('Could not read those sets. Try "60kgx8, 60kgx7".');
    const cur = workoutFor(VIEW_DATE);
    if (!cur.exercises[i]){ liftEditIdx = null; render(); return; }
    const rir = rirRaw==='' ? (p.rir==null ? null : p.rir) : Math.max(0, Math.min(10, +rirRaw||0));
    // A rename onto an exercise the catalogue hasn't seen joins it, same as first-time logging.
    let cat = exerciseCatalog();
    if (!cat.some(c=>c.id===p.id)) saveCatalog(cat.concat([{id:p.id, name:p.name, aliases:[]}]));
    cur.exercises[i] = { id:p.id, name:p.name, sets:p.sets.slice(), rir };
    saveWorkout(cur); liftEditIdx = null; haptic(); render();
    toast(`Updated ${p.name}`);
  };
}
// A dropdown of exercises the user has ACTUALLY LOGGED — never the seed catalogue, which
// buried the handful they use under fifty they don't. This split's exercises come first (so a
// Push day offers push work, not whatever was trained most recently), the rest follow. Keyed
// by id so a name whose spelling drifted collapses to one entry; the latest session wins the
// display name, and most-recently-trained sorts to the top of each group. Choosing one drops
// the canonical name into the logger, ready for the sets.
function renderLiftPicker(all){
  const sel = document.getElementById('liftPick'); if (!sel) return;
  const todaySplit = splitForDate(VIEW_DATE);
  const seen = {};
  Object.keys(all).sort().forEach(d=>{               // ascending so the latest date wins name/last
    const w = all[d], sp = w.split || '';
    (w.exercises||[]).forEach(ex=>{
      if (!ex || !ex.id || !ex.name) return;
      const e = seen[ex.id] || (seen[ex.id] = { name:ex.name, last:d, inSplit:false });
      e.name = ex.name; e.last = d;
      if (sp === todaySplit) e.inSplit = true;         // has appeared on a day of this split
    });
  });
  const ids = Object.keys(seen);
  if (!ids.length){ sel.hidden = true; sel.innerHTML = ''; return; }   // nothing logged yet → no picker
  const recent = (a,b)=> seen[a].last < seen[b].last ? 1 : seen[a].last > seen[b].last ? -1 : 0;
  const mkOpts = list => list.map(id=>`<option value="${escapeAttr(seen[id].name)}">${escapeHtml(seen[id].name)}</option>`).join('');
  const todays = ids.filter(id=>seen[id].inSplit).sort(recent);
  const others = ids.filter(id=>!seen[id].inSplit).sort(recent);
  sel.hidden = false;
  let html = '<option value="">＋ Insert an exercise name…</option>';
  if (todays.length) html += `<optgroup label="${escapeHtml(todaySplit)} · your exercises">` + mkOpts(todays) + '</optgroup>';
  if (others.length) html += '<optgroup label="Other logged exercises">' + mkOpts(others) + '</optgroup>';
  sel.innerHTML = html;
  sel.onchange = ()=>{
    const name = sel.value; sel.value = '';
    if (!name) return;
    const inp = document.getElementById('liftInput');
    const base = (inp.value||'').replace(/\s+$/,'');
    inp.value = (base ? base + '\n' : '') + name + ' ';   // each pick on its own line, ready for sets
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    renderLiftPreview();   // programmatic value change fires no input event
  };
}
function renderLiftChips(all){
  const el = document.getElementById('liftChips'); if (!el) return;
  const sp = splitForDate(VIEW_DATE);
  const past = Object.keys(all).filter(x => x !== VIEW_DATE && (all[x].exercises||[]).length).sort();
  // Only the last session of TODAY'S split — repeating a different split (offering "Repeat
  // Pull" on a push day) is never what you want, so with no same-split history the chip stays
  // hidden rather than suggesting the wrong day's work.
  const d = past.filter(x => (all[x].split||'') === sp).pop();
  if (!d){ el.hidden = true; el.innerHTML=''; return; }
  el.hidden = false;
  el.innerHTML = `<span class="chip" id="liftRepeat">↻ Repeat ${escapeHtml(all[d].split || sp)} <small>${d}</small></span>`;
  document.getElementById('liftRepeat').onclick = ()=>{
    // Pre-fill last time's loads so logging is mostly confirming numbers, not typing them.
    document.getElementById('liftInput').value = (all[d].exercises||[]).map(ex=>
      `${ex.name} ${(ex.sets||[]).map(SET_IN).join(', ')}` + (ex.rir!=null ? ` rir ${ex.rir}` : '')
    ).join('\n');
    document.getElementById('liftInput').focus();
    renderLiftPreview();   // programmatic value change fires no input event
  };
}
const VERDICT_LABEL = { progressing:'progressing', stalled:'stalled', grinding:'grinding',
                        'effort-drift':'effort drift', regressing:'regressing', thin:'building data' };
const CONF_LABEL = { high:'high confidence', medium:'medium confidence', low:'low confidence · provisional' };
const CONF_CLS   = { high:'high', medium:'med', low:'low' };
function pctTxt(p){ return (p>0?'+':'') + p.toFixed(1) + '%/month'; }
function renderLiftTrends(rows){
  const wrap = document.getElementById('liftTrends'); if (!wrap) return;
  if (!rows.length){ wrap.innerHTML = '<div class="empty">Log a few sessions and the trends appear here.</div>'; return; }
  // Most recently trained first; strength lifts win a tie, since they carry the verdict.
  rows = rows.slice().sort((a,b)=>
    (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0) ||
    (a.t.cls === b.t.cls ? 0 : a.t.cls === 'strength' ? -1 : 1));
  wrap.innerHTML = rows.map(r=>{
    const t = r.t;
    // Which metric this lift is judged on, and why. e1RM is only meaningful at low effective
    // reps; past the cap the app tracks work capacity instead — a genuine strength-endurance
    // signal, not a lesser one, so it gets the same trend, margin and confidence treatment.
    const capNote = t.setsTotal && t.setsCapped
      ? ` · ${t.setsCapped} of ${t.setsTotal} sets past ${LedgerCore.LIFT_REP_CAP} effective reps`
      : '';
    const metricNote = t.cls === 'volume'
      ? `strength-endurance — judged on work capacity (load × effective reps), since the reps run past the e1RM cap${capNote}`
      : `judged on e1RM${capNote}`;
    let main, meta = '', sub = '';
    if (t.verdict === 'thin'){
      const need = Math.max(1, t.sessionsNeeded);
      main = `${t.sessions} session${t.sessions===1?'':'s'} logged · ${need} more before the first read`;
      sub = metricNote;
    } else {
      const label = t.cls === 'volume' ? 'capacity' : 'e1RM';
      const unit = t.cls === 'volume' ? '' : ' kg';
      const moe = t.pctSE != null ? ` <span class="ink-dim">±${t.pctSE.toFixed(1)}</span>` : '';
      main = `${label} ${t.last.toFixed(1)}${unit} · ${pctTxt(t.pctPerMonth)}${moe}`;
      // The margin of error and the earned confidence tier, always in view, right under the
      // headline number — so a three-session read reads as the provisional thing it is.
      meta = `${t.n} sessions over ${t.spanDays} days · `
        + `<span class="lift-conf ${CONF_CLS[t.confidence]||''}">${CONF_LABEL[t.confidence]||t.confidence}</span>`;
      if (t.verdict === 'grinding')
        sub = t.volPctPerMonth > 0
          ? `Volume is up ${pctTxt(t.volPctPerMonth)} for the same top set — more work, same output.`
          : `Effort is climbing for the same top set — more work, same output.`;
      if (t.verdict === 'effort-drift')
        sub = `You are stopping ${Math.abs(t.rirPerMonth).toFixed(1)} reps further from failure than a month ago — the flat trend may be the reporting, not your strength.`;
      if (t.verdict === 'stalled')
        sub = `Output, volume and effort all flat. This is the real thing.`;
      // Honest hedge: when the move is smaller than its own error bar, or the read is still
      // provisional, say the direction isn't settled — it firms up as more sessions land.
      if ((t.verdict === 'progressing' || t.verdict === 'regressing') && t.separable === false)
        sub = (sub ? sub + ' ' : '') + `The change is within its ±${(t.pctSE||0).toFixed(1)} margin, so the direction isn't certain yet — it firms up with more sessions.`;
      else if (t.confidence === 'low')
        sub = (sub ? sub + ' ' : '') + `An early read from ${t.n} sessions; it sharpens as you log more.`;
      // Half your sets past the cap means the strength line is fit on the other half — worth
      // knowing before trusting a slope drawn through it.
      if (t.setsTotal && t.setsCapped / t.setsTotal >= 0.5)
        sub = (sub ? sub + ' ' : '') + metricNote.charAt(0).toUpperCase() + metricNote.slice(1) + '.';
    }
    const lm = t.latest;
    const lastLine = lm && lm.sets
      ? `last: ${Math.round(lm.topLoad)} kg top set · ${lm.sets} set${lm.sets===1?'':'s'} · ${Math.round(lm.volume).toLocaleString()} kg`
      : '';
    return `<div class="lift-ex">
      <div class="lift-ex-head">
        <span class="lift-ex-name">${escapeHtml(t.name)}</span>
        <span class="verdict v-${t.verdict}">${VERDICT_LABEL[t.verdict]||t.verdict}</span>
      </div>
      <div class="lift-sub">${main}</div>
      ${meta ? `<div class="lift-sub">${meta}</div>` : ''}
      ${lastLine ? `<div class="lift-sub">${lastLine}</div>` : ''}
      ${sub ? `<div class="lift-sub" style="color:var(--graphite)">${sub}</div>` : ''}
    </div>`;
  }).join('');
}
// Options for the catalogue's muscle/pattern tagging. A single primary muscle is enough to
// pull a lift into the per-muscle volume view; compounds credit their assistors from the seed.
const MUSCLE_OPTS = ['', 'chest','frontDelts','sideDelts','rearDelts','triceps','biceps','forearms',
  'lats','upperBack','traps','lowerBack','quads','hamstrings','glutes','calves','abs'];
function renderLiftCatalog(){
  const el = document.getElementById('liftCatalog'); if (!el) return;
  const cat = exerciseCatalog().slice().sort((a,b)=> a.name<b.name?-1:1);
  const muscleSel = (c, meta)=>{
    const cur = meta.muscles ? Object.keys(meta.muscles).sort((a,b)=>meta.muscles[b]-meta.muscles[a])[0] : '';
    const tagged = meta.tagged ? '' : ' untagged';
    return `<select class="cat-tag${tagged}" data-mus="${escapeAttr(c.id)}">`
      + MUSCLE_OPTS.map(m=>`<option value="${m}"${m===cur?' selected':''}>${m?escapeHtml(LedgerCore.MUSCLE_LABEL[m]||m):(meta.tagged?'(seed)':'— untagged —')}</option>`).join('')
      + `</select>`;
  };
  const patSel = (c, meta)=>`<select class="cat-tag" data-pat="${escapeAttr(c.id)}">`
      + ['','compound','isolation'].map(v=>`<option value="${v}"${v===(meta.pattern||'')?' selected':''}>${v||'—'}</option>`).join('') + `</select>`;
  el.innerHTML = `<table><thead><tr><th>Exercise</th><th>Muscle</th><th>Type</th><th></th></tr></thead><tbody>`
    + cat.map(c=>{
      const meta = LedgerCore.exerciseMeta(c);
      return `<tr><td>${escapeHtml(c.name)}`
        + ((c.aliases||[]).length?`<br><span class="ink-dim" style="font-size:10px">${escapeHtml(c.aliases.join(', '))}</span>`:'')
        + `</td><td>${muscleSel(c, meta)}</td><td>${patSel(c, meta)}</td>`
        + `<td><button type="button" class="lift-del" data-cd="${escapeAttr(c.id)}" aria-label="Remove ${escapeAttr(c.name)} from the catalogue" title="Remove">✕</button></td></tr>`;
    }).join('')
    + `</tbody></table>`;
  // Tagging writes a primary-muscle override (weight 1.0) onto the catalogue record. The seed
  // still supplies assistors for known compounds; an explicit tag wins where it is set.
  const patch = (id, fn)=>{
    const list = exerciseCatalog().slice();
    const i = list.findIndex(c=>c.id===id); if (i<0) return;
    list[i] = Object.assign({}, list[i]); fn(list[i]);
    saveCatalog(list); render();
  };
  el.querySelectorAll('[data-mus]').forEach(sel=>{
    sel.onchange = ()=> patch(sel.dataset.mus, c=>{
      if (sel.value) c.muscles = [{group: sel.value, weight: 1}]; else delete c.muscles;
    });
  });
  el.querySelectorAll('[data-pat]').forEach(sel=>{
    sel.onchange = ()=> patch(sel.dataset.pat, c=>{ if (sel.value) c.pattern = sel.value; else delete c.pattern; });
  });
  el.querySelectorAll('[data-cd]').forEach(s=>{
    s.onclick = ()=>{
      const before = exerciseCatalog();
      const gone = before.filter(c=>c.id === s.dataset.cd)[0];
      saveCatalog(before.filter(c=>c.id !== s.dataset.cd));
      renderLiftCatalog();
      toast(`Removed ${gone ? gone.name : 'exercise'} — logged sessions keep their data`,
        { tone:'warn', undo: ()=>{ saveCatalog(before); renderLiftCatalog(); } });
    };
  });
}
function renderLiftHistory(all, W){
  const el = document.getElementById('liftHistory'); if (!el) return;
  const dates = Object.keys(all).filter(d=>(all[d].exercises||[]).length).sort().reverse().slice(0,30);
  if (!dates.length){ el.innerHTML = '<div class="empty">No sessions logged yet.</div>'; return; }
  el.innerHTML = dates.map(d=>{
    const w = all[d], bwKg = LedgerCore.weightAt(W, d);
    const vol = (w.exercises||[]).reduce((s,ex)=>
      s + LedgerCore.sessionMetrics(ex.sets, {bodyweightKg:bwKg, rir:ex.rir}).volume, 0);
    // Each exercise on its own line with the actual sets — kg × reps, same format as the live
    // session — so a past day reads back what you did, not just how many sets you did.
    const lines = (w.exercises||[]).map(ex=>{
      const sets = (ex.sets||[]).map(SET_TXT).join('  ·  ') || '—';
      const rir = ex.rir!=null ? ` <span class="ink-dim">· ${ex.rir} RIR</span>` : '';
      return `<div class="lift-sub"><span class="lift-hist-name">${escapeHtml(ex.name)}</span> `
           + `<span class="ink-dim">${sets}</span>${rir}</div>`;
    }).join('');
    return `<div class="lift-ex"><div class="lift-ex-head">
        <span class="lift-ex-name">${d}${w.split?` · ${escapeHtml(w.split)}`:''}</span>
        <span class="ink-dim" style="font-size:11px">${Math.round(vol).toLocaleString()} kg</span></div>
      ${lines}</div>`;
  }).join('');
}
// The reading no lifting app can produce, because it does not know what you ate.
const RECOMP_COPY = {
  building:  ['good', 'Building',
    w=>`Bodyweight up <b>${w.kg} kg/week</b> and strength up <b>${w.s}</b> across ${w.n} tracked lift${w.n===1?'':'s'}. The surplus is buying strength — leave it alone.`],
  spinning:  ['warn', 'Spinning',
    w=>`Bodyweight up <b>${w.kg} kg/week</b> but strength flat at <b>${w.s}</b> across ${w.n} lift${w.n===1?'':'s'}. A surplus that is not buying strength is buying fat — trim the offset, or fix the training before adding more calories.`],
  retaining: ['good', 'Retaining',
    w=>`Down <b>${w.kg} kg/week</b> with strength held at <b>${w.s}</b>. That is a cut working as intended.`],
  shedding:  ['bad', 'Shedding',
    w=>`Down <b>${w.kg} kg/week</b> and losing strength with it (<b>${w.s}</b>). Too steep, or protein is short — ease the deficit.`],
  recomping: ['good', 'Recomping',
    w=>`Bodyweight steady while strength climbs <b>${w.s}</b> across ${w.n} lift${w.n===1?'':'s'}.`],
  holding:   ['', 'Holding',
    w=>`Bodyweight steady and strength steady at <b>${w.s}</b>. Nothing is moving in either direction.`]
};
function renderRecomp(rows, W){
  const el = document.getElementById('recompCard'); if (!el) return;
  // Weight over the last six weeks — the same horizon the lift trends use, so the two
  // halves of the comparison are talking about the same stretch of time.
  const last = W.length ? W[W.length-1].date : null;
  const recent = last ? W.filter(e => (Date.parse(last)-Date.parse(e.date))/86400000 <= 42) : [];
  const wt = LedgerCore.weightTrend(recent.length>=2 ? recent : W);
  // The waist is the third axis: weight and strength alone can't separate a lean gain from
  // a fat gain. Only Logs supplies it, so it may be absent — liftVsWeight ignores a null.
  const waistTr = (typeof waistTrendRecent === 'function') ? waistTrendRecent() : null;
  const r = LedgerCore.liftVsWeight(rows.map(x=>x.t), wt, waistTr);
  if (r.status === 'thin'){
    const need = [];
    if (!wt) need.push('two weigh-ins on different days');
    if (!r.n) need.push(`a strength lift with ${LedgerCore.LIFT_MIN_SESSIONS}+ sessions`);
    el.innerHTML = `<div class="empty">Needs ${need.join(' and ') || 'more history'} before this can be answered.</div>`;
    return;
  }
  const [tone, head, body] = RECOMP_COPY[r.status];
  const w = { kg: Math.abs(r.kgPerWeek).toFixed(2), s: pctTxt(r.strengthPctPerMonth), n: r.n };
  const counts = [];
  if (r.progressing) counts.push(`${r.progressing} progressing`);
  if (r.stalled) counts.push(`${r.stalled} stalled`);
  if (r.regressing) counts.push(`${r.regressing} regressing`);
  el.innerHTML = `<div class="recomp ${tone}">
    <div class="recomp-head">${head}</div>
    <div class="recomp-body">${body(w)}${counts.length?` <span class="ink-dim">(${counts.join(' · ')})</span>`:''}</div>
    ${waistLine(r)}
  </div>`;
}
// The waist reading, when Logs has one. Names what the weight change is actually made of —
// the confirmation (or the contradiction) the scale and the barbell can't give on their own.
const LEAN_COPY = {
  'fat-gain':    ['bad',  cm=>`Waist widening <b>${cm} cm/week</b> — the gain is running to fat. Trim the surplus.`],
  'lean-gain':   ['good', cm=>`Waist steady while you gain — the weight is going to muscle, not the belly. Textbook lean bulk.`],
  'lean-hold':   ['warn', cm=>`Waist steady but strength flat — you're adding size without much fat, yet not much muscle either. Push the training.`],
  'fat-loss':    ['good', cm=>`Waist shrinking <b>${cm} cm/week</b> — the loss is coming off as fat, which is exactly right.`],
  'muscle-risk': ['warn', cm=>`Losing weight but the waist isn't moving — that can mean muscle, not fat, is going. Hold protein high and don't over-cut.`],
  'recomp':      ['good', cm=>`Weight steady but the waist is shrinking <b>${cm} cm/week</b> — fat off, size on. A recomposition in progress.`],
  'skinny-fat':  ['warn', cm=>`Weight steady but the waist is growing — fat replacing what should be muscle. Lift heavier, keep protein up.`],
  'stable':      ['',     cm=>`Waist holding steady — body composition isn't drifting either way.`]
};
function waistLine(r){
  if (!r.leanVerdict || !LEAN_COPY[r.leanVerdict]) return '';
  const [tone, txt] = LEAN_COPY[r.leanVerdict];
  const cm = Math.abs(r.waistCmPerWeek).toFixed(2);
  return `<div class="recomp-waist ${tone}"><span class="rw-tag">Waist axis</span> ${txt(cm)}</div>`;
}
function renderLift(){
  if (!document.getElementById('liftSession')) return;
  const all = allWorkouts(), W = weightSeries();
  const rows = liftTrends(all, W);
  setLiftPreviewData(all, W, rows);
  renderLiftChips(all); renderLiftPicker(all); renderLiftSession(all, W); renderLiftPending();
  renderLiftPreview();
  renderLiftTrends(rows); renderLiftCatalog(); renderLiftHistory(all, W);
}
// The recomp card lives on Trends but is computed from lift data, so Trends
// asks for it directly rather than depending on the Lift tab having rendered.
function renderRecompFromLifts(){
  const W = weightSeries();
  renderRecomp(liftTrends(allWorkouts(), W), W);
}
