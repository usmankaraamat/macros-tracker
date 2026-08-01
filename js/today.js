// today.js -- The Today view: the corridor instrument, pace steering, macro
// rows, micronutrients, the entry ledger, and one-tap repeats.

// ---- corridor state --------------------------------------------------------
// Four states, and only two of them carry colour. Being inside the corridor is
// rendered in plain chalk: an instrument does not light up when it is fine.
function corridorState(kcal){
  if (kcal < 1)     return { key:'empty',  label:'no entries' };
  if (kcal < FLOOR) return { key:'under',  label:'below floor' };
  if (kcal <= CEIL) return { key:'inside', label:'in corridor' };
  return              { key:'breach', label:'ceiling breach' };
}

// When a goal is active and the adaptive TDEE is available, the effective corridor
// (FLOOR/CEIL) is derived from it each render; the manual base (FLOOR_M/CEIL_M) is left
// untouched. CORRIDOR_AUTO tells the rest of render() how to label the corridor.
let CORRIDOR_AUTO = null;
function applyAdaptiveCorridor(){
  CORRIDOR_AUTO = null;
  if (GOAL.mode !== 'off'){
    const td = computeTDEE();
    if (td.blended > 0){
      const off = effectiveOffset();
      const c = LedgerCore.corridorFromTDEE(td.blended, off, GOAL.band||100);
      FLOOR = c.floor; CEIL = c.ceil;
      CORRIDOR_AUTO = { tdee: td.blended, center: c.center, off,
        cycled: TRAIN.cycle, training: isTrainingDay(ACTIVE_DATE), split: splitForDate(ACTIVE_DATE) };
      return;
    }
  }
  FLOOR = FLOOR_M; CEIL = CEIL_M;   // manual corridor (goal off, or no TDEE yet)
}

// ---- the instrument (signature element) ------------------------------------
// Scale runs 0 .. CEIL*1.15 so a breach is always visible on the face.
function scaleMaxKcal(){ return CEIL * 1.15; }
function scalePct(x){ return Math.min(100, Math.max(0, x / scaleMaxKcal() * 100)); }

// The calibration layer: a tick every 100 kcal, a taller one every 500. Redrawn
// only when the corridor itself moves, not on every log.
let _calibKey = '';
function renderCalibration(){
  const svg = document.getElementById('scaleTicks');
  if (!svg) return;
  const max = scaleMaxKcal();
  const key = `${Math.round(max)}|${FLOOR}|${CEIL}`;
  if (key === _calibKey) return;
  _calibKey = key;

  const minor = [], major = [];
  for (let k = 0; k <= max; k += 100){
    const x = (k / max) * 100;
    (k % 500 === 0 ? major : minor).push(
      `<line x1="${x}" x2="${x}" y1="${k % 500 === 0 ? 12 : 16}" y2="22"/>`);
  }
  svg.innerHTML =
    `<g stroke="var(--rule)" stroke-width="1" vector-effect="non-scaling-stroke">${minor.join('')}</g>` +
    `<g stroke="var(--rule-lit)" stroke-width="1" vector-effect="non-scaling-stroke">${major.join('')}</g>`;

  // Floor and ceiling are cut through the track as notches, so you can see
  // exactly where you crossed even once the fill has run past them.
  document.getElementById('floorNotch').style.left = scalePct(FLOOR) + '%';
  document.getElementById('ceilNotch').style.left  = scalePct(CEIL) + '%';

  const legend = document.getElementById('scaleLegend');
  legend.innerHTML =
    `<span class="edge">0</span>` +
    `<span class="bound" style="left:${scalePct(FLOOR)}%">${Math.round(FLOOR)}</span>` +
    `<span class="bound" style="left:${scalePct(CEIL)}%">${Math.round(CEIL)}</span>`;
}

let _lastCorridorKey = '';
function renderInstrument(t){
  renderCalibration();
  const st = corridorState(t.kcal);
  const inst = document.getElementById('instrument');

  const fill = document.getElementById('scaleFill');
  fill.style.width = scalePct(t.kcal) + '%';
  fill.className = 'scale-fill is-' + st.key;
  document.getElementById('needle').style.left = scalePct(t.kcal) + '%';

  const readout = document.getElementById('readout');
  readout.innerHTML = Math.round(t.kcal).toLocaleString() +
    '<span class="readout-unit">KCAL</span>';
  readout.className = 'readout is-' + st.key;

  const stamp = document.getElementById('verdictStamp');
  stamp.textContent = st.label;
  stamp.className = 'verdict-stamp is-' + st.key;

  // Sub-line: distance to the floor, then to the ceiling once the floor is met.
  let sub;
  if (t.kcal < FLOOR)      sub = `${Math.round(FLOOR - t.kcal).toLocaleString()} to floor`;
  else if (t.kcal <= CEIL) sub = `${Math.round(CEIL - t.kcal).toLocaleString()} to ceiling`;
  else                     sub = `${Math.round(t.kcal - CEIL).toLocaleString()} over ceiling`;
  // Say when the goal is driving the numbers rather than the manual corridor.
  if (CORRIDOR_AUTO){
    const dayTxt = CORRIDOR_AUTO.cycled
      ? ` · ${CORRIDOR_AUTO.training ? CORRIDOR_AUTO.split + ' day' : 'rest day'} ${CORRIDOR_AUTO.off >= 0 ? '+' : ''}${CORRIDOR_AUTO.off}`
      : '';
    sub += `  ·  auto ${GOAL_LABEL[GOAL.mode]}${dayTxt}, TDEE ${CORRIDOR_AUTO.tdee.toLocaleString()}`;
  }
  document.getElementById('readoutSub').textContent = sub;

  // The instrument is a meter to assistive tech, with the whole reading spoken.
  const scale = document.getElementById('scale');
  scale.setAttribute('aria-valuemin', '0');
  scale.setAttribute('aria-valuemax', String(Math.round(scaleMaxKcal())));
  scale.setAttribute('aria-valuenow', String(Math.round(t.kcal)));
  scale.setAttribute('aria-valuetext',
    `${Math.round(t.kcal)} kcal, ${st.label}. Floor ${Math.round(FLOOR)}, ceiling ${Math.round(CEIL)}. ${sub}.`);

  // The one orchestrated moment in the app: crossing into breach flashes the
  // fascia once. Crossing back, or re-rendering while already over, does not.
  const key = st.key + '|' + VIEW_DATE;
  if (st.key === 'breach' && _lastCorridorKey && _lastCorridorKey !== key && !prefersReducedMotion()){
    inst.classList.remove('breached');
    void inst.offsetWidth;                     // restart the animation
    inst.classList.add('breached');
    haptic(40);
  }
  _lastCorridorKey = key;

  renderPace(t);
}

// Pace marker + protein-aware steering — only meaningful on the live, open day. The marker
// slides from 0 → the corridor centre across the eating day (06:00–24:00 PST), so a full
// ceiling early doesn't read as "loads of room". Steering fires when the calories left to
// the ceiling can no longer comfortably cover the protein still owed — the exact squeeze
// the user hits at night.
function renderPace(t){
  const mark = document.getElementById('paceMark'), line = document.getElementById('paceLine');
  const live = VIEW_DATE === ACTIVE_DATE;
  if (!live || CEIL <= 0){ mark.hidden = true; line.hidden = true; return; }

  const nowPst = new Date(Date.now() + TZ_OFFSET_MIN*60000);
  const h = nowPst.getUTCHours() + nowPst.getUTCMinutes()/60;
  const center = (FLOOR + CEIL)/2;
  // Bracketed pace from the meal plan (flat between meals, ramps around each), scaled so the
  // plan total maps to the corridor centre. Falls back to a plain linear ramp with no plan.
  const meals = mealPlanHours();
  const planTotal = meals.reduce((s,m)=>s+m.kcal, 0);
  let paceKcal, nextMeal=null, expectedP=null;
  if (meals.length && planTotal>0){
    const scale = center/planTotal;
    paceKcal = scale * LedgerCore.mealPaceKcal(h, meals);
    // Protein is distributed across meals in proportion to their calories — spreading it
    // supports muscle protein synthesis better than one big hit. Expected-by-now tracks it.
    expectedP = P_TARGET * LedgerCore.mealPaceKcal(h, meals) / planTotal;
    const nm = meals.find(m => h < m.h + 0.5);        // first meal not yet fully counted
    if (nm) nextMeal = { name:nm.name, t:nm.t, kcal:Math.round(scale*nm.kcal), p:Math.round(P_TARGET*nm.kcal/planTotal) };
  } else {
    paceKcal = center * Math.max(0, Math.min(1, (h - 6)/(24 - 6)));
  }
  mark.style.left = scalePct(paceKcal) + '%'; mark.hidden = false;

  // Protein steering, anchored to the FLOOR: the aim is to cover protein by the time you
  // reach the floor, keeping floor→ceiling purely as catch-up buffer. A 20% cushion makes
  // the nudge pre-emptive — it fires while you can still act, not once you're already stuck.
  const remP = Math.max(0, P_TARGET - t.p);
  const roomToFloor = FLOOR - t.kcal;
  const roomToCeil  = CEIL - t.kcal;
  const LEAN = 5;                                  // ~5 kcal per g protein from lean sources
  const needKcal = remP * LEAN;                    // lean kcal to close the protein gap
  const needBuf  = needKcal * 1.2;                 // + 20% pre-emptive buffer

  const show = (cls, html)=>{ line.className='pace-line '+cls; line.innerHTML=html; line.hidden = false; };
  if (remP > 5){                                   // ignore a trivial (<5g) protein tail
    if (roomToCeil <= 0)
      return show('bad', `Over the ceiling with <b>${remP.toFixed(0)}g protein</b> still short — take the lean protein and accept the small overshoot.`);
    if (needKcal > roomToCeil)                      // can't even fit it under the ceiling
      return show('bad', `<b>${remP.toFixed(0)}g protein</b> left needs ~${Math.round(needKcal)} kcal of lean food but only <b>${Math.round(roomToCeil)}</b> to the ceiling — go lean now (chicken, egg whites, whey).`);
    if (needBuf > roomToFloor){                     // won't comfortably land by the floor → steer early
      return roomToFloor > 0
        ? show('warn', `Cover protein by the floor: <b>${remP.toFixed(0)}g</b> left (~${Math.round(needKcal)} kcal lean) with only ~<b>${Math.round(roomToFloor)}</b> to the floor. Go lean now — the ceiling stays your buffer.`)
        : show('warn', `Into the buffer with <b>${remP.toFixed(0)}g protein</b> left (~${Math.round(needKcal)} kcal) — keep it lean; ~<b>${Math.round(roomToCeil)}</b> to the ceiling.`);
    }
  }

  // Peri-workout fuelling — only on training days, timed to your workout window.
  if (isTrainingDay(ACTIVE_DATE)){
    const ws = hoursOf(TRAIN.start), we = hoursOf(TRAIN.end);
    if (ws!=null && h >= ws-2 && h < ws)
      return show('warn', `Pre-lift (${TRAIN.start}) — get carbs + protein in soon so you're fuelled for ${escapeHtml(splitForDate(ACTIVE_DATE))}.`);
    if (we!=null && h >= we && h < we+1.5)
      return show('warn', `Post-lift — prioritise protein + carbs now to kick off recovery.`);
  }

  if (t.kcal < 1){ line.hidden = true; return; }
  // Protein distribution nudge — lower priority than the floor-based steering above.
  if (expectedP!=null && remP>10 && t.p < expectedP - 20)
    return show('warn', `Protein back-loaded — ~<b>${Math.round(expectedP)}g</b> expected by now, you're at <b>${t.p.toFixed(0)}g</b>. Add a protein source this meal.`);
  const delta = t.kcal - paceKcal;
  const nextTxt = nextMeal ? ` · next: ${escapeHtml(nextMeal.name)} ${nextMeal.t} (~${nextMeal.kcal}${nextMeal.p?`, ${nextMeal.p}g P`:''})` : '';
  if (delta > 150)       show('warn', `Ahead of pace — ~<b>${Math.round(paceKcal)}</b> expected by now, you're at <b>${Math.round(t.kcal)}</b>. Ease off.${nextTxt}`);
  else if (delta < -200) show('', `Pace says ~<b>${Math.round(paceKcal)}</b> by now — room to eat.${nextTxt}`);
  else                   show('good', `On pace — ~<b>${Math.round(paceKcal)}</b> by now, you're at <b>${Math.round(t.kcal)}</b>.${nextTxt}`);
}
// Parse "HH:MM" → hours-of-day (float), or null. mealPlanHours() = the plan sorted, timed.
function hoursOf(hhmm){ const m=/^(\d{1,2}):(\d{2})$/.exec(String(hhmm||'').trim()); if(!m) return null;
  const H=+m[1], M=+m[2]; return (H<=23 && M<=59) ? H + M/60 : null; }
function mealPlanHours(){
  return MEAL_PLAN.map(m=>({h:hoursOf(m.t), t:m.t, kcal:+m.kcal||0, name:m.name||'meal'}))
    .filter(m=>m.h!=null && m.kcal>0).sort((a,b)=>a.h-b.h);
}

// ---- macro rows ------------------------------------------------------------
// Cards became rows: the protein floor and the optional caps are the same shape,
// read top to bottom, and no longer wrap awkwardly on a narrow phone.
function renderMacros(t){
  const rows = [];

  // Protein is a floor — the bar fills toward a target you want to reach.
  const pFrac = P_TARGET > 0 ? t.p / P_TARGET : 0;
  const pLeft = Math.max(0, P_TARGET - t.p);
  const pTone = pFrac >= 1 ? 'met' : (pFrac >= 0.7 ? '' : 'warn');
  let pNote = '';
  const bw = latestWeight();
  if (bw > 0){
    pNote = `${(t.p/bw).toFixed(2)} g/kg · ${bw}kg`;
    if (GOAL.mode !== 'off'){
      const perKg = GOAL_PROTEIN_PER_KG[GOAL.mode] || 1.8;
      pNote = `${(t.p/bw).toFixed(2)} g/kg · goal ${perKg} (${Math.round(perKg*bw)}g)`;
    }
  }
  rows.push(macroRow({
    name: `Protein · ${P_CFG.mode === 'pct' ? `${P_CFG.val}% ≈ ${Math.round(P_TARGET)}g` : `${Math.round(P_TARGET)}g`} floor`,
    value: t.p.toFixed(1),
    unit: `g · ${pLeft.toFixed(0)} left`,
    tone: pFrac >= 1 ? '' : 'short',
    frac: pFrac, barTone: pTone, note: pNote
  }));

  // Carbs and fat are caps — the bar fills toward a limit you want to stay under.
  [['Carbs', t.c, C_CAP, 4], ['Fat', t.f, F_CAP, 9]].forEach(([name, val, cap, kcalPerG])=>{
    const max = capGrams(cap, kcalPerG);
    const macroKcal = (t.p*4 + t.c*4 + t.f*9) || 1;
    const pctKcal = Math.round(val * kcalPerG / macroKcal * 100);
    if (!max){
      rows.push(macroRow({ name, value: val.toFixed(1), unit: `g · ${pctKcal}% kcal`, frac: null }));
      return;
    }
    const frac = val / max;
    rows.push(macroRow({
      name: `${name} · ${cap.mode === 'pct' ? `${cap.val}% ≈ ${Math.round(max)}g` : `${max}g`} cap`,
      value: val.toFixed(1),
      unit: `g · ${pctKcal}% kcal`,
      tone: frac > 1 ? 'over' : '',
      frac, barTone: frac > 1 ? 'over' : (frac >= 0.85 ? 'warn' : ''),
      note: frac > 1 ? `${Math.round(val - max)}g over the cap` : ''
    }));
  });

  document.getElementById('macroRows').innerHTML = rows.join('');
}
function macroRow(o){
  const groove = o.frac == null ? '' :
    `<span class="macro-groove"><span class="${o.barTone||''}" style="width:${Math.min(100, o.frac*100)}%"></span></span>`;
  const note = o.note ? `<span class="macro-note">${escapeHtml(o.note)}</span>` : '';
  return `<div class="macro-row">
    <span class="macro-name">${escapeHtml(o.name)}</span>
    <span class="macro-val ${o.tone||''}">${o.value}<small>${escapeHtml(o.unit)}</small></span>
    ${groove}${note}
  </div>`;
}

// ---- the entry ledger ------------------------------------------------------
function renderLedgerTable(){
  const body = document.getElementById('ledgerBody');
  if (!ledger.length){
    body.innerHTML = `<tr><td colspan="5" style="padding:0">${emptyLedgerCell()}</td></tr>`;
    wireEmptyLedgerChips();
    _prevLedgerLen = 0;
    return;
  }
  body.innerHTML = ledger.map((e,i)=>{
    const badge = (e.source && e.source !== 'DB')
      ? `<span class="badge ${e.source === 'USDA' ? 'usda' : 'est'}">${escapeHtml(e.source)}</span>` : '';
    const flags = e.flags && e.flags.length
      ? `<span class="flags">${escapeHtml(e.flags.join(' · '))}</span>` : '';
    // Row actions are real buttons with accessible names — the old ✕/✎ spans
    // were unreachable by keyboard and far too small to hit reliably.
    return `<tr>
      <td>
        ${badge}<span class="ename">${escapeHtml(e.name)}</span><span class="egrams">${e.grams}g</span><span class="row-actions">
          <button type="button" class="edit" data-edit="${i}" aria-label="Edit grams for ${escapeAttr(e.name)}" title="Edit grams">✎</button>
          <button type="button" class="del" data-del="${i}" aria-label="Remove ${escapeAttr(e.name)}" title="Remove">✕</button>
        </span>${flags}
      </td>
      <td>${Math.round(e.kcal)}</td><td>${e.p.toFixed(1)}</td><td>${e.f.toFixed(1)}</td><td>${(e.c||0).toFixed(1)}</td>
    </tr>`;
  }).join('');

  // Settle only the row(s) added since the last render — a quiet "logged" confirmation.
  if (ledger.length > _prevLedgerLen && !prefersReducedMotion()){
    const rows = body.querySelectorAll('tr');
    for (let i = _prevLedgerLen; i < ledger.length && i < rows.length; i++) rows[i].classList.add('rowNew');
  }
  _prevLedgerLen = ledger.length;

  body.querySelectorAll('[data-del]').forEach(b => { b.onclick = ()=> removeEntry(+b.dataset.del); });
  body.querySelectorAll('[data-edit]').forEach(b => { b.onclick = ()=> editEntryGrams(+b.dataset.edit); });
}

function escapeAttr(s){ return escapeHtml(String(s == null ? '' : s)).replace(/"/g, '&quot;'); }

// Removing is reversible for a few seconds. That is a better guard than a
// confirm dialog, because it costs nothing when you meant it.
function removeEntry(i){
  const e = ledger[i];
  if (!e) return;
  ledger.splice(i, 1);
  save(); render();
  toast(`Removed ${e.name}`, { undo: ()=>{ ledger.splice(i, 0, e); save(); render(); } });
}

async function editEntryGrams(i){
  const e = ledger[i];
  if (!e) return;
  const v = await promptSheet({
    title: 'Edit grams',
    body: e.name,
    label: 'Grams',
    type: 'number',
    value: e.grams,
    confirmLabel: 'Update'
  });
  if (v == null || v === '') return;
  const g = parseFloat(v);
  if (!(g > 0)){
    toast('Grams must be a number above zero.', { tone: 'warn' });
    return;
  }
  const base = e.base || getBase(e.name);
  if (!base){
    toast(`No nutrition data stored for ${e.name}.`, { tone: 'warn' });
    return;
  }
  const prev = ledger[i];
  const next = computeEntry(e.name, g, e.weighed, e.isCurry, e.halfOil, base, e.source);
  next.at = e.at;
  ledger[i] = next;
  save(); render();
  toast(`${e.name} set to ${g}g`, { undo: ()=>{ ledger[i] = prev; save(); render(); } });
}

// ---- render dispatch -------------------------------------------------------
// Only the visible tab is rendered. The old render() rebuilt all four tabs on
// every keystroke, including the heatmap and the ternary plot; switching tabs
// re-renders, so nothing can go stale.
function render(){
  applyAdaptiveCorridor();   // set the effective corridor before anything reads FLOOR/CEIL
  computePTarget();          // resolve % protein against the current floor
  refreshTargetLabels();
  updateSuppBadge();         // the nav badge is visible from every tab
  // Body profile and goal live in Settings now, which is reachable from every
  // tab — so their readouts are refreshed here rather than by the Trends view.
  renderTDEE(); renderGoal();

  if (ACTIVE_TAB === 'today')       renderToday();
  else if (ACTIVE_TAB === 'plan')   renderPlanTab();
  else if (ACTIVE_TAB === 'lift')   renderLift();
  else if (ACTIVE_TAB === 'trends') renderTrendsTab();
}

function renderToday(){
  const t = totals();
  renderInstrument(t);
  renderMacros(t);
  renderMicros(t);
  renderSuppToday();
  renderLedgerTable();
  renderFrequents();
  renderTemplates();
}

// ---- FREQUENT FOODS: mined from history + today, one tap prefills the form ----
function renderFrequents(){
  const wrap = document.getElementById('freqChips');
  const count = {}, last = {};
  allDays(true).forEach(d => d.ledger.forEach(e=>{
    if (!e.name) return;
    count[e.name] = (count[e.name]||0) + 1;
    // days are newest-first, so keep only the first (most recent) sighting
    if (!last[e.name]) last[e.name] = e;
  }));
  const top = Object.keys(count).sort((a,b)=>count[b]-count[a]).slice(0,6);
  if (!top.length){ wrap.hidden = true; wrap.innerHTML=''; return; }
  wrap.hidden = false;
  wrap.innerHTML = top.map((n,i)=>
    `<button type="button" class="chip" data-n="${i}">${escapeHtml(n)} <small>${last[n].grams}g</small></button>`).join('');
  wrap.querySelectorAll('.chip').forEach((ch,i)=>{
    ch.onclick = ()=>{
      const e = last[top[i]];
      const base = e.base || DB[e.name];
      if (base && !foodBase[e.name]) registerFood(e.name, base, e.source);
      openManual();
      document.getElementById('food').value = e.name;
      document.getElementById('grams').value = e.grams;
      document.getElementById('weighed').checked = !!e.weighed;
      updateProjection();
      document.getElementById('grams').focus();
    };
  });
}

// ---- EMPTY-STATE ONE-TAP CHIPS: the fastest path to logging a repeat meal ----
// Most tracking is the same foods daily; when the ledger is empty, surface the
// most-logged items as chips that log in a single tap at their last-used grams.
let _emptyTop = [];
function topFrequents(n){
  const count = {}, last = {};
  allDays(true).forEach(d => d.ledger.forEach(e=>{
    if (!e.name) return;
    count[e.name] = (count[e.name]||0) + 1;
    if (!last[e.name]) last[e.name] = e;   // days are newest-first → first sighting is most recent
  }));
  return Object.keys(count).sort((a,b)=>count[b]-count[a]).slice(0,n).map(name=>({name, e:last[name]}));
}
function emptyLedgerCell(){
  _emptyTop = topFrequents(6);
  if (!_emptyTop.length){
    return `<div class="empty-chips">
      <div class="ec-hint">Nothing logged yet. Describe a meal above, or snap a photo of it —
      the entries you log most will show up here as one-tap repeats.</div></div>`;
  }
  const chips = _emptyTop.map((f,i)=>
    `<button type="button" class="chip" data-q="${i}">${escapeHtml(f.e.name)} <small>${f.e.grams}g</small></button>`).join('');
  return `<div class="empty-chips">
    <div class="ec-hint">Nothing logged. Tap a usual to log it instantly.</div>
    <div class="ec-row">${chips}</div></div>`;
}
function wireEmptyLedgerChips(){
  document.querySelectorAll('#ledgerBody [data-q]').forEach(ch=>{
    ch.onclick = ()=>{
      const f = _emptyTop[+ch.dataset.q]; if (!f) return;
      const e = f.e, base = e.base || DB[e.name];
      if (!base) return;
      if (!foodBase[e.name]) registerFood(e.name, base, e.source);
      pushEntry(computeEntry(e.name, e.grams, e.weighed, e.isCurry, e.halfOil, base, e.source));
      haptic(); save(); render();
      toast(`Logged ${e.name} · ${e.grams}g`);
    };
  });
}

// ---- MEAL TEMPLATES ("usuals"): a named bundle of entries, logged in one tap ----
// Stored raw (name/grams/flags/base/source) and re-run through computeEntry on
// apply, so penalty settings current at log time are honoured — same as import.
function templates(){ try{ return JSON.parse(localStorage.getItem('ledger_templates')||'[]'); }catch(e){ return []; } }
function tplStamp(){ return getKey('ledger_tpl_updated'); }
function saveTemplates(list){
  try{ localStorage.setItem('ledger_templates', JSON.stringify(list)); }catch(e){}
  setKey('ledger_tpl_updated', new Date().toISOString());
  scheduleSync(); renderTemplates();
}
document.getElementById('saveTplBtn').onclick = async ()=>{
  if (!ledger.length){
    toast('Log something first — a usual is a saved set of entries.', { tone: 'warn' });
    return;
  }
  const name = await promptSheet({
    title: 'Save as a usual',
    body: `${ledger.length} ${ledger.length === 1 ? 'entry' : 'entries'} will be saved together and logged in one tap.`,
    label: 'Name',
    placeholder: 'usual breakfast',
    confirmLabel: 'Save usual',
    required: true
  });
  if (!name) return;
  const items = ledger.map(e=>({ name:e.name, grams:e.grams, weighed:e.weighed,
    isCurry:e.isCurry, halfOil:e.halfOil, base:e.base||getBase(e.name), source:e.source }));
  const existed = templates().some(t => t.name === name);
  const list = templates().filter(t=>t.name!==name);   // same name = overwrite
  list.push({name, items});
  saveTemplates(list);
  toast(existed ? `Updated “${name}”` : `Saved “${name}”`);
};
function renderTemplates(){
  const wrap = document.getElementById('tplChips');
  const list = templates();
  if (!list.length){ wrap.hidden = true; wrap.innerHTML=''; return; }
  wrap.hidden = false;
  wrap.innerHTML = list.map((t,i)=>{
    const kcal = Math.round(t.items.reduce((s,e)=> s + (e.base ? computeEntry(e.name,e.grams,e.weighed,e.isCurry,e.halfOil,e.base,e.source).kcal : 0), 0));
    return `<span class="chip">
      <button type="button" class="chip-main" data-tpl="${i}" style="all:unset;cursor:pointer">★ ${escapeHtml(t.name)} <small>${t.items.length} items · ${kcal} kcal</small></button>
      <button type="button" class="icon-btn" data-tpldel="${i}" aria-label="Delete usual ${escapeAttr(t.name)}" title="Delete usual">✕</button>
    </span>`;
  }).join('');
  wrap.querySelectorAll('[data-tpldel]').forEach(x=>{
    x.onclick = async (ev)=>{
      ev.stopPropagation();
      const t = templates()[+x.dataset.tpldel];
      if (!t) return;
      const list = templates();
      saveTemplates(list.filter(v=>v.name!==t.name));
      toast(`Deleted “${t.name}”`, { undo: ()=> saveTemplates(list) });
    };
  });
  wrap.querySelectorAll('[data-tpl]').forEach(ch=>{
    ch.onclick = ()=>{
      const t = templates()[+ch.dataset.tpl];
      if (!t) return;
      const before = ledger.slice();
      let added = 0;
      t.items.forEach(e=>{
        const base = e.base || DB[e.name];
        if (!base) return;
        if (e.base) registerFood(e.name, e.base, e.source);
        pushEntry(computeEntry(e.name, e.grams, e.weighed, e.isCurry, e.halfOil, base, e.source));
        added++;
      });
      if (!added){
        toast(`“${t.name}” has no usable nutrition data.`, { tone: 'warn' });
        return;
      }
      haptic(); save(); render();
      toast(`Logged “${t.name}” · ${added} ${added === 1 ? 'item' : 'items'}`,
        { undo: ()=>{ ledger = before; save(); render(); } });
    };
  });
}

// ---- MICRONUTRIENTS: recovery-focused panel with under/over flags ----
// Daily reference values (m = male, f = female). 'limit' nutrients (sodium/sugar) flag high;
// the rest flag low. Targets are general adult references, not medical advice.
const MICROS = [
  {key:'fib', name:'Fiber',      unit:'g',  t:{m:38,f:25},     limit:false},
  {key:'k',   name:'Potassium',  unit:'mg', t:{m:3400,f:2600}, limit:false, rec:true},
  {key:'mg',  name:'Magnesium',  unit:'mg', t:{m:400,f:310},   limit:false, rec:true},
  {key:'ca',  name:'Calcium',    unit:'mg', t:{m:1000,f:1000}, limit:false},
  {key:'fe',  name:'Iron',       unit:'mg', t:{m:8,f:18},      limit:false},
  {key:'zn',  name:'Zinc',       unit:'mg', t:{m:11,f:8},      limit:false},
  {key:'vc',  name:'Vitamin C',  unit:'mg', t:{m:90,f:75},     limit:false, rec:true},
  {key:'vd',  name:'Vitamin D',  unit:'µg', t:{m:15,f:15},     limit:false},
  {key:'na',  name:'Sodium',     unit:'mg', t:{m:2300,f:2300}, limit:true,  rec:true},
  {key:'sug', name:'Sugar',      unit:'g',  t:{m:50,f:50},     limit:true}
];
function renderMicros(t){
  const wrap = document.getElementById('microLine');
  if (!MICROS.some(mi => (t[mi.key]||0) > 0)){ wrap.hidden = true; return; }
  const sex = PROFILE.sex==='female' ? 'f' : 'm';
  const training = isTrainingDay(VIEW_DATE);   // emphasise recovery nutrients on training days
  // Tone, not colour-by-nutrient: on target is plain chalk, only trouble is coloured.
  const tone = { ok:'met', near:'warn', over:'over', low:'warn', verylow:'over', na:'' };
  const badge = { over:'over', verylow:'very low', low:'low', near:'near limit', ok:'', na:'' };
  let low=0, over=0;
  const rows = MICROS.map(mi=>{
    const val = t[mi.key]||0, target = mi.t[sex];
    const status = LedgerCore.microStatus(val, target, mi.limit);
    if (status==='low'||status==='verylow') low++;
    if (status==='over') over++;
    const w = Math.min(100, target>0 ? val/target*100 : 0);
    const shown = val<10 ? val.toFixed(1) : Math.round(val);
    const recTag = (training && mi.rec) ? ' ⚡' : '';
    const flag = badge[status] ? ` · ${badge[status]}` : '';
    return `<div class="micro-row">
      <span class="micro-name">${mi.name}${recTag}</span>
      <span class="micro-bar"><span class="${tone[status]}" style="width:${w}%"></span></span>
      <span class="micro-val ${tone[status] === 'over' ? 'over' : (tone[status] === 'warn' ? 'warn' : '')}">${shown}<small>/${target}${mi.unit}${flag}</small></span>
    </div>`;
  }).join('');
  const summary = (low||over)
    ? [low?`${low} low`:'', over?`${over} over`:''].filter(Boolean).join(' · ')
    : 'all tracked micros on target';
  const recNote = training
    ? `<div class="tactical" style="margin-top:10px">⚡ ${escapeHtml(splitForDate(VIEW_DATE))} day — potassium, magnesium, sodium &amp; vitamin C support recovery; keep these topped up.</div>`
    : '';
  wrap.hidden = false;
  wrap.innerHTML = `<details><summary class="panel-title">Micronutrients · ${summary}</summary>
    <div style="margin-top:12px">${rows}${recNote}
      <div class="tactical" style="margin-top:12px">Counted from USDA-matched foods only — AI estimates and older entries add nothing, so a low reading can mean under-<i>tracked</i> rather than under-eaten. Sodium &amp; sugar are limits. General references, not medical advice.</div>
    </div></details>`;
}

