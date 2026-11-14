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

/// ---- the gauge (signature element) ----------------------------------------
// A half-circle dial drawn from LedgerCore.gaugeGeometry: 0 kcal at the left end, the scale
// maximum (ceiling x 1.15, grown if intake passes it) at the right, the corridor as a band on
// the arc, the fill to what has been eaten, and a tick for where the meal plan says you should
// be by now. All the geometry is in core.js and tested; this only writes it into the SVG.
let _gaugeGeo = null;
const fmtKcal = n => Math.round(n).toLocaleString();
const svgAttrs = (id, attrs) => { const el = document.getElementById(id); if (el) for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };

// A ghost segment from current intake to a projected intake — driven by the meal
// composer while the grams field holds a value (see app.js).
function setGaugeProjection(kcal){
  const el = document.getElementById('projCursor');
  if (!el) return;
  if (kcal == null || !_gaugeGeo){ el.setAttribute('hidden', ''); return; }
  const d = LedgerCore.gaugeArc(_gaugeGeo, totals().kcal, kcal);
  if (!d){ el.setAttribute('hidden', ''); return; }
  el.setAttribute('d', d);
  el.removeAttribute('hidden');
}

let _lastCorridorKey = '';
function renderInstrument(t){
  const st = corridorState(t.kcal);
  const inst = document.getElementById('instrument');
  const geo = _gaugeGeo = LedgerCore.gaugeGeometry({ floor:FLOOR, ceil:CEIL, intake:t.kcal });
  const tone = t.kcal < 1 ? 'empty' : st.key;

  svgAttrs('gaugeTrack', { d: geo.track });
  svgAttrs('gaugeZone', { d: geo.zone });
  const prog = svgAttrs('gaugeProg', { d: geo.progress });
  if (prog) prog.setAttribute('class', 'g-prog is-' + tone);
  svgAttrs('gaugeTickFloor', geo.ticks.floor);
  svgAttrs('gaugeTickCeil', geo.ticks.ceil);
  [['gaugeLblFloor', geo.labels.floor, FLOOR], ['gaugeLblCeil', geo.labels.ceil, CEIL]].forEach(([id, l, v])=>{
    const el = svgAttrs(id, { x: l.x.toFixed(1), y: l.y.toFixed(1), 'text-anchor': l.anchor });
    if (el) el.textContent = fmtKcal(v);
  });

  // The calories eaten are the headline; the verdict is one line, which says how far from
  // the nearest edge of the corridor. The corridor itself is printed once, on the arc.
  const readout = document.getElementById('readout');
  readout.textContent = fmtKcal(t.kcal);
  readout.className = 'cor-val is-' + tone;
  let verdict;
  if (t.kcal < 1)          verdict = `Nothing logged · ${fmtKcal(FLOOR)} to the floor`;
  else if (t.kcal < FLOOR) verdict = `Below · ${fmtKcal(FLOOR - t.kcal)} to the floor`;
  else if (t.kcal <= CEIL) verdict = `Inside · ${fmtKcal(CEIL - t.kcal)} under the ceiling`;
  else                     verdict = `Over · ${fmtKcal(t.kcal - CEIL)} past the ceiling`;
  const stamp = document.getElementById('verdictStamp');
  stamp.textContent = verdict;
  stamp.className = 'cor-state is-' + tone;

  // The goal line only exists when a goal is steering the corridor; with a manual corridor the
  // arc already says everything.
  const sub = document.getElementById('readoutSub');
  let subTxt = '';
  if (CORRIDOR_AUTO){
    const dayTxt = CORRIDOR_AUTO.cycled
      ? ` · ${CORRIDOR_AUTO.training ? CORRIDOR_AUTO.split + ' day' : 'rest day'} ${CORRIDOR_AUTO.off >= 0 ? '+' : ''}${CORRIDOR_AUTO.off}`
      : '';
    subTxt = `${GOAL_LABEL[GOAL.mode]}${dayTxt} · TDEE ${CORRIDOR_AUTO.tdee.toLocaleString()}`;
  }
  sub.textContent = subTxt;
  sub.hidden = !subTxt;

  // Meter semantics for assistive tech: the dial is decorative, this is its text alternative.
  const scale = document.getElementById('scale');
  scale.setAttribute('aria-valuemin', '0');
  scale.setAttribute('aria-valuemax', String(Math.round(geo.max)));
  scale.setAttribute('aria-valuenow', String(Math.round(t.kcal)));
  scale.setAttribute('aria-valuetext',
    `${fmtKcal(t.kcal)} kcal, ${st.label}. Corridor ${fmtKcal(FLOOR)} to ${fmtKcal(CEIL)}. ${verdict}.${subTxt ? ' ' + subTxt + '.' : ''}`);

  // Crossing into breach flashes the card once — not on a re-render while over.
  const key = st.key + '|' + VIEW_DATE;
  if (st.key === 'breach' && _lastCorridorKey && _lastCorridorKey !== key && !prefersReducedMotion()){
    inst.classList.remove('breached'); void inst.offsetWidth; inst.classList.add('breached'); haptic(40);
  }
  _lastCorridorKey = key;

  renderPace(t, geo);
}

// Pace marker + protein-aware steering — only meaningful on the live, open day. The marker
// slides from 0 → the corridor centre across the eating day (06:00–24:00 PST), so a full
// ceiling early doesn't read as "loads of room". Steering fires when the calories left to
// the ceiling can no longer comfortably cover the protein still owed — the exact squeeze
// the user hits at night.
function renderPace(t, geo){
  const mark = document.getElementById('paceMark'), line = document.getElementById('paceLine');
  const live = VIEW_DATE === ACTIVE_DATE;
  if (!live || CEIL <= 0){ mark.setAttribute('hidden', ''); line.hidden = true; return; }

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
  // Pace shows as a tick across the arc, at where you should be by now.
  svgAttrs('paceMark', LedgerCore.gaugePaceTick(geo, paceKcal));
  mark.removeAttribute('hidden');

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

/// ---- macro tiles -----------------------------------------------------------
// Protein is a floor, carbs and fat are caps. Each is one compact tile: the value, the target
// small beside it, a thin bar and a status colour. What used to sit under each bar (grams per
// kg, the unsaturated-fat note, "n g over the cap") lives in the collapsed "More detail" block.
function renderMacros(t){
  const tiles = [], notes = [];

  // Protein is a floor: the bar fills toward a target you want to reach and goes green once met.
  const pFrac = P_TARGET > 0 ? t.p / P_TARGET : 0;
  const bw = latestWeight();
  if (bw > 0){
    let pNote = `${(t.p/bw).toFixed(2)} g/kg · ${bw}kg`;
    if (GOAL.mode !== 'off'){
      const perKg = GOAL_PROTEIN_PER_KG[GOAL.mode] || 1.8;
      pNote = `${(t.p/bw).toFixed(2)} g/kg · goal ${perKg} (${Math.round(perKg*bw)}g)`;
    }
    notes.push({ text: `Protein ${pNote}`, tone: '' });
  }
  tiles.push(macroTile({
    label: 'Protein', value: t.p.toFixed(0),
    of: P_TARGET > 0 ? `/${Math.round(P_TARGET)} g` : ' g',
    frac: P_TARGET > 0 ? pFrac : null,
    tone: P_TARGET > 0 ? (pFrac >= 1 ? 'ok' : pFrac >= 0.7 ? '' : 'warn') : '',
    title: P_TARGET > 0 ? `${Math.round(pFrac*100)}% of the ${Math.round(P_TARGET)} g protein floor` : ''
  }));

  // Carbs and fat are caps: the bar fills toward a limit you want to stay under and reddens once over.
  [['Carbs', t.c, C_CAP, 4], ['Fat', t.f, F_CAP, 9]].forEach(([label, val, cap, kcalPerG])=>{
    const max = capGrams(cap, kcalPerG);
    const macroKcal = (t.p*4 + t.c*4 + t.f*9) || 1;
    const fat = label === 'Fat' ? fatBreakdown(t) : null;
    if (fat) notes.push({ text: `Fat ${fat.text}`, tone: fat.tone });
    if (!max){
      tiles.push(macroTile({ label, value: val.toFixed(0), of: ` g · ${Math.round(val * kcalPerG / macroKcal * 100)}% kcal`, frac: null, tone: '' }));
      return;
    }
    const frac = val / max;
    if (frac > 1) notes.push({ text: `${label} ${Math.round(val - max)} g over the ${Math.round(max)} g cap`, tone: 'over' });
    tiles.push(macroTile({
      label, value: val.toFixed(0), of: `/${Math.round(max)} g`, frac,
      tone: frac > 1 ? 'bad' : (frac >= 0.85 ? 'warn' : ''),
      title: `${Math.round(frac*100)}% of the ${Math.round(max)} g ${label.toLowerCase()} cap`
    }));
  });

  document.getElementById('macroRows').innerHTML = tiles.join('');
  document.getElementById('macroNotes').innerHTML = notes.map(n=>
    `<div class="macro-note ${n.tone||''}">${escapeHtml(n.text)}</div>`).join('');
}
// The line under the fat bar. Saturated + trans is the "unhealthy" share worth watching;
// the ceiling is 10% of the calorie floor's energy (the WHO cap). Unsaturated rides along for
// context. Only what USDA-matched foods report is counted, so it can read below total fat when
// AI-estimated items (which carry no fat breakdown) are in the day — say so rather than mislead.
function fatBreakdown(t){
  const sat = t.sfa||0, uns = t.ufa||0, tr = t.tfa||0, unhealthy = sat + tr;
  if (unhealthy + uns < 0.05) return null;                  // no breakdown data logged yet
  const limit = FLOOR > 0 ? FLOOR * 0.10 / 9 : 0;           // 10% of floor kcal, as grams of fat
  const trTxt = tr > 0.05 ? ` (${sat.toFixed(1)} sat + ${tr.toFixed(1)} trans)` : '';
  const cap = limit > 0 ? ` / ~${Math.round(limit)}g` : '';
  const text = `${unhealthy.toFixed(1)}g unhealthy${trTxt}${cap} · ${uns.toFixed(1)}g unsaturated`;
  const tone = limit > 0 && unhealthy > limit ? 'over'
             : limit > 0 && unhealthy >= limit * 0.85 ? 'warn' : '';
  return { text, tone };
}
function macroTile(o){
  const bar = o.frac == null ? '' :
    `<span class="mt-bar" aria-hidden="true"><i class="${o.tone||''}" style="width:${Math.max(0, Math.min(100, o.frac*100)).toFixed(1)}%"></i></span>`;
  return `<div class="mt" ${o.title ? `title="${escapeAttr(o.title)}"` : ''}>
    <span class="mt-l">${escapeHtml(o.label)}</span>
    <span class="mt-v ${o.tone||''}">${escapeHtml(o.value)}<small>${escapeHtml(o.of)}</small></span>${bar}
  </div>`;
}

// ---- the meals list ----------------------------------------------------------
// One row per sitting (LedgerCore.mealRows: entries within 30 minutes of the one before),
// collapsed. A <details> per meal, so it opens on tap and from the keyboard with no script.
// Inside, each ingredient keeps the edit and remove actions the flat list had, wired to the
// very same handlers, so undo and tombstones behave exactly as before.
//
// Nothing is remembered between renders except this: the meal you just edited or removed from
// stays open, so the row does not snap shut under your thumb. It is consumed by one render.
let _keepOpenId = null;
function clockOf(e){
  const t = Date.parse(e.eatenAt || e.at || '');
  if (!Number.isFinite(t)) return '';
  const m = (((Math.floor(t/60000) + TZ_OFFSET_MIN) % 1440) + 1440) % 1440;
  return String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');
}
function renderLedgerTable(){
  const body = document.getElementById('ledgerBody');
  const title = document.getElementById('ledgerTitle'), count = document.getElementById('ledgerCount');
  if (title) title.textContent = 'Meals';           // the day is already in the header and, for a past day, the banner
  if (!ledger.length){
    if (count) count.textContent = 'Nothing yet';
    body.innerHTML = emptyLedgerCell();
    wireEmptyLedgerChips();
    _prevLedgerLen = 0; _keepOpenId = null;
    return;
  }
  const meals = LedgerCore.mealRows(ledger, { tzOffsetMin: TZ_OFFSET_MIN, templates: templates() });
  if (count) count.textContent = `${meals.length} meal${meals.length===1?'':'s'} · ${ledger.length} item${ledger.length===1?'':'s'}`;

  const badgeFor = e => (e.source && e.source !== 'DB')
    ? `<span class="badge ${(e.source === 'USDA' || /^CoFID/.test(e.source)) ? 'usda' : 'est'}">${escapeHtml(e.source)}</span>` : '';
  const actionsFor = (e, i) => `<div class="meal-actions" aria-label="Entry actions">
    <button type="button" class="edit" data-edit="${i}" aria-label="Edit grams for ${escapeAttr(e.name)}" title="Edit grams">${uiIcon('edit', 17)}</button>
    <button type="button" class="del" data-del="${i}" aria-label="Remove ${escapeAttr(e.name)}" title="Remove">${uiIcon('trash', 17)}</button>
  </div>`;
  const partRow = (e, i) => {
    const short = LedgerCore.shortFoodName(e.name) || e.name;
    const bits = [];
    if (short !== e.name) bits.push(escapeHtml(e.name));            // the full database name stays visible here
    bits.push(`${Math.round(e.grams)} g`);
    if (clockOf(e)) bits.push(clockOf(e));
    return `<div class="part">
      <div class="part-main">
        <span class="part-nm">${badgeFor(e)}${escapeHtml(short)}</span>
        <span class="part-meta">${bits.join(' · ')}</span>
        <span class="part-macros">P ${e.p.toFixed(1)} · C ${(e.c||0).toFixed(1)} · F ${e.f.toFixed(1)} g</span>
        ${e.flags && e.flags.length ? `<span class="part-flags">${escapeHtml(e.flags.join(' · '))}</span>` : ''}
      </div>
      <span class="part-k">${Math.round(e.kcal)}<small>kcal</small></span>
      ${actionsFor(e, i)}
    </div>`;
  };
  // A decomposed dish stays one visible unit inside the meal: its components are still
  // individually editable, which is what keeps a wrong gram estimate on the rice fixable.
  const partsHtml = m => {
    const blocks = [], at = {};
    m.idx.forEach(i=>{
      const e = ledger[i], dish = (e.partOf || '').trim();
      if (!dish){ blocks.push({ dish:'', items:[{e,i}] }); return; }
      const key = e.dishId || `legacy:${dish.toLowerCase()}`;
      if (at[key] == null){ at[key] = blocks.length; blocks.push({ dish, items:[] }); }
      blocks[at[key]].items.push({e,i});
    });
    return blocks.map(b=>{
      const rows = b.items.map(x=>partRow(x.e, x.i)).join('');
      if (!b.dish || m.kind === 'dish') return rows;                // the meal's own name already is the dish
      const kc = b.items.reduce((s,x)=>s + x.e.kcal, 0);
      return `<div class="part-dish"><span>Dish · ${escapeHtml(b.dish)} <small>${b.items.length} ingredient${b.items.length>1?'s':''}</small></span><span>${Math.round(kc)} kcal</span></div>${rows}`;
    }).join('');
  };

  body.innerHTML = meals.map(m=>{
    const open = _keepOpenId != null && m.idx.some(i => ledger[i]._id === _keepOpenId);
    const tags = (m.usual ? '<span class="tag mine">your usual</span>' : '')
               + (m.estimate ? '<span class="tag">estimate</span>' : '');
    return `<details class="meal"${open ? ' open' : ''}>
      <summary>
        <span class="meal-t">${m.time ? escapeHtml(m.time) : '–'}</span>
        <span class="meal-mid"><span class="meal-nm">${escapeHtml(m.name)}${tags}</span><span class="meal-sub">${escapeHtml(m.summary)}</span></span>
        <span class="meal-k">${Math.round(m.kcal)}<small>${Math.round(m.p)} g P</small></span>
      </summary>
      <div class="meal-parts">${partsHtml(m)}
        <div class="meal-total"><span>Meal total</span><span>P ${m.p.toFixed(0)} · C ${m.c.toFixed(0)} · F ${m.f.toFixed(0)} g</span></div>
      </div>
    </details>`;
  }).join('');
  _keepOpenId = null;

  // Settle only the meal(s) that gained entries since the last render — a quiet "logged" flash.
  if (ledger.length > _prevLedgerLen && !prefersReducedMotion()){
    for (let i = _prevLedgerLen; i < ledger.length; i++){
      const btn = body.querySelector(`[data-edit="${i}"]`);
      const meal = btn && btn.closest('.meal');
      if (meal) meal.classList.add('rowNew');
    }
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
  // Keep the meal this entry belonged to open: remember another of its entries, if it has one.
  const sibling = LedgerCore.mealRows(ledger, { tzOffsetMin: TZ_OFFSET_MIN }).filter(m => m.idx.indexOf(i) >= 0)[0];
  const other = sibling ? sibling.idx.filter(x => x !== i)[0] : null;
  tombstoneEntry(VIEW_DATE,e._id);
  ledger.splice(i, 1);
  _keepOpenId = other != null ? ledger[other > i ? other - 1 : other]._id : null;
  save(); render();
  toast(`Removed ${e.name}`, { undo: ()=>{ untombstoneEntry(VIEW_DATE,e._id); ledger.splice(i, 0, e); _keepOpenId = e._id; save(); render(); } });
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
  const next = computeEntry(e.name, g, e.weighed, base, e.source, e.partOf);
  next._id=e._id; next.at=e.at; next.eatenAt=e.eatenAt; next.loggedAt=e.loggedAt;
  if (e.match) next.match=e.match;
  next.updatedAt=new Date().toISOString();
  ledger[i] = next;
  _keepOpenId = e._id;
  save(); render();
  toast(`${e.name} set to ${g}g`, { undo: ()=>{ ledger[i] = prev; _keepOpenId = e._id; save(); render(); } });
}

// ---- render dispatch -------------------------------------------------------
// Only the visible tab is rendered. The old render() rebuilt all four tabs on
// every keystroke, including the heatmap and the ternary plot; switching tabs
// re-renders, so nothing can go stale.
function render(){
  invalidateBounds();        // history-wide corridor cache: one rebuild per render, not per day
  applyAdaptiveCorridor();   // set the effective corridor before anything reads FLOOR/CEIL
  computePTarget();          // resolve % protein against the current floor
  refreshTargetLabels();
  const settingsEffective = document.getElementById('settingsEffective');
  if (settingsEffective) settingsEffective.innerHTML = `<span>Current daily targets</span><b>${FLOOR.toLocaleString()}–${CEIL.toLocaleString()} kcal</b><small>Protein target ${Math.round(P_TARGET)}g · ${GOAL.mode === 'off' ? 'your calorie range' : GOAL_LABEL[GOAL.mode]}</small>`;
  updateSuppBadge();         // the nav badge is visible from every tab
  // Body profile and goal live in Settings now, which is reachable from every
  // tab — so their readouts are refreshed here rather than by the Trends view.
  renderTDEE(); renderGoal();

  if (ACTIVE_TAB === 'today')       renderToday();
  else if (ACTIVE_TAB === 'logs')   renderLogsTab();
  else if (ACTIVE_TAB === 'plan')   renderPlanTab();
  else if (ACTIVE_TAB === 'lift')   renderLift();
  else if (ACTIVE_TAB === 'trends') renderTrendsTab();
}

// The collapsed "More detail" row says what is inside it, and flags supplements still to take
// (the one daily action that lives in there).
function renderMoreHint(){
  const el = document.querySelector('#todayMore .more-hint');
  if (!el) return;
  const todo = document.querySelectorAll('#suppTodayStrip [data-suppquick]:not(.on)').length;
  el.textContent = todo ? `${todo} supplement${todo===1?'':'s'} to take · g per kg · fats · micronutrients`
                        : 'g per kg · fats · micronutrients · supplements';
}
function renderToday(){
  const t = totals();
  renderInstrument(t);
  renderMacros(t);
  renderMicros(t);
  renderSuppToday();
  renderMoreHint();
  renderLedgerTable();
  renderFrequents();
  renderTemplates();
}

// ---- REPEATS: what you have eaten before, offered as one tap -----------------
// Mined as MEALS, not ingredients. Decomposition means the raw ledger is full of
// "Sugar, NFS" and "Vegetable oil, NFS" — real rows, but nothing anyone wants to
// repeat. LedgerCore.mineRepeats regroups each day by dish first, and drops bulk
// import rows, which otherwise take the top slot with a whole day's calories
// wearing a food's name.
function repeatUnits(n){ return LedgerCore.mineRepeats(allDays(true), {limit: n}); }

// The offline library is an index over data Eatify already keeps. It stores no
// duplicate meal payload: saved usuals lead as pinned entries, then every distinct
// meal in local/synced history follows by frequency. A device only needs one online
// sync to acquire the history; afterwards this entire list is local.
function offlineMealUnits(){
  const norm = s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const pinned = templates().map(t=>({name:t.name,kind:'dish',items:t.items||[],pinned:true,count:0}));
  const seen = new Set(pinned.map(t=>norm(t.name)));
  const history = [];
  LedgerCore.mineRepeats(allDays(true), {limit:Number.MAX_SAFE_INTEGER}).forEach(u=>{
    const key=norm(u.name); if(!key||seen.has(key))return; seen.add(key); history.push(u);
  });
  return pinned.concat(history);
}

function cloneRepeatItems(items){
  return (items||[]).map(e=>({name:e.name,grams:e.grams,weighed:e.weighed,
    partOf:e.partOf,base:e.base||getBase(e.name),source:e.source})).filter(e=>e.name&&e.base);
}

function renderOfflineLibraryButton(){
  const count = offlineMealUnits().length;
  const label = document.getElementById('offlineMealsCount');
  if (label) label.textContent = count ? `· ${count}` : '· empty';
}

function openOfflineMeals(){
  return openSheet((sheet,close)=>{
    sheetHead(sheet,'Offline meals','Saved usuals are pinned first. Everything else is rebuilt from meal history already on this device.');
    const search = document.createElement('input');
    search.type='search'; search.placeholder='Search previous meals'; search.setAttribute('aria-label','Search offline meals');
    search.className='offline-meal-search'; sheet.appendChild(search);
    const summary=document.createElement('div'); summary.className='tactical offline-meal-summary'; sheet.appendChild(summary);
    const list=document.createElement('div'); list.className='offline-meal-list'; sheet.appendChild(list);
    let units=offlineMealUnits();
    const draw=()=>{
      const q=search.value.trim().toLowerCase();
      const shown=units.filter(u=>!q||u.name.toLowerCase().includes(q));
      summary.textContent=`${shown.length} of ${units.length} offline meal${units.length===1?'':'s'}`;
      if(!shown.length){ list.innerHTML='<div class="empty">No matching meals on this device yet.</div>'; return; }
      list.innerHTML=shown.map((u,i)=>{
        const kcal=Math.round((u.items||[]).reduce((s,e)=>s+(+e.kcal||(+e.base?.kcal||0)*(+e.grams||0)/100),0));
        const meta=[u.pinned?'pinned':u.count?`logged ${u.count}×`:'saved',`${u.items.length} item${u.items.length===1?'':'s'}`,kcal?`${kcal} kcal`:null].filter(Boolean).join(' · ');
        return `<div class="result offline-meal-row"><div class="grow"><div class="rname">${escapeHtml(u.name)}</div><div class="rmeta">${escapeHtml(meta)}</div></div><button type="button" class="icon-btn" data-pin="${i}" aria-label="${u.pinned?'Unpin':'Pin'} ${escapeAttr(u.name)}" title="${u.pinned?'Unpin':'Pin'}">${u.pinned?'★':'☆'}</button><button type="button" class="sm ghost" data-log="${i}">Log</button></div>`;
      }).join('');
      list.querySelectorAll('[data-log]').forEach(btn=>btn.onclick=()=>{const u=shown[+btn.dataset.log];close(null);logRepeat(u);});
      list.querySelectorAll('[data-pin]').forEach(btn=>btn.onclick=()=>{
        const u=shown[+btn.dataset.pin], key=u.name.toLowerCase();
        if(u.pinned) saveTemplates(templates().filter(t=>t.name.toLowerCase()!==key));
        else {
          const items=cloneRepeatItems(u.items);
          if(items.length) saveTemplates(templates().filter(t=>t.name.toLowerCase()!==key).concat({name:u.name,items}));
        }
        units=offlineMealUnits(); draw();
      });
    };
    search.addEventListener('input',draw); draw();
    const done=document.createElement('button'); done.type='button'; done.className='ghost'; done.textContent='Close'; done.onclick=()=>close(null); sheet.appendChild(done);
    return search;
  });
}
document.getElementById('offlineMealsBtn').onclick=openOfflineMeals;
function repeatChipHTML(u, attr, i){
  const label = u.kind === 'dish'
    ? `${uiIcon('repeat', 14)} ${escapeHtml(u.name)} <small>${u.items.length} items</small>`
    : `${escapeHtml(u.name)} <small>${Math.round(u.items[0].grams)}g</small>`;
  return `<button type="button" class="chip${u.kind === 'dish' ? ' dish' : ''}" ${attr}="${i}">${label}</button>`;
}
// Tapping a repeat re-weighs it rather than re-logging the old amount. A saved food is an
// INGREDIENT, not a portion — the same roti is 120 g one day and 150 g the next — so the tap
// opens a weigh sheet with each ingredient's last amount prefilled and selected: accept it with
// Enter, or type the new weight. A dish asks for every ingredient, so a multi-item meal stays
// accurate. Set an ingredient to 0 to drop it from this log.
function weighSheet(u){
  return openSheet((sheet, close)=>{
    const many = u.items.length > 1;
    sheetHead(sheet, u.name, many ? 'Enter the weight of each ingredient — 0 to skip one.' : 'Enter the weight you ate.');
    const inputs = [];
    u.items.forEach(e=>{
      const row = document.createElement('label');
      row.className = 'weigh-row';
      const name = document.createElement('span');
      name.className = 'weigh-name'; name.textContent = e.name;         // textContent escapes the name
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.step = '1'; inp.inputMode = 'decimal';
      inp.value = Math.round(e.grams);
      const unit = document.createElement('span');
      unit.className = 'weigh-unit'; unit.textContent = 'g';
      row.appendChild(name); row.appendChild(inp); row.appendChild(unit);
      sheet.appendChild(row);
      inputs.push(inp);
    });
    const commit = ()=>{
      const grams = inputs.map(inp => Math.max(0, +inp.value || 0));
      close(grams.some(g => g > 0) ? grams : null);
    };
    // Enter advances to the next ingredient, and commits from the last.
    inputs.forEach((inp, idx)=> inp.addEventListener('keydown', ev=>{
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      if (idx < inputs.length - 1) inputs[idx + 1].focus(); else commit();
    }));
    sheetActions(sheet, many ? `Log ${u.name}` : 'Log', 'Cancel', null, commit, ()=> close(null));
    return inputs[0];
  });
}
// Weigh-then-log a repeat or a usual. Shared by both so an identical-looking control means the
// same thing everywhere. The toast carries the undo.
async function logRepeat(u){
  if (!u) return;
  const grams = await weighSheet(u);
  if (!grams) return;                                  // cancelled, or every ingredient zeroed
  const before = ledger.slice();
  let added = 0;
  u.items.forEach((e, idx)=>{
    const g = grams[idx];
    if (!(g > 0)) return;                              // a zeroed ingredient is dropped from this log
    const base = e.base || DB[e.name];
    if (!base) return;
    if (!foodBase[e.name]) registerFood(e.name, base, e.source);
    pushEntry(computeEntry(e.name, g, e.weighed, base, e.source, e.partOf));
    added++;
  });
  if (!added){ toast(`No nutrition data stored for ${u.name}.`, { tone:'warn' }); return; }
  haptic(); save(); render();
  toast(u.items.length > 1 ? `Logged ${u.name} · ${added} item${added===1?'':'s'}` : `Logged ${u.name}`,
    { undo: ()=>{ ledger = before; save(); render(); } });
}

let _freqTop = [];
function renderFrequents(){
  const wrap = document.getElementById('freqChips');
  _freqTop = repeatUnits(6);
  if (!_freqTop.length){ wrap.hidden = true; wrap.innerHTML=''; syncAddPanel(); return; }
  wrap.hidden = false;
  syncAddPanel();
  wrap.innerHTML = _freqTop.map((u,i)=> repeatChipHTML(u, 'data-n', i)).join('');
  wrap.querySelectorAll('[data-n]').forEach(ch=>{
    ch.onclick = ()=> logRepeat(_freqTop[+ch.dataset.n]);
  });
}

// ---- EMPTY-STATE ONE-TAP CHIPS: the fastest path to logging a repeat meal ----
let _emptyTop = [];
function emptyLedgerCell(){
  _emptyTop = repeatUnits(6);
  if (!_emptyTop.length){
    return `<div class="empty-chips">
      <div class="ec-hint">Nothing logged yet. Describe a meal above, or snap a photo of it —
      the meals you log most will show up here as one-tap repeats.</div></div>`;
  }
  return `<div class="empty-chips">
    <div class="ec-hint">Nothing logged. Tap a usual to weigh it and log.</div>
    <div class="ec-row">${_emptyTop.map((u,i)=> repeatChipHTML(u, 'data-q', i)).join('')}</div></div>`;
}
function wireEmptyLedgerChips(){
  document.querySelectorAll('#ledgerBody [data-q]').forEach(ch=>{
    ch.onclick = ()=> logRepeat(_emptyTop[+ch.dataset.q]);
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
  // A day's ledger is several meals, not one. Pick the entries this usual is
  // made of — everything is ticked to start, so saving the whole day stays one tap.
  const snapshot = ledger.slice();
  const res = await pickSheet({
    title: 'Save as a usual',
    body: 'Tick the entries this usual is made of. Tapping it later logs exactly these.',
    items: snapshot.map(e=>({
      label: e.name,
      sub: `${Math.round(e.grams)}g · ${Math.round(e.kcal)} kcal`,
      checked: true
    })),
    summary: idx => `${idx.length} of ${snapshot.length} · ${Math.round(
      idx.reduce((s,i)=> s + (snapshot[i].kcal || 0), 0))} kcal`,
    label: 'Name',
    placeholder: 'usual breakfast',
    confirmLabel: 'Save usual',
    required: true
  });
  if (!res) return;
  const name = res.name;
  const items = res.indices.map(i=>snapshot[i]).map(e=>({ name:e.name, grams:e.grams, weighed:e.weighed,
    partOf:e.partOf, base:e.base||getBase(e.name), source:e.source }));
  const existed = templates().some(t => t.name === name);
  const list = templates().filter(t=>t.name!==name);   // same name = overwrite
  list.push({name, items});
  saveTemplates(list);
  toast(`${existed ? 'Updated' : 'Saved'} “${name}” · ${items.length} item${items.length>1?'s':''}`);
};
function renderTemplates(){
  const wrap = document.getElementById('tplChips');
  const list = templates();
  if (!list.length){ wrap.hidden = true; wrap.innerHTML=''; renderOfflineLibraryButton(); syncAddPanel(); return; }
  wrap.hidden = false;
  syncAddPanel();
  wrap.innerHTML = list.map((t,i)=>{
    const kcal = Math.round(t.items.reduce((s,e)=> s + (e.base ? computeEntry(e.name,e.grams,e.weighed,e.base,e.source,e.partOf).kcal : 0), 0));
    return `<span class="chip">
      <button type="button" class="chip-main" data-tpl="${i}" style="all:unset;cursor:pointer">★ ${escapeHtml(t.name)} <small>${t.items.length} items · ${kcal} kcal</small></button>
      <button type="button" class="icon-btn" data-tpldel="${i}" aria-label="Delete usual ${escapeAttr(t.name)}" title="Delete usual">${uiIcon('trash', 15)}</button>
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
      // A usual is a saved bundle of ingredients — re-weighed on each log like any repeat, so
      // the same meal at a different portion stays accurate.
      logRepeat({ name: t.name, kind: 'dish', items: t.items });
    };
  });
  renderOfflineLibraryButton();
}

// ---- MICRONUTRIENTS: recovery-focused panel with under/over flags ----
// The reference table lives in core.js (LedgerCore.MICRO_REF): the 'core' set is what USDA
// foods populate and is always shown once any food is logged; the rest are supplement-only
// and appear only on days a logged supplement supplies them. 'limit' nutrients (sodium,
// sugar) flag high; the rest flag low. General adult references, not medical advice.
// Averaging windows for the panel. 'today' is the live per-day view; the rest are trailing
// rolling averages so a nutrient that is consistently short reads apart from a single off day.
// Weekly is the default — one bad day barely moves it, a real shortfall persists.
const MICRO_WINDOWS = [
  { id:'today', label:'Today', days:1  },
  { id:'7',     label:'Week',  days:7  },
  { id:'14',    label:'2 Wks', days:14 },
  { id:'30',    label:'Month', days:30 }
];
const MICRO_WIN_KEY = 'micro_window';
function microWindowId(){
  try { const v = localStorage.getItem(MICRO_WIN_KEY); if (MICRO_WINDOWS.some(w=>w.id===v)) return v; } catch(e){}
  return '7';                                   // default: weekly rolling average
}
function setMicroWindowId(v){ try { localStorage.setItem(MICRO_WIN_KEY, v); } catch(e){} }

// Every closed day's food+supplement micronutrient totals, for the rolling averages. The open
// (live) day is left out on purpose — its partial intake would drag the average down all day;
// a day counts once it is closed. A past day being viewed is overlaid with its edited ledger.
function microDaysSeries(){
  const sl = suppLog(), sp = supps();
  return closedDays().map(d=>{
    const m = totalsOf(d.ledger);
    const sm = LedgerCore.sumSuppMicros(sp, sl[d.date] || []);
    for (const k in sm) m[k] = (m[k]||0) + sm[k];
    return { date: d.date, micros: m, coverage: microCoverageOf(d.ledger) };
  });
}

function renderMicros(t){
  const wrap = document.getElementById('microLine');
  // Preserve the disclosure's open state across the rebuild — the user opening the panel to
  // switch windows should not have it snap shut under their thumb on the next render.
  const prior = wrap.querySelector('details');
  const wasOpen = prior ? prior.open : false;

  const sex = PROFILE.sex==='female' ? 'f' : 'm';
  const winId = microWindowId();
  const win = MICRO_WINDOWS.filter(w=>w.id===winId)[0] || MICRO_WINDOWS[1];
  const avgMode = winId !== 'today';

  // Today's own values (also the fallback data-presence check in per-day mode).
  const suppToday = LedgerCore.sumSuppMicros(supps(), suppLog()[VIEW_DATE] || []);
  const todayVal = mi => (t[mi.key]||0) + (suppToday[mi.key]||0);
  const todayHas = LedgerCore.MICRO_REF.some(mi => todayVal(mi) > 0);
  const todayCoverage = microCoverageOf(ledger);

  const series = avgMode ? microDaysSeries() : [];
  const stats  = avgMode ? LedgerCore.microAverages(series, VIEW_DATE, win.days, LedgerCore.MICRO_KEYS) : null;
  const histHas = avgMode && stats.loggedDays > 0;

  // Hide entirely only when there is nothing to say: no micros today and, in an average
  // window, no closed days at all to draw from.
  if (avgMode ? !series.length : !todayHas){ wrap.hidden = true; return; }

  const valOf = avgMode
    ? (mi => stats.byKey[mi.key] ? stats.byKey[mi.key].avg : 0)
    : todayVal;

  const tone  = { ok:'met', near:'warn', over:'over', low:'warn', verylow:'over', na:'' };
  const badge = { over:'over', verylow:'very low', low:'low', near:'near limit', ok:'', na:'' };
  const training = !avgMode && isTrainingDay(VIEW_DATE);

  let low=0, over=0, fromSupp=0, body, summary;
  if (avgMode && !histHas){
    summary = `${win.label} avg · no closed days`;
    body = `<div class="tactical">No completed days in the last ${win.days} to average yet — a day counts toward the average once it's closed. Switch to <b>Today</b> for today's intake.</div>`;
  } else {
    // Core micros always show; extras only when the active window actually surfaces one.
    const ref = LedgerCore.MICRO_REF.filter(mi => mi.core || valOf(mi) > 0);
    const rows = ref.map(mi=>{
      const val = valOf(mi), target = mi[sex];
      const covObj = avgMode ? (stats.byKey[mi.key]||{}) : (todayCoverage[mi.key]||{});
      const coverage = avgMode ? covObj.coverage
        : (covObj.totalKcal>0 ? covObj.knownKcal/covObj.totalKcal : null);
      const covered = coverage == null || coverage >= .7;
      const rawStatus=LedgerCore.microStatus(val,target,mi.limit);
      // Partial data can prove a floor was reached or a limit was approached/exceeded;
      // it cannot prove that a floor was missed or that a limit was safely stayed under.
      const status=covered?rawStatus:(mi.limit
        ? (rawStatus==='near'||rawStatus==='over'?rawStatus:'na')
        : (rawStatus==='ok'?'ok':'na'));
      if (status==='low'||status==='verylow') low++;
      if (status==='over') over++;
      const w = Math.min(100, target>0 ? val/target*100 : 0);
      const shown = val<10 ? val.toFixed(1) : Math.round(val);
      let tag = '';
      if (!avgMode){
        const supped = (suppToday[mi.key]||0) > 0;
        if (supped){ fromSupp++; tag = ` <span class="micro-supp" title="Includes ${Math.round(suppToday[mi.key])}${mi.unit} from supplements logged this day">＋supp</span>`; }
        if (training && mi.rec) tag = ' ⚡' + tag;
      } else {
        // A bare count for nutrients only some days supplied (mostly supplement-only extras),
        // so "on 2 of 7 days" reads apart from one present daily — the average still divides
        // by every logged day, which is what makes a rarely-taken pill read as a low average.
        const n = stats.byKey[mi.key] ? stats.byKey[mi.key].n : 0;
        if (n>0 && n < stats.loggedDays) tag = ` <span class="micro-supp" title="Supplied on ${n} of ${stats.loggedDays} logged days">${n}/${stats.loggedDays}d</span>`;
      }
      if (coverage != null && coverage < .999)
        tag += ` <span class="micro-supp" title="Nutrition sources cover ${Math.round(coverage*100)}% of logged calories for this nutrient">${Math.round(coverage*100)}% covered</span>`;
      const flag = (badge[status] ? ` · ${badge[status]}` : '') + (!covered?' · partial data':'');
      const cls = tone[status] === 'over' ? 'over' : (tone[status] === 'warn' ? 'warn' : '');
      return `<div class="micro-row">
        <span class="micro-name">${mi.name}${tag}</span>
        <span class="micro-bar"><span class="${tone[status]}" style="width:${w}%"></span></span>
        <span class="micro-val ${cls}">${shown}<small>/${target}${mi.unit}${flag}</small></span>
      </div>`;
    }).join('');
    const trouble = (low||over)
      ? [low?`${low} low`:'', over?`${over} over`:''].filter(Boolean).join(' · ')
      : 'all on target';
    summary = avgMode ? `${win.label} avg · ${trouble}` : trouble;

    const recNote = training
      ? `<div class="tactical" style="margin-top:10px">⚡ ${escapeHtml(splitForDate(VIEW_DATE))} day — potassium, magnesium, sodium &amp; vitamin C support recovery; keep these topped up.</div>`
      : '';
    const caption = avgMode
      ? `${win.label} rolling average over ${stats.loggedDays} logged day${stats.loggedDays===1?'':'s'} of the last ${win.days}. Each nutrient reports how much of logged food its source data actually covers; below 70%, an apparent shortfall or safe limit is marked partial rather than treated as fact. Supplements are included.`
      : `${fromSupp ? 'Food-source coverage plus logged supplements (shown with ＋supp, in elemental amounts).' : 'Food-source coverage is shown per nutrient.'} Below 70%, apparent shortfalls are marked partial, so missing source data is not mistaken for a dietary deficiency.`;
    body = `${rows}${recNote}
      <div class="tactical" style="margin-top:12px">${caption} Sodium and both sugars are limits. <b>Free sugar</b> is the added/juice/syrup share worth cutting — the natural sugar in whole fruit, vegetables and milk isn't counted; <b>total sugar</b> is everything. General references, not medical advice.</div>`;
  }

  const control = `<div class="micro-window" role="group" aria-label="Averaging window">` +
    MICRO_WINDOWS.map(w=>`<button type="button" class="mw-btn${w.id===winId?' on':''}" data-mwin="${w.id}" aria-pressed="${w.id===winId}">${w.label}</button>`).join('') +
    `</div>`;

  wrap.hidden = false;
  wrap.innerHTML = `<details${wasOpen?' open':''}><summary class="panel-title">Micronutrients · ${summary}</summary>
    <div style="margin-top:12px">${control}${body}</div></details>`;
  wrap.querySelectorAll('[data-mwin]').forEach(b=>{
    b.onclick = ()=>{ setMicroWindowId(b.getAttribute('data-mwin')); renderMicros(totals()); };
  });
}

