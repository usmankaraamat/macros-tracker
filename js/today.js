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

// ---- the gauge (signature element) ----------------------------------------
// Domain runs 0 .. CEIL*1.15 so a ceiling breach is always visible on the arc.
function scaleMaxKcal(){ return CEIL * 1.15; }
function scalePct(x){ return Math.min(100, Math.max(0, x / scaleMaxKcal() * 100)); }

// Radial-gauge geometry: a 270° sweep starting bottom-left (135°), running
// clockwise to bottom-right, drawn with stroke-dasharray on rotated circles.
// GA_VIS is the arc length of the visible sweep; a value's fraction of the
// domain maps onto it.
const GA_R = 82, GA_CX = 100, GA_CY = 100, GA_START = 135, GA_SWEEP = 270;
const GA_C = 2 * Math.PI * GA_R;
const GA_VIS = GA_C * (GA_SWEEP / 360);
function gaugeFrac(kcal){ return Math.max(0, Math.min(1, kcal / scaleMaxKcal())); }
// Point on the arc at fraction f (0..1 of the sweep), at radius r.
function gaugePoint(f, r){
  const th = (GA_START + f * GA_SWEEP) * Math.PI / 180;
  return [GA_CX + r * Math.cos(th), GA_CY + r * Math.sin(th)];
}
// A progress-style arc from 0 to frac on a circle element.
function setArc(el, frac){ if (el) el.setAttribute('stroke-dasharray', `${Math.max(0, frac) * GA_VIS} ${GA_C}`); }
// A band segment [from,to] (fractions of the sweep) on a circle element.
function setBand(el, from, to){
  if (!el) return;
  const s = Math.max(0, from) * GA_VIS, len = Math.max(0, to - from) * GA_VIS;
  el.setAttribute('stroke-dasharray', `0 ${s} ${len} ${GA_C}`);
}

// A ghost arc from current intake to a projected intake — driven by the meal
// composer while the grams field holds a value (see app.js).
function setGaugeProjection(kcal){
  const el = document.getElementById('projCursor');
  if (!el) return;
  if (kcal == null){ el.style.display = 'none'; return; }
  const cur = gaugeFrac(totals().kcal), proj = gaugeFrac(kcal);
  if (proj <= cur){ el.style.display = 'none'; return; }
  setBand(el, cur, proj);
  el.style.display = '';
}

let _lastCorridorKey = '';
function renderInstrument(t){
  const st = corridorState(t.kcal);
  const inst = document.getElementById('instrument');
  const max = scaleMaxKcal();
  const valFrac = gaugeFrac(t.kcal);
  const floorFrac = Math.max(0, Math.min(1, FLOOR / max));
  const ceilFrac  = Math.max(0, Math.min(1, CEIL / max));

  // Track spans the whole sweep; the good zone spans floor→ceiling; progress runs
  // 0→current in the state colour.
  const track = document.querySelector('.g-track');
  if (track) track.setAttribute('stroke-dasharray', `${GA_VIS} ${GA_C}`);
  setBand(document.getElementById('gaugeZone'), floorFrac, ceilFrac);
  const prog = document.getElementById('gaugeProg');
  setArc(prog, valFrac);
  // SVG elements need setAttribute('class', …) — the .className property is read-only there.
  if (prog) prog.setAttribute('class', 'g-prog is-' + st.key);

  // Rounded cap at the arc tip, echoing the reference gauge; hidden when empty.
  const cap = document.getElementById('gaugeCap');
  if (cap){
    if (valFrac > 0.005){
      const [cx, cy] = gaugePoint(valFrac, GA_R);
      cap.setAttribute('cx', cx.toFixed(2)); cap.setAttribute('cy', cy.toFixed(2));
      cap.setAttribute('class', 'g-cap is-' + st.key); cap.style.display = '';
    } else cap.style.display = 'none';
  }

  // Centre: the percentage of the ceiling is the headline the user asked for.
  const pct = CEIL > 0 ? Math.round(t.kcal / CEIL * 100) : 0;
  const readout = document.getElementById('readout');
  readout.innerHTML = `${pct}<span class="g-unit">%</span>`;
  readout.className = 'g-pct is-' + (t.kcal < 1 ? 'empty' : st.key);
  const kcalLine = document.getElementById('gaugeKcal');
  if (kcalLine) kcalLine.textContent = `${Math.round(t.kcal).toLocaleString()} / ${Math.round(CEIL).toLocaleString()} kcal`;

  const stamp = document.getElementById('verdictStamp');
  stamp.textContent = st.label;
  stamp.className = 'g-verdict is-' + (t.kcal < 1 ? 'empty' : st.key);

  // Sub-line: distance to floor, then to ceiling once the floor is met; plus the
  // auto-TDEE note when a goal is driving the corridor.
  let sub;
  if (t.kcal < FLOOR)      sub = `${Math.round(FLOOR - t.kcal).toLocaleString()} kcal to floor (${Math.round(FLOOR).toLocaleString()})`;
  else if (t.kcal <= CEIL) sub = `${Math.round(CEIL - t.kcal).toLocaleString()} kcal to ceiling`;
  else                     sub = `${Math.round(t.kcal - CEIL).toLocaleString()} kcal over ceiling`;
  if (CORRIDOR_AUTO){
    const dayTxt = CORRIDOR_AUTO.cycled
      ? ` · ${CORRIDOR_AUTO.training ? CORRIDOR_AUTO.split + ' day' : 'rest day'} ${CORRIDOR_AUTO.off >= 0 ? '+' : ''}${CORRIDOR_AUTO.off}`
      : '';
    sub += `  ·  auto ${GOAL_LABEL[GOAL.mode]}${dayTxt}, TDEE ${CORRIDOR_AUTO.tdee.toLocaleString()}`;
  }
  document.getElementById('readoutSub').textContent = sub;

  // Meter semantics for assistive tech, with the whole reading spoken.
  const scale = document.getElementById('scale');
  scale.setAttribute('aria-valuemin', '0');
  scale.setAttribute('aria-valuemax', String(Math.round(max)));
  scale.setAttribute('aria-valuenow', String(Math.round(t.kcal)));
  scale.setAttribute('aria-valuetext',
    `${Math.round(t.kcal)} kcal, ${pct}% of ceiling, ${st.label}. Floor ${Math.round(FLOOR)}, ceiling ${Math.round(CEIL)}. ${sub}.`);

  // Crossing into breach flashes the card once — not on a re-render while over.
  const key = st.key + '|' + VIEW_DATE;
  if (st.key === 'breach' && _lastCorridorKey && _lastCorridorKey !== key && !prefersReducedMotion()){
    inst.classList.remove('breached'); void inst.offsetWidth; inst.classList.add('breached'); haptic(40);
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
  // Pace shows as a short radial tick across the arc band, at the expected fraction.
  const pf = gaugeFrac(paceKcal);
  const [ix, iy] = gaugePoint(pf, GA_R - 9), [ox, oy] = gaugePoint(pf, GA_R + 9);
  mark.setAttribute('x1', ix.toFixed(2)); mark.setAttribute('y1', iy.toFixed(2));
  mark.setAttribute('x2', ox.toFixed(2)); mark.setAttribute('y2', oy.toFixed(2));
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

// ---- macro rows ------------------------------------------------------------
// Cards became rows: the protein floor and the optional caps are the same shape,
// read top to bottom, and no longer wrap awkwardly on a narrow phone.
function renderMacros(t){
  const rows = [];

  // Protein is a floor — the bar fills toward a target you want to reach, so the
  // headline % is progress to that floor and the bar goes green once it's met.
  const pFrac = P_TARGET > 0 ? t.p / P_TARGET : 0;
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
    name: 'Protein', qual: `${Math.round(P_TARGET)} g floor`, hue: 'm-protein',
    pctText: P_TARGET > 0 ? `${Math.round(pFrac*100)}%` : null,
    value: P_TARGET > 0 ? `${t.p.toFixed(0)} / ${Math.round(P_TARGET)} g` : `${t.p.toFixed(0)} g`,
    tone: P_TARGET > 0 && pFrac < 0.7 ? 'short' : '',
    frac: P_TARGET > 0 ? pFrac : null,
    barTone: pFrac >= 1 ? 'met' : (pFrac >= 0.7 ? '' : 'warn'),
    note: pNote
  }));

  // Carbs and fat are caps — the bar fills toward a limit you want to stay under,
  // so the headline % is share of the cap used and the bar reddens once over.
  [['Carbs', t.c, C_CAP, 4, 'm-carbs'], ['Fat', t.f, F_CAP, 9, 'm-fat']].forEach(([name, val, cap, kcalPerG, hue])=>{
    const max = capGrams(cap, kcalPerG);
    const macroKcal = (t.p*4 + t.c*4 + t.f*9) || 1;
    const pctKcal = Math.round(val * kcalPerG / macroKcal * 100);
    const fat = name === 'Fat' ? fatBreakdown(t) : null;
    if (!max){
      rows.push(macroRow({ name, hue, qual: `${pctKcal}% of kcal`,
        pctText: null, value: `${val.toFixed(0)} g`, frac: null,
        sub: fat && fat.text, subTone: fat && fat.tone }));
      return;
    }
    const frac = val / max;
    rows.push(macroRow({
      name, hue, qual: `${Math.round(max)} g cap`,
      pctText: `${Math.round(frac*100)}%`,
      value: `${val.toFixed(0)} / ${Math.round(max)} g`,
      tone: frac > 1 ? 'over' : '',
      frac, barTone: frac > 1 ? 'over' : (frac >= 0.85 ? 'warn' : ''),
      note: frac > 1 ? `${Math.round(val - max)} g over the cap` : '',
      sub: fat && fat.text, subTone: fat && fat.tone
    }));
  });

  document.getElementById('macroRows').innerHTML = rows.join('');
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
function macroRow(o){
  const groove = o.frac == null ? '' :
    `<span class="macro-groove ${o.hue||''}"><span class="${o.barTone||''}" style="width:${Math.min(100, o.frac*100)}%"></span></span>`;
  const note = o.note ? `<span class="macro-note">${escapeHtml(o.note)}</span>` : '';
  const sub = o.sub ? `<span class="macro-note ${o.subTone||''}">${escapeHtml(o.sub)}</span>` : '';
  // The headline is the percentage when there's a target; the grams ride along small.
  const head = o.pctText != null
    ? `${o.pctText}<small>${escapeHtml(o.value)}</small>`
    : `${escapeHtml(o.value)}${o.unit ? `<small>${escapeHtml(o.unit)}</small>` : ''}`;
  const qual = o.qual ? ` <small>${escapeHtml(o.qual)}</small>` : '';
  return `<div class="macro-row">
    <span class="macro-name">${escapeHtml(o.name)}${qual}</span>
    <span class="macro-val ${o.tone||''}">${head}</span>
    ${groove}${note}${sub}
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
  const row = (e,i)=>{
    const badge = (e.source && e.source !== 'DB')
      ? `<span class="badge ${e.source === 'USDA' ? 'usda' : 'est'}">${escapeHtml(e.source)}</span>` : '';
    const flags = e.flags && e.flags.length
      ? `<span class="flags">${escapeHtml(e.flags.join(' · '))}</span>` : '';
    // Row actions are real buttons with accessible names — the old ✕/✎ spans
    // were unreachable by keyboard and far too small to hit reliably.
    return `<tr${e.partOf ? ' class="of-dish"' : ''}>
      <td>
        ${badge}<span class="ename">${escapeHtml(e.name)}</span><span class="egrams">${e.grams}g</span><span class="row-actions">
          <button type="button" class="edit" data-edit="${i}" aria-label="Edit grams for ${escapeAttr(e.name)}" title="Edit grams">✎</button>
          <button type="button" class="del" data-del="${i}" aria-label="Remove ${escapeAttr(e.name)}" title="Remove">✕</button>
        </span>${flags}
      </td>
      <td>${Math.round(e.kcal)}</td><td>${e.p.toFixed(1)}</td><td>${e.f.toFixed(1)}</td><td>${(e.c||0).toFixed(1)}</td>
    </tr>`;
  };
  // A decomposed dish is one meal, so it reads as one block with its own total. The
  // components stay individually editable — the grouping is presentational, which is
  // what keeps a wrong gram estimate on the rice fixable without unpicking the biryani.
  const html = [];
  for (let i = 0; i < ledger.length; i++){
    const dish = (ledger[i].partOf || '').trim();
    if (!dish){ html.push(row(ledger[i], i)); continue; }
    let j = i;
    while (j < ledger.length && (ledger[j].partOf || '').trim() === dish) j++;
    const part = ledger.slice(i, j);
    const sum = part.reduce((s,e)=>({ kcal:s.kcal+e.kcal, p:s.p+e.p, f:s.f+e.f, c:s.c+(e.c||0) }),
                            {kcal:0,p:0,f:0,c:0});
    html.push(`<tr class="dish-head">
      <td><span class="dish-name">🍽️ ${escapeHtml(dish)}</span>
          <span class="dish-meta">${part.length} ingredient${part.length>1?'s':''} · ${Math.round(part.reduce((s,e)=>s+(+e.grams||0),0))}g</span></td>
      <td>${Math.round(sum.kcal)}</td><td>${sum.p.toFixed(1)}</td><td>${sum.f.toFixed(1)}</td><td>${sum.c.toFixed(1)}</td>
    </tr>`);
    part.forEach((e,k)=> html.push(row(e, i + k)));
    i = j - 1;
  }
  body.innerHTML = html.join('');

  // Settle only the row(s) added since the last render — a quiet "logged" confirmation.
  // Keyed off the entry index rather than row position: dish headers mean the table
  // now has more rows than the ledger has entries.
  if (ledger.length > _prevLedgerLen && !prefersReducedMotion()){
    for (let i = _prevLedgerLen; i < ledger.length; i++){
      const btn = body.querySelector(`[data-edit="${i}"]`);
      const tr = btn && btn.closest('tr');
      if (tr) tr.classList.add('rowNew');
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
  const next = computeEntry(e.name, g, e.weighed, base, e.source, e.partOf);
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
  else if (ACTIVE_TAB === 'logs')   renderLogsTab();
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

// ---- REPEATS: what you have eaten before, offered as one tap -----------------
// Mined as MEALS, not ingredients. Decomposition means the raw ledger is full of
// "Sugar, NFS" and "Vegetable oil, NFS" — real rows, but nothing anyone wants to
// repeat. LedgerCore.mineRepeats regroups each day by dish first, and drops bulk
// import rows, which otherwise take the top slot with a whole day's calories
// wearing a food's name.
function repeatUnits(n){ return LedgerCore.mineRepeats(allDays(true), {limit: n}); }
function repeatChipHTML(u, attr, i){
  const label = u.kind === 'dish'
    ? `🍽️ ${escapeHtml(u.name)} <small>${u.items.length} items</small>`
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
  if (!list.length){ wrap.hidden = true; wrap.innerHTML=''; syncAddPanel(); return; }
  wrap.hidden = false;
  syncAddPanel();
  wrap.innerHTML = list.map((t,i)=>{
    const kcal = Math.round(t.items.reduce((s,e)=> s + (e.base ? computeEntry(e.name,e.grams,e.weighed,e.base,e.source,e.partOf).kcal : 0), 0));
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
      // A usual is a saved bundle of ingredients — re-weighed on each log like any repeat, so
      // the same meal at a different portion stays accurate.
      logRepeat({ name: t.name, kind: 'dish', items: t.items });
    };
  });
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
    return { date: d.date, micros: m };
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
      const status = LedgerCore.microStatus(val, target, mi.limit);
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
      const flag = badge[status] ? ` · ${badge[status]}` : '';
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
      ? `${win.label} rolling average over ${stats.loggedDays} logged day${stats.loggedDays===1?'':'s'} of the last ${win.days}. A bar under target here means the nutrient is <i>consistently</i> short, not a one-off; counted from USDA-matched foods plus any supplements logged each day. AI estimates and older entries add nothing, so a low reading can mean under-<i>tracked</i> rather than under-eaten.`
      : `${fromSupp ? 'Counted from USDA-matched foods plus the supplements you logged today (shown with ＋supp, in elemental amounts).' : 'Counted from USDA-matched foods only'} — AI estimates and older entries add nothing, so a low reading can mean under-<i>tracked</i> rather than under-eaten.`;
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

