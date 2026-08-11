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
  const byId = {}, names = {}, lastDate = {};
  Object.keys(all).sort().forEach(d=>{
    (all[d].exercises||[]).forEach(ex=>{
      if (!ex || !ex.id) return;
      names[ex.id] = ex.name || ex.id; lastDate[ex.id] = d;
      (byId[ex.id] = byId[ex.id] || []).push({date:d, sets:ex.sets||[], rir:ex.rir});
    });
  });
  return Object.keys(byId).map(id=>({
    id, lastDate: lastDate[id],
    t: LedgerCore.exerciseTrend(byId[id], {name:names[id], weights:W})
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

// ---- logging: parse → confirm → commit ----
let liftPending = null;
document.getElementById('liftBtn').onclick = ()=>{
  const txt = document.getElementById('liftInput').value.trim();
  if (!txt){ liftStatus('Type your sets — one exercise per line, commas between sets.'); return; }
  liftPending = LedgerCore.parseWorkout(txt, exerciseCatalog());
  renderLiftPending();
};
document.getElementById('liftInput').addEventListener('keydown', e=>{
  if (e.key==='Enter' && (e.ctrlKey||e.metaKey)) document.getElementById('liftBtn').click();
});
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
  if (added) saveCatalog(cat);
  saveWorkout(w);
  liftPending = null;
  document.getElementById('liftInput').value = '';
  haptic(); render();
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
    return `<div class="lift-ex">
      <div class="lift-ex-head">
        <span class="lift-ex-name">${escapeHtml(ex.name)}</span>
        <span class="lift-ex-btns">
          <button type="button" class="lift-edit" data-le="${i}" aria-label="Edit ${escapeAttr(ex.name)}" title="Edit">✎</button>
          <button type="button" class="lift-del" data-lx="${i}" aria-label="Remove ${escapeAttr(ex.name)} from this session" title="Remove">✕</button>
        </span>
      </div>
      <div class="lift-sets">${(ex.sets||[]).map(SET_TXT).join('  ·  ')}</div>
      <div class="lift-sub">${m.sets} set${m.sets===1?'':'s'} · ${Math.round(m.volume).toLocaleString()} kg volume`
      + (m.bestE1RM ? ` · best e1RM ${m.bestE1RM.toFixed(1)} kg` : '')
      + (m.incomplete ? ` · <span style="color:var(--brass)">log a weight to score this</span>` : '') + `</div>
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
  el.querySelectorAll('input[data-lr]').forEach(inp=>{
    inp.onchange = ()=>{
      const i = +inp.dataset.lr, cur = workoutFor(VIEW_DATE), v = inp.value.trim();
      if (!cur.exercises[i]) return;
      cur.exercises[i].rir = v==='' ? null : Math.max(0, Math.min(10, +v||0));
      saveWorkout(cur); render();
    };
  });
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
  };
}
const VERDICT_LABEL = { progressing:'progressing', stalled:'stalled', grinding:'grinding',
                        'effort-drift':'effort drift', regressing:'regressing', thin:'building data' };
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
    // Which metric this lift is judged on, and why. e1RM is only meaningful at low
    // effective reps; above the cap the app measures capacity instead. That switch used
    // to happen silently, so a set of 18 looked like it counted toward strength when it
    // could not contribute to the number at all.
    const capNote = t.setsTotal && t.setsCapped
      ? ` · ${t.setsCapped} of ${t.setsTotal} sets past ${LedgerCore.LIFT_REP_CAP} effective reps`
      : '';
    const metricNote = t.cls === 'volume'
      ? `judged on capacity (load × reps), not e1RM${capNote}`
      : `judged on e1RM${capNote}`;
    let main, sub = '';
    if (t.verdict === 'thin'){
      main = `${t.sessions} session${t.sessions===1?'':'s'} logged · ${t.sessionsNeeded} more before a trend means anything`;
      sub = metricNote;
    } else {
      main = `${t.metric === 'e1RM' ? 'e1RM' : 'capacity'} ${t.last.toFixed(1)}`
           + `${t.metric === 'e1RM' ? ' kg' : ''} · ${pctTxt(t.pctPerMonth)} · ${t.n} sessions over ${t.spanDays} days`;
      if (t.verdict === 'grinding')
        sub = t.volPctPerMonth > 0
          ? `Volume is up ${pctTxt(t.volPctPerMonth)} for the same top set — more work, same output.`
          : `Effort is climbing for the same top set — more work, same output.`;
      if (t.verdict === 'effort-drift')
        sub = `You are stopping ${Math.abs(t.rirPerMonth).toFixed(1)} reps further from failure than a month ago — the flat trend may be the reporting, not your strength.`;
      if (t.verdict === 'stalled')
        sub = `Output, volume and effort all flat. This is the real thing.`;
      // Half your sets sitting past the cap means the strength line is fit on the other
      // half — worth knowing before trusting a slope drawn through it.
      if (t.setsTotal && t.setsCapped / t.setsTotal >= 0.5)
        sub = (sub ? sub + ' ' : '') + metricNote.charAt(0).toUpperCase() + metricNote.slice(1) + '.';
    }
    const lm = t.latest;
    const lastLine = lm && lm.sets
      ? `last: ${Math.round(lm.topLoad)} kg top set · ${lm.sets} set${lm.sets===1?'':'s'} · ${Math.round(lm.volume).toLocaleString()} kg`
      : '';
    return `<div class="lift-ex${t.cls==='volume'?' low-signal':''}">
      <div class="lift-ex-head">
        <span class="lift-ex-name">${escapeHtml(t.name)}</span>
        <span class="verdict v-${t.verdict}">${VERDICT_LABEL[t.verdict]||t.verdict}</span>
      </div>
      <div class="lift-sub">${main}</div>
      ${lastLine ? `<div class="lift-sub">${lastLine}</div>` : ''}
      ${sub ? `<div class="lift-sub" style="color:var(--graphite)">${sub}</div>` : ''}
    </div>`;
  }).join('');
}
function renderLiftCatalog(){
  const el = document.getElementById('liftCatalog'); if (!el) return;
  const cat = exerciseCatalog().slice().sort((a,b)=> a.name<b.name?-1:1);
  el.innerHTML = `<table><thead><tr><th>Exercise</th><th>Also written as</th><th></th></tr></thead><tbody>`
    + cat.map(c=>`<tr><td>${escapeHtml(c.name)}</td>`
      + `<td class="ink-dim" style="font-size:11px">${escapeHtml((c.aliases||[]).join(', ')) || '—'}</td>`
      + `<td><button type="button" class="lift-del" data-cd="${escapeAttr(c.id)}" aria-label="Remove ${escapeAttr(c.name)} from the catalogue" title="Remove">✕</button></td></tr>`).join('')
    + `</tbody></table>`;
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
    return `<div class="lift-ex"><div class="lift-ex-head">
        <span class="lift-ex-name">${d}${w.split?` · ${escapeHtml(w.split)}`:''}</span>
        <span class="ink-dim" style="font-size:11px">${Math.round(vol).toLocaleString()} kg</span></div>
      <div class="lift-sub">${(w.exercises||[]).map(ex=>
        escapeHtml(ex.name)+' <span class="ink-dim">'+(ex.sets||[]).length+'×</span>').join(' · ')}</div></div>`;
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
  const r = LedgerCore.liftVsWeight(rows.map(x=>x.t), wt);
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
  </div>`;
}
function renderLift(){
  if (!document.getElementById('liftSession')) return;
  const all = allWorkouts(), W = weightSeries();
  const rows = liftTrends(all, W);
  renderLiftChips(all); renderLiftPicker(all); renderLiftSession(all, W); renderLiftPending();
  renderLiftTrends(rows); renderLiftCatalog(); renderLiftHistory(all, W);
}
// The recomp card lives on Trends but is computed from lift data, so Trends
// asks for it directly rather than depending on the Lift tab having rendered.
function renderRecompFromLifts(){
  const W = weightSeries();
  renderRecomp(liftTrends(allWorkouts(), W), W);
}
