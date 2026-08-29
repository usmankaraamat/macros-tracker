// trends.js -- The Trends view: history, rolling averages, compliance heatmap,
// weight/TDEE/goal, fat-change estimate, and the weekly report card.

// ---- HISTORY PANEL ----
// ---- Per-day corridor bounds -------------------------------------------------
// The corridor is not one pair of numbers. With training/rest cycling on, a session
// day's ceiling sits hundreds of kcal above a rest day's, so every question of the
// form "was this day inside?" has to be asked against the corridor that applied to
// THAT day. Asking it against today's bounds reads a working schedule as a miss.
//
// computeTDEE walks the whole history, so the closure is built once and cached until
// render() invalidates it.
let _boundsFn = null;
function invalidateBounds(){ _boundsFn = null; }
function dayBounds(){
  if (_boundsFn) return _boundsFn;
  const td = GOAL.mode !== 'off' ? computeTDEE() : null;
  const live = td && td.blended > 0 ? td.blended : null;
  _boundsFn = date => {
    if (!live) return { floor: FLOOR_M, ceil: CEIL_M, tdee: null };
    const off = TRAIN.cycle
      ? (isTrainingDay(date) ? (+TRAIN.trainOffset||0) : (+TRAIN.restOffset||0))
      : goalOffset();
    const c = LedgerCore.corridorFromTDEE(live, off, GOAL.band||100);
    return { floor: c.floor, ceil: c.ceil, tdee: live };
  };
  return _boundsFn;
}
// A day is "ok" against its own corridor. `date` is optional only so a caller with
// totals and no date still gets the old behaviour rather than a crash.
function dayOk(t, date){
  const b = date ? dayBounds()(date) : { floor: FLOOR, ceil: CEIL };
  return t.kcal >= b.floor && t.kcal <= b.ceil && t.p >= P_TARGET;
}
function renderHistSummary(){
  const el = document.getElementById('histSummary');
  // Most recent CLOSED days (the open day is excluded so its running total doesn't
  // swing the average as the user eats), newest first.
  const all = closedDays();
  if (!all.length){ el.hidden = true; return; }
  const week = all.slice(0,7).map(d=>({date:d.date, t:totalsOf(d.ledger)}));
  const avgK = week.reduce((s,x)=>s+x.t.kcal,0)/week.length;
  const avgP = week.reduce((s,x)=>s+x.t.p,0)/week.length;
  const okN = week.filter(x=>dayOk(x.t, x.date)).length;
  let streak = 0;
  for (const d of all){ if (dayOk(totalsOf(d.ledger), d.date)) streak++; else break; }
  el.hidden = false;
  el.textContent = `Last ${week.length} logged ${week.length>1?'days':'day'}: avg ${Math.round(avgK)} kcal · ${avgP.toFixed(0)}g protein · ${okN} of ${week.length} on target` + (streak>1 ? ` · ${streak}-day streak` : '');
}
function renderHistory(){
  renderHistSummary();
  const wrap = document.getElementById('histList');
  const days = closedDays();
  if (!days.length){ wrap.innerHTML = '<div class="empty">No previous days yet.</div>'; return; }
  const B = dayBounds();
  wrap.innerHTML = days.map((d,di)=>{
    const t = totalsOf(d.ledger), b = B(d.date);
    const inC = t.kcal >= b.floor && t.kcal <= b.ceil;
    const pOk = t.p >= P_TARGET;
    const mark = inC && pOk ? '<span style="color:var(--verdigris)">✓</span>'
               : t.kcal > b.ceil ? '<span style="color:var(--hot)">✗</span>'
               : '<span style="color:var(--brass)">△</span>';
    const rows = d.ledger.map(e=>
      `<tr><td>${escapeHtml(e.name)} <small style="color:var(--faint)">${e.grams}g</small></td>`+
      `<td>${Math.round(e.kcal)}</td><td>${(e.p||0).toFixed(1)}</td><td>${(e.f||0).toFixed(1)}</td><td>${(e.c||0).toFixed(1)}</td></tr>`).join('');
    return `<details class="hist-day">
      <summary><span class="hd-date">${d.date}</span>
        <span>${Math.round(t.kcal)} kcal · P ${t.p.toFixed(0)}g</span>
        <span class="hd-mark">${mark}</span>
        <button type="button" class="sm ghost" data-rep="${di}" aria-label="Copy ${d.date} into the day on screen">Repeat</button>
        <button type="button" class="sm ghost" data-editday="${d.date}" aria-label="Open ${d.date} for editing">Open</button>
      </summary>
      <div class="hd-body"><table>
        <thead><tr><th>Item</th><th>kcal</th><th>P</th><th>F</th><th>C</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </details>`;
  }).join('');
  wrap.querySelectorAll('button[data-rep]').forEach(btn=>{
    btn.onclick = (ev)=>{
      ev.preventDefault(); ev.stopPropagation();          // don't toggle the <details>
      const d = days[+btn.dataset.rep];
      const before = ledger.slice();
      let added = 0;
      d.ledger.forEach(e=>{
        const base = e.base || DB[e.name];
        if (!base) return;
        if (e.base) registerFood(e.name, e.base, e.source);
        pushEntry(computeEntry(e.name, e.grams, e.weighed, base, e.source, e.partOf));
        added++;
      });
      if (!added){ toast(`Nothing on ${d.date} has usable nutrition data.`, { tone:'warn' }); return; }
      haptic(); save(); render();
      toast(`Copied ${added} ${added === 1 ? 'entry' : 'entries'} from ${d.date}`,
        { undo: ()=>{ ledger = before; save(); render(); } });
    };
  });
  wrap.querySelectorAll('button[data-editday]').forEach(btn=>{
    btn.onclick = (ev)=>{
      ev.preventDefault(); ev.stopPropagation();          // don't toggle the <details>
      viewDay(btn.dataset.editday);
      window.scrollTo({top:0, behavior:'smooth'});
    };
  });
}

// ---- WEIGHT: daily weigh-in, trend, and corridor cross-check ----------------
// Stored as {date: kg} with per-date stamps so it merges across devices exactly
// like ledger days (reuses mergeSyncStates in the sync cycle).
function weightsMap(){ try{ return JSON.parse(localStorage.getItem('ledger_weights')||'{}'); }catch(e){ return {}; } }
function weightsMeta(){ try{ return JSON.parse(localStorage.getItem('ledger_weights_meta')||'{}'); }catch(e){ return {}; } }
function saveWeights(map, meta){
  try{ localStorage.setItem('ledger_weights', JSON.stringify(map));
       localStorage.setItem('ledger_weights_meta', JSON.stringify(meta)); }catch(e){}
}
document.getElementById('wSaveBtn').onclick = ()=>{
  const v = parseFloat(document.getElementById('wIn').value);
  if (!v || v <= 0){ document.getElementById('wIn').focus(); return; }
  const map = weightsMap(), meta = weightsMeta();
  map[VIEW_DATE] = v; meta[VIEW_DATE] = new Date().toISOString();
  saveWeights(map, meta); scheduleSync(); renderWeight(); renderWeightLog(); renderTDEE(); renderFatEstimate();
  // A new bodyweight changes the fat/lean split, whose card lives on Logs.
  if (typeof renderBodyFat === 'function') renderBodyFat();
};
document.getElementById('wIn').addEventListener('keydown', e=>{ if (e.key==='Enter') document.getElementById('wSaveBtn').click(); });
// Maintenance band rides with the targets bundle (persists + syncs); dates are ephemeral.
['maintLow','maintHigh'].forEach(id=>{
  document.getElementById(id).addEventListener('change', ()=>{
    MAINT = { min:+document.getElementById('maintLow').value||0, max:+document.getElementById('maintHigh').value||0 };
    saveTargets(); renderFatEstimate();
  });
});
['fatStart','fatEnd'].forEach(id=> document.getElementById(id).addEventListener('change', renderFatEstimate));
// Body profile → TDEE, also synced via the targets bundle.
['pfSex','pfAge','pfHeight','pfActivity','pfTrendStart'].forEach(id=>{
  document.getElementById(id).addEventListener('change', ()=>{
    PROFILE = { sex:document.getElementById('pfSex').value==='female'?'female':'male',
                age:+document.getElementById('pfAge').value||0,
                height:+document.getElementById('pfHeight').value||0,
                activity:document.getElementById('pfActivity').value };
    TREND_START = document.getElementById('pfTrendStart').value || '';
    // The corridor is derived from the TDEE, so this has to be a full render, not just
    // a readout refresh — the floor and ceiling move the moment the window changes.
    saveTargets(); render(); renderFatEstimate();
  });
});
// Goal → drives the adaptive corridor. Presets set the offset; custom uses the input.
document.getElementById('goalMode').addEventListener('change', ()=>{
  GOAL.mode = document.getElementById('goalMode').value;
  if (GOAL.mode!=='custom' && GOAL.mode!=='off') GOAL.offset = GOAL_OFFSET[GOAL.mode]||0;
  saveTargets(); render();
});
document.getElementById('goalOffset').addEventListener('change', ()=>{
  GOAL.offset = +document.getElementById('goalOffset').value||0; saveTargets(); render();
});
document.getElementById('briefClose').onclick = ()=>{ document.getElementById('briefCard').hidden = true; };
// CSV export of the full daily log — date, weight, calories, macros, micros.
document.getElementById('csvBtn').onclick = ()=>{
  const map=weightsMap(), tot={};
  allDays(true).forEach(d=>{ tot[d.date]=totalsOf(d.ledger); });
  const dates=Array.from(new Set(Object.keys(map).concat(Object.keys(tot))))
    .filter(d=>(+map[d]>0)||(tot[d]&&tot[d].kcal>0)).sort();
  if (!dates.length){ toast('Nothing logged yet to export.'); return; }
  const rows=[['date','weight_kg','kcal','protein_g','carbs_g','fat_g','sat_fat_g','unsat_fat_g','fiber_g','free_sugar_g','total_sugar_g','sodium_mg']];
  dates.forEach(d=>{ const t=tot[d]||{}; rows.push([ d,
    +map[d]>0?(+map[d]).toFixed(1):'', t.kcal?Math.round(t.kcal):'', t.p?t.p.toFixed(1):'',
    t.c?t.c.toFixed(1):'', t.f?t.f.toFixed(1):'', t.sfa?t.sfa.toFixed(1):'', t.ufa?t.ufa.toFixed(1):'',
    t.fib?t.fib.toFixed(1):'', t.fsug?t.fsug.toFixed(1):'', t.sug?t.sug.toFixed(1):'', t.na?Math.round(t.na):'' ]); });
  const csv=rows.map(r=>r.join(',')).join('\r\n');
  const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=`ledger_log_${ACTIVE_DATE}.csv`; a.click(); URL.revokeObjectURL(url);
};
// ---- the two trend charts --------------------------------------------------
// Weight and intake are drawn over ONE shared date axis and stacked, so a run of
// heavy days and the scale's answer to it line up column for column. Anything
// that only appears in one series still sits at its true date on both.
const TREND_W = 320, TREND_H = 104, TREND_PADL = 6, TREND_PADR = 38,
      TREND_PADT = 12, TREND_PADB = 18, TREND_DAYS = 45;

// Catmull-Rom → cubic-bézier: a smooth curve through the points, so the trend
// lines read as flowing shapes rather than jagged polylines.
function smoothPath(P){
  if (!P.length) return '';
  if (P.length < 3) return P.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  let d = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
  for (let i=0;i<P.length-1;i++){
    const p0=P[i-1]||P[i], p1=P[i], p2=P[i+1], p3=P[i+2]||p2;
    const c1x=p1[0]+(p2[0]-p0[0])/6, c1y=p1[1]+(p2[1]-p0[1])/6;
    const c2x=p2[0]-(p3[0]-p1[0])/6, c2y=p2[1]-(p3[1]-p1[1])/6;
    d+=` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function trendSeries(){
  const map = weightsMap(), tot = {};
  closedDays().forEach(d => { tot[d.date] = totalsOf(d.ledger); });   // open day excluded, as elsewhere
  const dates = Array.from(new Set(Object.keys(map).concat(Object.keys(tot))))
    .filter(d => (+map[d] > 0) || (tot[d] && tot[d].kcal > 0)).sort();
  if (!dates.length) return null;
  // Window the last TREND_DAYS, but never draw empty axis: with three weeks of
  // history the charts should span three weeks, not sit squashed into a corner.
  const end = dates[dates.length - 1];
  // TREND_START is the user saying "before this date the numbers are a diet transition,
  // not my body". Honouring it here as well as in computeTDEE is what stops the charts
  // covering a different span from the readout underneath them — which made the
  // cumulative line dive through a pre-bulk deficit and end somewhere the text never
  // mentioned. Latest of the three wins.
  const start = [addDaysISO(end, -(TREND_DAYS - 1)), dates[0], TREND_START || ''].sort().pop();
  const inWin = d => d >= start && d <= end;
  // Each intake day carries the corridor and the maintenance figure that applied to IT,
  // so the chart can plot balance and colour dots without ever consulting today's bounds.
  const B = dayBounds();
  const k = dates.filter(d => inWin(d) && tot[d] && tot[d].kcal > 0).map(d => {
    const b = B(d);
    // With the goal off there is no TDEE — the declared corridor's midpoint is the only
    // maintenance the user has asserted, so it becomes the reference and is labelled as such.
    const ref = b.tdee != null ? b.tdee : (b.floor + b.ceil) / 2;
    const kcal = tot[d].kcal;
    return { date: d, kcal: kcal, ref: ref, floor: b.floor, ceil: b.ceil,
             state: kcal > b.ceil ? 'over' : kcal < b.floor ? 'under' : 'in' };
  });
  return { start, end, refIsTDEE: !!(k.length && B(k[0].date).tdee != null),
    w: dates.filter(d => inWin(d) && +map[d] > 0).map(d => ({ date:d, kg:+map[d] })),
    k: k };
}
// The shared x-mapping. Both charts call this, which is the whole point.
function trendX(s){
  const t0 = Date.parse(s.start), t1 = Date.parse(s.end);
  const uW = TREND_W - TREND_PADL - TREND_PADR;
  return d => TREND_PADL + (t1 === t0 ? uW/2 : uW * (Date.parse(d) - t0) / (t1 - t0));
}
function trendAxis(s){
  return `<text x="${TREND_PADL}" y="${TREND_H-3}" font-size="9" fill="var(--faint)">${s.start.slice(5)}</text>`
       + `<text x="${TREND_W-2}" y="${TREND_H-3}" text-anchor="end" font-size="9" fill="var(--faint)">${s.end.slice(5)}</text>`;
}
function trendSVG(inner){
  return `<svg viewBox="0 0 ${TREND_W} ${TREND_H}" style="width:100%;display:block">${inner}</svg>`;
}
function weightChartSVG(s, X){
  const pts = s.w;
  if (pts.length < 2) return '';
  const uH = TREND_H - TREND_PADT - TREND_PADB, base = TREND_H - TREND_PADB;
  const kMin = Math.min(...pts.map(p=>p.kg)), kMax = Math.max(...pts.map(p=>p.kg));
  const yPad = Math.max(0.3, (kMax-kMin)*0.15);
  const Y = k => TREND_PADT + uH*(1-(k-kMin+yPad)/((kMax-kMin)+2*yPad));
  const P = pts.map(p=>[X(p.date), Y(p.kg)]);
  const line = smoothPath(P);
  const area = `${line} L${P[P.length-1][0].toFixed(1)},${base} L${P[0][0].toFixed(1)},${base} Z`;
  const last = pts[pts.length-1], lp = P[P.length-1];
  return trendSVG(
    `<defs><linearGradient id="wgGrad" x1="0" x2="0" y1="0" y2="1">`
    + `<stop offset="0" stop-color="var(--accent)" stop-opacity=".32"/>`
    + `<stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>`
    + `<path d="${area}" fill="url(#wgGrad)"/>`
    + `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${lp[0].toFixed(1)}" cy="${lp[1].toFixed(1)}" r="3.4" fill="var(--accent)" stroke="var(--slab)" stroke-width="2"/>`
    + `<text x="${TREND_W-2}" y="${Math.max(11, lp[1]-7).toFixed(1)}" text-anchor="end" font-size="11" font-weight="700" fill="var(--chalk)">${last.kg}kg</text>`
    + trendAxis(s));
}
// Intake as ENERGY BALANCE — the distance from maintenance, not from the goal.
// The old chart plotted raw intake against a flat corridor, which answered "did I hit
// my target" and could not answer "by how much did I clear maintenance". It also drew
// one fixed band across a window whose real bounds move with the training cycle.
//
// Zero is maintenance. Above it is a surplus, below it a deficit, and the corridor is a
// ribbon that follows each day's own bounds — so a bulker reads the same chart as a
// cutter, just on the other side of the line.
function balanceChartSVG(s, X){
  const pts = s.k;
  if (pts.length < 2) return '';
  const uH = TREND_H - TREND_PADT - TREND_PADB;
  const bal = p => p.kcal - p.ref;
  const mags = pts.map(p=>Math.abs(bal(p)))
    .concat(pts.map(p=>Math.abs(p.ceil-p.ref)), pts.map(p=>Math.abs(p.floor-p.ref)));
  // Symmetric about zero so the maintenance line sits mid-chart and the eye reads
  // "how far, which side" without decoding an axis.
  const span = Math.max(300, ...mags) * 1.15;
  const Y = v => TREND_PADT + uH*(1 - (v + span)/(2*span));
  const z = Y(0);
  const top = pts.map(p=>[X(p.date), Y(p.ceil - p.ref)]);
  const bot = pts.map(p=>[X(p.date), Y(p.floor - p.ref)]);
  const pathOf = a => a.map(q=>`${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' L');
  // Straight segments, not a spline: the corridor genuinely steps between training and
  // rest days, and smoothing it would draw a gradual change that never happened.
  const ribbon = `<path d="M${pathOf(top)} L${pathOf(bot.slice().reverse())} Z" fill="var(--accent-wash)"/>`
    + `<path d="M${pathOf(top)}" fill="none" stroke="var(--rule-lit)" stroke-width="1"/>`
    + `<path d="M${pathOf(bot)}" fill="none" stroke="var(--rule-lit)" stroke-width="1"/>`;
  const P = pts.map(p=>[X(p.date), Y(bal(p))]);
  const dots = pts.map((p,i)=>{
    const c = p.state==='over' ? 'var(--hot)' : p.state==='under' ? 'var(--brass)' : 'var(--accent)';
    const r = i===pts.length-1 ? 3.4 : 2.4;
    const ring = i===pts.length-1 ? ` stroke="var(--slab)" stroke-width="2"` : '';
    return `<circle cx="${P[i][0].toFixed(1)}" cy="${P[i][1].toFixed(1)}" r="${r}" fill="${c}"${ring}/>`;
  }).join('');
  const avg = pts.reduce((a,p)=>a+bal(p),0) / pts.length;
  const ya = Y(avg);
  const avgTxt = `${avg>0?'+':'−'}${Math.abs(Math.round(avg)).toLocaleString()}`;
  return trendSVG(
    ribbon
    + `<line x1="${TREND_PADL}" y1="${z.toFixed(1)}" x2="${TREND_W-TREND_PADR}" y2="${z.toFixed(1)}" stroke="var(--rule-lit)" stroke-width="1.5"/>`
    + `<path d="${smoothPath(P)}" fill="none" stroke="var(--graphite)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`
    + `<line x1="${TREND_PADL}" y1="${ya.toFixed(1)}" x2="${TREND_W-TREND_PADR}" y2="${ya.toFixed(1)}" stroke="var(--chalk)" stroke-width="1" opacity=".55"/>`
    + `<text x="${TREND_W-2}" y="${Math.max(10, Math.min(TREND_H-TREND_PADB-2, ya-5)).toFixed(1)}" text-anchor="end" font-size="11" font-weight="700" fill="var(--chalk)">${avgTxt}</text>`
    + trendAxis(s));
}
// The running total of those daily balances. This is the chart that distinguishes one
// big day from a small surplus held for three weeks — the first is a bump, the second
// is the entire bulk. Right-hand label is the same number in kg of fat-equivalent.
function cumChartSVG(s, X){
  const pts = s.k;
  if (pts.length < 2) return '';
  const uH = TREND_H - TREND_PADT - TREND_PADB;
  let run = 0;
  const cum = pts.map(p=>{ run += p.kcal - p.ref; return {date:p.date, v:run}; });
  const lo = Math.min(0, ...cum.map(c=>c.v)), hi = Math.max(0, ...cum.map(c=>c.v));
  const pad = Math.max(200, (hi-lo)*0.12);
  const Y = v => TREND_PADT + uH*(1 - (v - lo + pad)/((hi-lo) + 2*pad));
  const z = Y(0);
  const P = cum.map(c=>[X(c.date), Y(c.v)]);
  const line = smoothPath(P);
  const area = `${line} L${P[P.length-1][0].toFixed(1)},${z.toFixed(1)} L${P[0][0].toFixed(1)},${z.toFixed(1)} Z`;
  const end = cum[cum.length-1].v;
  const tint = end >= 0 ? 'var(--accent)' : 'var(--brass)';
  const kg = (end / 7700).toFixed(2);
  return trendSVG(
    `<defs><linearGradient id="cumGrad" x1="0" x2="0" y1="0" y2="1">`
    + `<stop offset="0" stop-color="${tint}" stop-opacity=".26"/>`
    + `<stop offset="1" stop-color="${tint}" stop-opacity="0"/></linearGradient></defs>`
    + `<path d="${area}" fill="url(#cumGrad)"/>`
    + `<line x1="${TREND_PADL}" y1="${z.toFixed(1)}" x2="${TREND_W-TREND_PADR}" y2="${z.toFixed(1)}" stroke="var(--rule-lit)" stroke-width="1"/>`
    + `<path d="${line}" fill="none" stroke="${tint}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${P[P.length-1][0].toFixed(1)}" cy="${P[P.length-1][1].toFixed(1)}" r="3.4" fill="${tint}" stroke="var(--slab)" stroke-width="2"/>`
    + `<text x="${TREND_W-2}" y="${Math.max(11, P[P.length-1][1]-7).toFixed(1)}" text-anchor="end" font-size="11" font-weight="700" fill="var(--chalk)">${end>0?'+':''}${kg}kg</text>`
    + trendAxis(s));
}
// The readout and the charts above it MUST describe the same span. They used to not:
// the charts ran 45 days while the readout ran 28, so the cumulative line ended at one
// number and the sentence under it quoted another. Deriving both from trendSeries() makes
// them identical by construction rather than by two definitions that agree today.
function balanceNow(){
  const s = trendSeries();
  const eb = LedgerCore.energyBalance(
    (s && s.k ? s.k : []).map(p => ({ date: p.date, kcal: p.kcal, tdee: p.ref, floor: p.floor, ceil: p.ceil })));
  if (!s || !eb.n) return { eb, actualKg: null, check: LedgerCore.balanceCheck(null, null, 0) };
  // Actual weight change over the same span, from the fitted trend rather than
  // first-minus-last — a single puffy morning should not set the verdict.
  const map = weightsMap();
  const w = Object.keys(map).filter(d => +map[d] > 0 && d >= s.start && d <= s.end).sort()
    .map(d => ({ date: d, kg: +map[d] }));
  let actualKg = null, spanDays = 0;
  if (w.length >= 2){
    const tr = LedgerCore.weightTrend(w);
    spanDays = Math.round((Date.parse(w[w.length-1].date) - Date.parse(w[0].date))/86400000) + 1;
    if (tr) actualKg = +(tr.ratePerWeek / 7 * spanDays).toFixed(2);
  }
  // The check is only fair over the days BOTH series cover.
  const nBoth = Math.min(eb.n, spanDays || 0);
  const scaled = (actualKg != null && spanDays > 0) ? +(actualKg * nBoth / spanDays).toFixed(2) : null;
  const predScaled = eb.n > 0 && nBoth > 0 ? +(eb.sum * (nBoth/eb.n) / 7700).toFixed(2) : null;
  return { eb, actualKg: scaled, check: LedgerCore.balanceCheck(predScaled, scaled, nBoth) };
}
// The sentence the user asked for: how far from maintenance, for how long, and what the
// scale says about it. Written to read the same whether the number is positive or negative.
function balanceLine(){
  const { eb, check } = balanceNow();
  if (!eb.n) return '';
  const surplus = eb.avg >= 0;
  const word = surplus ? 'surplus' : 'deficit';
  const mag = Math.abs(eb.avg).toLocaleString();
  const tot = Math.abs(eb.sum).toLocaleString();
  const kg = Math.abs(eb.predictedKg).toFixed(2);
  const ref = dayBounds()(ACTIVE_DATE).tdee != null ? 'maintenance' : 'your corridor midpoint';
  let html = `<b>${eb.n} logged day${eb.n===1?'':'s'}</b>: average <b>${surplus?'+':'−'}${mag} kcal/day</b> `
    + `against ${ref} — a ${word} of <b>${tot} kcal</b> in total, `
    + `which predicts <b>${surplus?'+':'−'}${kg} kg</b>.`;
  if (eb.n >= 3)
    html += ` <span class="ink-dim">${eb.surplusDays} day${eb.surplusDays===1?'':'s'} over ${ref}, `
      + `${eb.deficitDays} under · ${eb.inside}/${eb.n} inside that day's corridor.</span>`;
  if (check.verdict === 'aligned')
    html += ` The scale agrees (<b>${check.actualKg>0?'+':''}${check.actualKg} kg</b> actual) — the TDEE estimate is holding up.`;
  else if (check.verdict === 'tdee-high')
    html += ` The scale moved <b>${check.actualKg>0?'+':''}${check.actualKg} kg</b>, more than predicted. `
      + `Either maintenance is nearer <b>${(currentTDEE()+check.tdeeShift).toLocaleString()}</b> `
      + `(<b>${check.tdeeShift}</b> kcal/day), or intake is being under-logged — from here the two look identical. `
      + `<span class="ink-dim">In a surplus some of the gap is lean tissue and water, which cost far less than 7700 kcal/kg.</span>`;
  else if (check.verdict === 'tdee-low')
    html += ` The scale moved <b>${check.actualKg>0?'+':''}${check.actualKg} kg</b>, less than predicted. `
      + `Either maintenance is nearer <b>${(currentTDEE()+check.tdeeShift).toLocaleString()}</b> `
      + `(<b>+${check.tdeeShift}</b> kcal/day), or intake is being over-logged.`;
  return html;
}
function currentTDEE(){
  const b = dayBounds()(ACTIVE_DATE);
  return b.tdee != null ? Math.round(b.tdee) : Math.round((FLOOR_M + CEIL_M)/2);
}

function renderWeight(){
  document.getElementById('wDate').textContent = VIEW_DATE===ACTIVE_DATE ? 'today' : VIEW_DATE;
  const map = weightsMap();
  const inEl = document.getElementById('wIn');
  if (document.activeElement !== inEl) inEl.value = map[VIEW_DATE] || '';
  const entries = Object.keys(map).sort().map(d=>({date:d, kg:+map[d]})).filter(e=>e.kg>0);
  const chart = document.getElementById('wChart'), kChart = document.getElementById('kcalChart');
  const cChart = document.getElementById('cumChart'), bNote = document.getElementById('balanceNote');
  const stats = document.getElementById('wStats');

  const s = trendSeries();
  const X = s ? trendX(s) : null;
  chart.innerHTML  = s ? (weightChartSVG(s, X)  || '<div class="empty">Two weigh-ins draw the trend.</div>') : '';
  kChart.innerHTML = s ? (balanceChartSVG(s, X) || '<div class="empty">Close two days to draw the balance.</div>') : '';
  cChart.innerHTML = s ? (cumChartSVG(s, X)     || '') : '';
  document.getElementById('wChartCap').textContent = 'Weight · kg';
  const refKcal = s && s.k && s.k.length ? Math.round(s.k[s.k.length-1].ref) : 0;
  document.getElementById('kChartCap').textContent =
    `Each day vs ${s && s.refIsTDEE ? 'maintenance' : 'the corridor midpoint'}` + (refKcal ? ` · ${refKcal.toLocaleString()} kcal` : '');
  const kNote = document.getElementById('kChartCapNote');
  if (kNote && s && s.k && s.k.length){
    kNote.textContent = `Each dot is one day. Above the middle line you ate more than you burn, below it less;`
      + ` the green band is that day's corridor. The pale horizontal line is your average across the window.`;
    kNote.hidden = false;
  } else if (kNote) kNote.hidden = true;
  document.getElementById('cChartCap').textContent = 'Where that has added up to, in kilograms';
  // The two charts confuse people in a specific way: one is a daily rate, the other is
  // a total. Say which is which, in words, right under them.
  const cCap = document.getElementById('cChartCapNote');
  if (cCap && s && s.k && s.k.length){
    const kg = (s.k.reduce((a,p)=>a+(p.kcal-p.ref),0)/7700);
    cCap.textContent = `Every day's surplus or deficit added together, running from the`
      + ` start of this window to now. It ends at ${kg>=0?'+':'−'}${Math.abs(kg).toFixed(2)} kg`
      + ` — that is the whole period's net effect, not a daily figure.`;
    cCap.hidden = false;
  } else if (cCap) cCap.hidden = true;
  const bl = balanceLine();
  bNote.innerHTML = bl;
  bNote.hidden = !bl;

  if (entries.length < 2){
    stats.hidden = false;
    stats.textContent = entries.length ? 'One weigh-in logged — a second gives you a trend.'
                                       : 'Log a morning weight to see whether the corridor is actually moving it.';
    return;
  }
  const last = entries[entries.length-1];
  // Rate over the last ~3 weeks + kcal average over the same window = the verdict.
  const recent = entries.filter(e => (Date.parse(last.date)-Date.parse(e.date))/86400000 <= 21);
  const tr = LedgerCore.weightTrend(recent.length>=2 ? recent : entries);
  stats.hidden = false;
  if (!tr){ stats.textContent = 'Need weigh-ins on different days for a trend.'; return; }
  const days7 = closedDays().slice(0,7);   // the open day's partial intake is not an average
  const avgK = days7.length ? days7.reduce((s,d)=>s+totalsOf(d.ledger).kcal,0)/days7.length : 0;
  const rate = tr.ratePerWeek;
  const dir = Math.abs(rate)<0.05 ? 'holding steady' : (rate<0 ? `losing ${Math.abs(rate).toFixed(2)} kg/wk` : `gaining ${rate.toFixed(2)} kg/wk`);
  stats.innerHTML = `<b>${dir}</b> (last ${recent.length>=2?recent.length:entries.length} weigh-ins)`
    + (avgK ? ` · corridor avg ${Math.round(avgK)} kcal over last ${days7.length} logged day${days7.length>1?'s':''}` : '');
}

// DD/MM/YYYY for the log table (matches how the user reads dates locally).
function fmtDMY(iso){ const p = iso.split('-'); return `${p[2]}/${p[1]}/${p[0]}`; }
function addDaysISO(iso, n){ const dt = new Date(iso+'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate()+n); return dt.toISOString().slice(0,10); }

// Collapsible daily log: every date with a weigh-in or logged food, newest first,
// showing weight and the day's calories with macros in parentheses.
function renderWeightLog(){
  const wrap = document.getElementById('weightLog'); if (!wrap) return;
  const map = weightsMap(), tot = {};
  allDays(true).forEach(d => { tot[d.date] = totalsOf(d.ledger); });
  const dates = Array.from(new Set(Object.keys(map).concat(Object.keys(tot))))
    .filter(d => (+map[d] > 0) || (tot[d] && tot[d].kcal > 0))
    .sort().reverse();
  if (!dates.length){ wrap.innerHTML = '<div class="empty">No weight or calories logged yet.</div>'; return; }
  const rows = dates.map(d => {
    const kg = +map[d] > 0 ? (+map[d]).toFixed(1) : '—';
    const t = tot[d];
    const cal = t && t.kcal > 0
      ? `${Math.round(t.kcal)} <small style="color:var(--faint)">(${Math.round(t.p)}P, ${Math.round(t.c)}C, ${Math.round(t.f)}F)</small>`
      : '—';
    return `<tr><td>${fmtDMY(d)}</td><td>${kg}</td><td>${cal}</td></tr>`;
  }).join('');
  wrap.innerHTML = `<table><thead><tr><th>Date</th><th>Weight</th><th>Calories (macros)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Fat gained/lost across a date range: sum each logged day's (intake − maintenance)
// and convert at 7700 kcal ≈ 1 kg. Maintenance is a band → the answer is a band.
function renderFatEstimate(){
  const lowEl=document.getElementById('maintLow'), highEl=document.getElementById('maintHigh');
  const startEl=document.getElementById('fatStart'), endEl=document.getElementById('fatEnd');
  const out=document.getElementById('fatEstimate');
  if (!out) return;
  // Hydrate from state / defaults without disturbing a field being edited.
  if (document.activeElement !== lowEl)  lowEl.value  = MAINT.min > 0 ? MAINT.min : '';
  if (document.activeElement !== highEl) highEl.value = MAINT.max > 0 ? MAINT.max : '';
  if (!endEl.value)   endEl.value   = ACTIVE_DATE;
  if (!startEl.value) startEl.value = addDaysISO(endEl.value || ACTIVE_DATE, -6);   // default: last 7 days

  const lo=+lowEl.value||0, hi=+highEl.value||0;
  // Manual band if entered; otherwise fall back to the adaptive TDEE ± a confidence margin.
  let maintLow, maintHigh, maintTxt;
  if (lo || hi){
    maintLow=Math.min(lo||hi, hi||lo); maintHigh=Math.max(lo||hi, hi||lo);
    maintTxt = maintLow===maintHigh ? `${maintLow}` : `${maintLow}–${maintHigh}`;
  } else {
    const td=computeTDEE();
    if (!(td.blended>0)){ out.className='tactical'; out.innerHTML='Fill in your <b>body profile</b> in Settings (or a maintenance range above) to estimate fat change.'; return; }
    const rd=LedgerCore.tdeeReadout({formula:td.formulaBase||0,avgIntake:td.avgIntake,
      ratePerWeek:td.ratePerWeek,rateSEPerWeek:td.rateSEPerWeek,sampleDays:td.sampleDays,
      intakes:td.intakes||[],nWeighIns:td.nWeighIns||0,coverage:td.coverage});
    maintLow=rd.modelRange[0]; maintHigh=rd.modelRange[1];
    maintTxt = `adaptive TDEE ${td.blended.toLocaleString()} (model range ${maintLow.toLocaleString()}–${maintHigh.toLocaleString()})`;
  }
  let start=startEl.value, end=endEl.value;
  if (start>end){ const t=start; start=end; end=t; }        // tolerate a reversed range

  const tot={}; allDays(true).forEach(d => { tot[d.date]=totalsOf(d.ledger); });
  const intakes=[];
  // The open day is half-eaten. Averaging it in drags the estimate down all morning and
  // up all evening, which is motion the body never made.
  Object.keys(tot).forEach(d => { if (d>=start && d<=end && d!==ACTIVE_DATE && tot[d].kcal>0) intakes.push(tot[d].kcal); });
  if (!intakes.length){ out.className='tactical'; out.textContent=`No logged days between ${fmtDMY(start)} and ${fmtDMY(end)}.`; return; }

  const e=LedgerCore.fatEstimate(intakes, maintLow, maintHigh);
  const span=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
  const fmtKg=v=>Math.abs(v).toFixed(2);
  const aLo=Math.min(Math.abs(e.kgLow),Math.abs(e.kgHigh)), aHi=Math.max(Math.abs(e.kgLow),Math.abs(e.kgHigh));
  const rangeKg = (aHi-aLo<0.01) ? `${fmtKg(aHi)} kg` : `${fmtKg(aLo)}–${fmtKg(aHi)} kg`;
  let verdict, cls;
  if (e.kcalLow>0){ verdict=`≈ +${rangeKg} fat gained`; cls='tactical bad'; }
  else if (e.kcalHigh<0){ verdict=`≈ ${rangeKg} fat lost`; cls='tactical good'; }
  else { verdict=`roughly maintenance (±${fmtKg(aHi)} kg)`; cls='tactical'; }
  const netLo=Math.round(Math.min(e.kcalLow,e.kcalHigh)), netHi=Math.round(Math.max(e.kcalLow,e.kcalHigh));

  // Scale check: does the actual weight change across the window agree with the calorie math?
  const map=weightsMap();
  const wIn=Object.keys(map).filter(d=>+map[d]>0 && d>=start && d<=end).sort();
  // A weight delta only means fat over a long enough window. Across a few days it is
  // water, gut fill and glycogen, and dividing it into calories produced an "implied
  // maintenance" 760 kcal from the app's own TDEE on real data. Both readings below are
  // gated on the same span the balance check uses.
  const wSpan = wIn.length>=2
    ? Math.round((Date.parse(wIn[wIn.length-1])-Date.parse(wIn[0]))/86400000) : 0;
  const wUsable = wIn.length>=2 && wSpan >= LedgerCore.BALANCE_MIN_DAYS;
  let eva='';
  if (wUsable){
    // Fitted, not first-minus-last: one puffy morning at either end should not set the verdict.
    const tr = LedgerCore.weightTrend(wIn.map(d=>({date:d, kg:+map[d]})));
    const actual = tr ? tr.ratePerWeek/7*wSpan : (+map[wIn[wIn.length-1]] - +map[wIn[0]]);
    const expected = (e.sum - ((maintLow+maintHigh)/2)*e.n)/7700;
    const agree = Math.abs(actual-expected) < 0.4;
    eva = `<span style="display:block;margin-top:5px;color:var(--graphite);border-left:2px solid var(--rule);padding-left:8px">`
      + `Scale check: expected ${expected>=0?'+':''}${expected.toFixed(2)} kg, actual ${actual>=0?'+':''}${actual.toFixed(2)} kg`
      + ` over ${wSpan} days — ${agree?'model is tracking your weight':'diverging — logging gaps or maintenance is off'}.</span>`;
  } else if (wIn.length>=2){
    eva = `<span style="display:block;margin-top:5px;color:var(--graphite);border-left:2px solid var(--rule);padding-left:8px">`
      + `Scale check needs a wider range — ${wSpan} day${wSpan===1?'':'s'} of weigh-ins here, and a weight change only reads as fat over ${LedgerCore.BALANCE_MIN_DAYS}+.</span>`;
  }
  // Raw ingredients for a by-hand maintenance check: avg intake + real weight delta over the range.
  const avgIn=Math.round(e.sum/e.n);
  let raw=`<span style="display:block;margin-top:5px;color:var(--graphite);border-left:2px solid var(--rule);padding-left:8px">`
    + `Avg intake <b>${avgIn.toLocaleString()}</b> kcal/day over ${e.n} logged day${e.n>1?'s':''}`;
  if (wIn.length>=2){
    const first=+map[wIn[0]], last=+map[wIn[wIn.length-1]];
    const dw=last-first, wdays=Math.round((Date.parse(wIn[wIn.length-1])-Date.parse(wIn[0]))/86400000);
    raw+=` · weight ${first}→${last} kg (<b>${dw>=0?'+':''}${dw.toFixed(1)} kg</b> over ${wdays} day${wdays>1?'s':''})`;
    // Maintenance from your own numbers: intake minus the daily kcal the weight change
    // accounts for. Only over a window where the weight change is plausibly tissue —
    // otherwise this quietly contradicts the adaptive TDEE by hundreds of kcal.
    if (wUsable){
      const maint=Math.round((avgIn - dw*7700/wdays)/5)*5;
      raw+=` → implied maintenance ≈ <b>${maint.toLocaleString()}</b> kcal/day`;
    } else if (wdays>0){
      raw+=` <span class="ink-dim">— too short a span to imply a maintenance figure</span>`;
    }
  } else {
    raw+=` · weight Δ n/a — needs 2+ weigh-ins in range`;
  }
  raw+=`</span>`;

  out.className=cls;
  out.innerHTML = `<b>${verdict}</b> over ${e.n} logged day${e.n>1?'s':''}${e.n<span?` of ${span}`:''}`
    + ` · net ${netLo>0?'+':''}${netLo.toLocaleString()} to ${netHi>0?'+':''}${netHi.toLocaleString()} kcal vs maintenance ${maintTxt}.` + raw + eva;
}

// Latest logged bodyweight (kg), or 0 if none — used by TDEE and protein-per-kg.
function latestWeight(){
  const map=weightsMap();
  const ds=Object.keys(map).filter(d=>+map[d]>0).sort();
  return ds.length ? +map[ds[ds.length-1]] : 0;
}
// Gather the inputs the pure TDEE math needs: formula BMR×activity from the profile +
// latest weight, and a data-derived maintenance from the trailing 28 days of weigh-ins
// and logged intake. calibrateTDEE() blends them by how much history exists.
function computeTDEE(){
  const kg=latestWeight();
  const formula = kg>0 ? LedgerCore.bmrMifflin(PROFILE.sex, kg, +PROFILE.height, +PROFILE.age) * (ACTIVITY_MULT[PROFILE.activity]||1.55) : 0;
  const end=ACTIVE_DATE, start=addDaysISO(end, -27);
  const map=weightsMap();
  // TREND_START drops the weigh-ins from a diet transition, whose water and glycogen
  // swing is not fat and must not be read as one. It only ever narrows the window.
  const from = TREND_START > start ? TREND_START : start;
  const winW=Object.keys(map).filter(d=>+map[d]>0 && d>=from && d<=end).sort().map(d=>({date:d, kg:+map[d]}));
  const tr = winW.length>=2 ? LedgerCore.robustWeightTrend(winW) : null;
  const sampleDays = winW.length>=2 ? Math.round((Date.parse(winW[winW.length-1].date)-Date.parse(winW[0].date))/86400000)+1 : 0;
  const tot={}; allDays(true).forEach(d=>{ tot[d.date]=totalsOf(d.ledger); });
  // Exclude the still-open day: its partial intake would drag the average (and thus the
  // adaptive corridor) around as you log meals. TDEE only moves when a day closes.
  const intakeFrom=winW.length?winW[0].date:from;
  const intakeTo=winW.length?winW[winW.length-1].date:end;
  const intakeDates=Object.keys(tot).filter(d=>d>=intakeFrom&&d<=intakeTo&&d!==ACTIVE_DATE&&tot[d].kcal>0);
  const intakes=intakeDates.map(d=>tot[d].kcal);
  const calendarDays=sampleDays>0?sampleDays-(ACTIVE_DATE>=intakeFrom&&ACTIVE_DATE<=intakeTo?1:0):0;
  const coverage=calendarDays>0?Math.min(1,intakeDates.length/calendarDays):0;
  const avgIntake = intakes.length ? intakes.reduce((a,b)=>a+b,0)/intakes.length : 0;
  const cal = LedgerCore.calibrateTDEE(formula,avgIntake,tr?tr.ratePerWeek:null,sampleDays,
    {coverage,rateSEPerWeek:tr?tr.sePerWeek:null,nWeighIns:winW.length});
  return Object.assign(cal, {kg, avgIntake:Math.round(avgIntake), sampleDays,
    formulaBase:formula,ratePerWeek:tr?tr.ratePerWeek:null,rateSEPerWeek:tr?tr.sePerWeek:null,
    intakes,nWeighIns:winW.length,coverage,intakeFrom,intakeTo});
}
// Has the corridor stopped describing what you actually eat? Reads the last 28 closed
// days against the corridor now in force. A ceiling breached most days is not a warning
// any more, so this exists to name the gap once rather than flash the same alarm daily.
function corridorDriftNow(){
  const end=ACTIVE_DATE, start=addDaysISO(end, -27);
  const tot={}; allDays(true).forEach(d=>{ tot[d.date]=totalsOf(d.ledger); });
  // Each day is judged against the corridor that applied to IT. With the training
  // cycle on, a rest day's ceiling sits 400 kcal below a session day's, and comparing
  // both to today's bounds would read a working schedule as a mis-set goal.
  const boundsFor = dayBounds();
  const days=Object.keys(tot)
    .filter(d=>d>=start && d<=end && d!==ACTIVE_DATE && tot[d].kcal>0)
    .map(d=>Object.assign({kcal: tot[d].kcal}, boundsFor(d)));
  return LedgerCore.corridorDrift(days);
}
// One sentence naming the gap and the two ways out of it, or '' when the corridor fits.
function driftLine(){
  const dr=corridorDriftNow();
  if (dr.verdict==='over')
    return `You have breached the ceiling <b>${dr.over} of the last ${dr.n}</b> days — median `
      + `<b>${dr.median.toLocaleString()}</b>, typically <b>${dr.gap.toLocaleString()}</b> past that day's ceiling. `
      + `Either raise the goal to match what you are actually eating, or eat to the corridor; `
      + `a ceiling you pass most days has stopped telling you anything.`;
  if (dr.verdict==='under')
    return `You have come in under the floor <b>${dr.under} of the last ${dr.n}</b> days — median `
      + `<b>${dr.median.toLocaleString()}</b>, typically <b>${Math.abs(dr.gap).toLocaleString()}</b> under that day's floor. `
      + `Either lower the goal or eat more; the floor is not describing your intake.`;
  return '';
}

// The profile inputs live in Settings; Trends keeps a one-line echo (#tdeeMini) so
// the number is still where you look at your weight trend.
function renderTDEE(){
  const sexEl=document.getElementById('pfSex'), ageEl=document.getElementById('pfAge'),
        hEl=document.getElementById('pfHeight'), actEl=document.getElementById('pfActivity'),
        out=document.getElementById('tdeeReadout'), mini=document.getElementById('tdeeMini');
  if (!out) return;
  if (document.activeElement!==sexEl) sexEl.value=PROFILE.sex;
  if (document.activeElement!==ageEl) ageEl.value=PROFILE.age>0?PROFILE.age:'';
  if (document.activeElement!==hEl)   hEl.value=PROFILE.height>0?PROFILE.height:'';
  if (document.activeElement!==actEl) actEl.value=PROFILE.activity;
  const tsEl=document.getElementById('pfTrendStart');
  if (tsEl && document.activeElement!==tsEl) tsEl.value=TREND_START||'';

  const echo = (cls, html)=>{ if (!mini) return; mini.hidden=false; mini.className=cls; mini.innerHTML=html; };
  const td=computeTDEE();
  const hasProfile = +PROFILE.age>0 && +PROFILE.height>0;
  if (!td.kg){
    out.className='tactical'; out.textContent='Log a weight on Trends to compute your BMR and TDEE.';
    if (mini) mini.hidden = true;
    return;
  }
  if (!hasProfile && td.dataTDEE==null){
    const msg='Enter age &amp; height for a formula estimate — or log ~7 days of weigh-ins and it derives maintenance from your data.';
    out.className='tactical'; out.innerHTML=msg;
    echo('tactical', 'Add your age and height in <b>Settings</b> to get an adaptive TDEE.');
    return;
  }
  const bits=[];
  const rd=LedgerCore.tdeeReadout({formula:td.formulaBase||0,avgIntake:td.avgIntake,
    ratePerWeek:td.ratePerWeek,rateSEPerWeek:td.rateSEPerWeek,sampleDays:td.sampleDays,
    intakes:td.intakes||[],nWeighIns:td.nWeighIns||0,coverage:td.coverage});
  if (hasProfile) bits.push(`formula ${td.formula.toLocaleString()}`);
  bits.push(td.dataTDEE!=null
    ? `measured ${td.dataTDEE.toLocaleString()} (${Math.round(td.w*100)}% weighted over ${td.sampleDays}d)`
    : `measured pending — needs ~7+ days of weigh-ins`);
  // Say so when weigh-ins are being excluded, or the number looks unexplained.
  if (TREND_START) bits.push(`weigh-ins before ${TREND_START} excluded`);
  out.className='tactical good';
  const range=`model range ${rd.modelRange[0].toLocaleString()}–${rd.modelRange[1].toLocaleString()}`;
  const caveat=rd.warnings.length?` · ${rd.warnings.join(' · ')}`:'';
  out.innerHTML = `<b>Adaptive TDEE ≈ ${td.blended.toLocaleString()} kcal/day</b> · ${range} · ${bits.join(' · ')}${caveat}.`;
  echo('tactical good', `<b>Adaptive TDEE ≈ ${td.blended.toLocaleString()} kcal/day</b> · ${range} · ${Math.round((td.coverage||0)*100)}% matched-day coverage. Edit your profile in Settings.`);
}
// Goal readout: the corridor the goal will impose + suggested protein for the phase.
function renderGoal(){
  const sel=document.getElementById('goalMode'), out=document.getElementById('goalReadout');
  if (!sel) return;
  if (document.activeElement!==sel) sel.value=GOAL.mode;
  document.getElementById('goalCustomWrap').hidden = GOAL.mode !== 'custom';
  const offEl=document.getElementById('goalOffset');
  if (document.activeElement!==offEl) offEl.value = GOAL.offset || '';
  if (GOAL.mode==='off'){ out.hidden = true; return; }
  out.hidden = false;
  const td=computeTDEE();
  if (!(td.blended>0)){ out.className='tactical'; out.textContent='Fill in the body profile above and log a weight on Trends to activate the auto corridor.'; return; }
  const off=effectiveOffset();
  const c=LedgerCore.corridorFromTDEE(td.blended, off, GOAL.band||100);
  const kg=latestWeight(), perKg=GOAL_PROTEIN_PER_KG[GOAL.mode]||1.8;
  const pg = kg>0 ? ` · protein ${perKg} g/kg ≈ ${Math.round(perKg*kg)}g` : '';
  const offTxt = off>0?`+${off}`:`${off}`;
  const dayTxt = TRAIN.cycle ? ` · ${isTrainingDay(ACTIVE_DATE)?splitForDate(ACTIVE_DATE)+' day':'rest day'}` : '';
  out.className='tactical good';
  out.innerHTML = `<b>${GOAL_LABEL[GOAL.mode]}${dayTxt}</b> · corridor <b>${c.floor.toLocaleString()}–${c.ceil.toLocaleString()}</b>/day (TDEE ${td.blended.toLocaleString()} ${offTxt})${pg}. Recalibrates as your data grows.`;
  // Per-meal protein plan — distributed across the meal plan by calories (spread aids MPS).
  const meals=mealPlanHours(), mt=meals.reduce((s,m)=>s+m.kcal,0);
  if (meals.length && mt>0 && P_TARGET>0)
    out.innerHTML += `<div style="margin-top:6px;font-size:11px;color:var(--graphite)">Protein/meal (g): ${meals.map(m=>`${escapeHtml(m.name)} ${Math.round(P_TARGET*m.kcal/mt)}`).join(' · ')}</div>`;
  // Drift sits directly under the goal control, because changing the goal is one of
  // the two answers to it.
  const drift=document.getElementById('driftNote');
  if (drift){
    const line=driftLine();
    drift.hidden = !line;
    drift.className = 'tactical bad';
    drift.innerHTML = line;
  }
}
// Trailing 28-day weight rate (kg/wk) for the brief and weekly narrative.
function weekRatePerWeek(){
  const map=weightsMap(), end=ACTIVE_DATE, start=addDaysISO(end,-27);
  const w=Object.keys(map).filter(d=>+map[d]>0 && d>=start && d<=end).sort().map(d=>({date:d,kg:+map[d]}));
  const tr=w.length>=2?LedgerCore.weightTrend(w):null; return tr?tr.ratePerWeek:null;
}
// One-sentence weekly story: intake, adherence, weight movement, and whether that matches the goal.
function weeklyNarrative(avgK, n, okDays){
  const r=weekRatePerWeek();
  const rateTxt = r==null ? '' : (Math.abs(r)<0.05?'weight holding steady':(r<0?`down ${Math.abs(r).toFixed(2)} kg/wk`:`up ${r.toFixed(2)} kg/wk`));
  let verdict='';
  if (GOAL.mode!=='off' && r!=null){
    const want=goalOffset();
    if (want>0)      verdict = r>0.03 ? ' — lean bulk on plan, keep going.' : (r<-0.03 ? ' — you want a surplus but you\'re dropping; eat a bit more.' : ' — flat; nudge intake up to grow.');
    else if (want<0) verdict = r<-0.03 ? ' — cut on plan.' : (r>0.03 ? ' — you want a deficit but you\'re gaining; tighten intake.' : ' — flat; drop intake a touch to move.');
    else             verdict = Math.abs(r)<0.05 ? ' — holding at maintenance, as intended.' : '';
  }
  return `<div class="tactical" style="margin-bottom:12px">This week: avg <b style="color:var(--chalk)">${Math.round(avgK)}</b> kcal · ${okDays}/${n} in corridor${rateTxt?` · ${rateTxt}`:''}${verdict}</div>`;
}
// Morning brief: shown once per day on first open — the day's plan and where you stand.
function maybeShowBrief(){
  try{
    if (getKey('ledger_brief_seen')===ACTIVE_DATE) return;
    const days=closedDays(); if(!days.length) return;        // nothing to brief on yet
    const yt=totalsOf(days[0].ledger);
    // Judged against the corridor that applied to THAT day, not today's.
    const yb=dayBounds()(days[0].date);
    const yMark = yt.kcal>yb.ceil?'over ceiling':(yt.kcal>=yb.floor?'in corridor ✓':'under floor');
    let msg='Good morning. ';
    msg += isTrainingDay(ACTIVE_DATE) ? `${escapeHtml(splitForDate(ACTIVE_DATE))} day (${TRAIN.start}). ` : `Rest day. `;
    msg += CORRIDOR_AUTO
      ? `Target <b>${FLOOR}–${CEIL}</b> (TDEE ${CORRIDOR_AUTO.tdee.toLocaleString()}). `
      : `Target <b>${FLOOR}–${CEIL}</b>. `;
    const r=weekRatePerWeek();
    if (r!=null) msg += (Math.abs(r)<0.05?'Weight holding steady. ':(r<0?`Trending down ${Math.abs(r).toFixed(2)} kg/wk. `:`Trending up ${r.toFixed(2)} kg/wk. `));
    msg += `Yesterday ${Math.round(yt.kcal)} kcal · ${yMark}.`;
    const dr=corridorDriftNow();
    if (dr.verdict==='over') msg += ` Heads up: ${dr.over}/${dr.n} recent days over the ceiling — the corridor may need raising.`;
    else if (dr.verdict==='under') msg += ` Heads up: ${dr.under}/${dr.n} recent days under the floor — the corridor may need lowering.`;
    const card=document.getElementById('briefCard');
    document.getElementById('briefText').innerHTML=msg;
    card.className='read-item '+(yMark.includes('✓')?'good':(yt.kcal>yb.ceil?'bad':'meh'));
    card.hidden = false;
    setKey('ledger_brief_seen', ACTIVE_DATE);                 // once per day, even across reloads
  }catch(e){}
}

function renderAverages() {
  const all = closedDays();          // open day excluded — averages cover completed days only
  // An em-dash in the display face reads as a filled bar, not as "no data yet".
  // Say what is missing instead.
  const blank = (id, sub)=>{
    const v = document.getElementById(id);
    v.textContent = '—'; v.classList.add('none');
    document.getElementById(id + 'Sub').textContent = sub;
  };
  if (all.length < 2){
    const need = all.length === 0 ? 'Close a day to start averaging' : 'One more closed day';
    ['avg7k','avg7p','avg30k','avg30p'].forEach(id => blank(id, need));
    return;
  }
  ['avg7k','avg7p','avg30k','avg30p'].forEach(id =>
    document.getElementById(id).classList.remove('none'));

  const calcAvg = (arr) => {
    const tots = arr.map(d => Object.assign({date:d.date}, totalsOf(d.ledger)));
    return {
      kcal: tots.reduce((s,t) => s+t.kcal, 0) / tots.length,
      p: tots.reduce((s,t) => s+t.p, 0) / tots.length,
      ok: tots.filter(t => dayOk(t, t.date)).length,
      total: tots.length
    };
  };

  const week = calcAvg(all.slice(0, Math.min(7, all.length)));
  const month = all.length >= 2 ? calcAvg(all.slice(0, Math.min(30, all.length))) : null;

  const trendIcon = (val, target, isFloor) => {
    if (isFloor) {
      return val >= target ? '<span class="avg-trend up">✓ On track</span>' : '<span class="avg-trend down">Below target</span>';
    }
    return val <= target ? '<span class="avg-trend up">✓ In range</span>' : '<span class="avg-trend down">Over ceiling</span>';
  };

  document.getElementById('avg7k').textContent = Math.round(week.kcal);
  document.getElementById('avg7kSub').innerHTML = `${week.ok}/${week.total} days in corridor ${trendIcon(week.kcal, CEIL, false)}`;
  document.getElementById('avg7p').textContent = Math.round(week.p) + 'g';
  document.getElementById('avg7pSub').innerHTML = `vs ${Math.round(P_TARGET)}g floor ${trendIcon(week.p, P_TARGET, true)}`;

  if (month) {
    document.getElementById('avg30k').textContent = Math.round(month.kcal);
    document.getElementById('avg30kSub').innerHTML = `${month.ok}/${month.total} days in corridor`;
    document.getElementById('avg30p').textContent = Math.round(month.p) + 'g';
    document.getElementById('avg30pSub').innerHTML = `vs ${Math.round(P_TARGET)}g floor`;
  }
}

// 4. BUDGET TRANSLATOR
const foodIcon = (name) => {
  const n = name.toLowerCase();
  return n.includes('chicken') ? '🍗' : n.includes('egg') ? '🥚' :
         n.includes('rice') ? '🍚' : n.includes('milk') ? '🥛' : '🍽️';
};
// The 9pm emergency: still short on protein — what single food closes the gap
// within the remaining ceiling headroom, at the smallest calorie cost?
function proteinFixHTML(t, remP){
  const budget = CEIL - t.kcal;
  if (remP <= 0.5 || budget <= 0) return '';
  const opts = LedgerCore.proteinFix(Object.entries(foodBase), remP, budget).slice(0, 4);
  if (!opts.length)
    return `<div class="budget-item"><span class="budget-icon">🚨</span><div class="budget-text">No single food in your database closes <strong>${remP.toFixed(0)}g protein</strong> within the <strong>${Math.round(budget)} kcal</strong> headroom — split it across the day or accept the gap.</div></div>`;
  return `<div class="pfix-head">Protein fix · ${remP.toFixed(0)}g needed · ${Math.round(budget)} kcal headroom</div>` +
    opts.map(o =>
      `<div class="budget-item"><span class="budget-icon">${foodIcon(o.name)}</span><div class="budget-text"><strong>${o.grams}g ${escapeHtml(o.name)}</strong> → +${remP.toFixed(0)}g P for <strong>${o.kcal} kcal</strong></div></div>`
    ).join('');
}

function renderHeatmap() {
  const grid = document.getElementById('heatmapGrid');
  const today = new Date();
  const todayStr = dateStr();

  // Build lookup of all days
  const dayMap = {}, ledgerMap = {};
  allDays(true).forEach(d => { dayMap[d.date] = totalsOf(d.ledger); ledgerMap[d.date] = d.ledger; });
  // Overlay the live in-memory state under whichever day is on screen.
  if (ledger.length) { dayMap[VIEW_DATE] = totals(); ledgerMap[VIEW_DATE] = ledger; }

  // Generate HEATMAP_WEEKS weeks ending on today's week's Sunday. Widened to 16 so the
  // full imported history (~2.5 months of Gemini logs) is visible, not just recent weeks.
  const HEATMAP_WEEKS = 16;
  const dow = today.getDay(); // 0=Sun
  const endOffset = dow === 0 ? 0 : 7 - dow; // days to next Sunday
  const cells = [];

  for (let i = (HEATMAP_WEEKS * 7 - 1) + endOffset; i >= 0 + endOffset; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i + endOffset);
    const ds = d.toISOString().slice(0, 10);
    const isFuture = ds > todayStr;
    const t = dayMap[ds];

    let cls = 'heatmap-cell';
    let tip = ds;

    if (isFuture) {
      cls += ' future';
    } else if (!t) {
      cls += ' lv0';
      tip += ' · no data';
    } else {
      const inC = t.kcal >= FLOOR && t.kcal <= CEIL;
      const pOk = t.p >= P_TARGET;
      if (t.kcal > CEIL) {
        cls += ' breach';
        tip += ` · ${Math.round(t.kcal)} kcal ⚠️ breach`;
      } else if (inC && pOk) {
        cls += ' lv4';
        tip += ` · ${Math.round(t.kcal)} kcal ✓ perfect`;
      } else if (inC) {
        cls += ' lv3';
        tip += ` · ${Math.round(t.kcal)} kcal · P short`;
      } else if (t.kcal >= FLOOR * 0.85) {
        cls += ' lv2';
        tip += ` · ${Math.round(t.kcal)} kcal · close`;
      } else {
        cls += ' lv1';
        tip += ` · ${Math.round(t.kcal)} kcal · under`;
      }
      // A bulk-imported day carries kcal and protein and nothing else. Its zeros are
      // an absence of measurement, not a measurement of zero, and the cell should say
      // so rather than looking like any other fully-logged day.
      if (!LedgerCore.macrosComplete(ledgerMap[ds])) tip += ' · macros not logged';
    }

    if (!isFuture && ds === VIEW_DATE) cls += ' viewing';
    // Real buttons, not divs: the day summaries used to be reachable only by
    // hovering, which on a touch-first app meant not reachable at all.
    cells.push(
      `<button type="button" class="${cls}"${isFuture ? ' disabled' : ` data-date="${ds}"`}` +
      ` aria-label="${escapeAttr(tip)}${isFuture ? '' : ' — open this day'}">` +
      `<span class="hm-tip" aria-hidden="true">${escapeHtml(tip)}</span></button>`);
  }

  grid.innerHTML = cells.join('');
  grid.onclick = (ev)=>{
    const cell = ev.target.closest('[data-date]');
    if (cell) viewDay(cell.dataset.date);
  };
}

// Render the Trends tab. Only called when Trends is the visible tab.
function renderTrendsTab(){
  renderAverages();
  renderHeatmap();
  renderWeight();
  renderWeightLog();
  renderFatEstimate();   // TDEE + goal readouts are refreshed by render(), not here
  renderDataTrust();
  renderTrainingConsistency();
  renderMuscleVolume();
  renderSiteProgress();
  renderGoalProjection();
  renderWeeklyReport();
  renderTopFoods();
  renderRecompFromLifts();
  renderHistory();
}

// 6. WEEKLY REPORT CARD
function renderWeeklyReport() {
  const wrap = document.getElementById('weeklyReport');
  const all = closedDays();          // open day excluded — matches the rolling averages exactly
  if (all.length < 2) { wrap.innerHTML = '<div class="empty">Need at least 2 days of data.</div>'; return; }

  const week = all.slice(0, Math.min(7, all.length));
  const tots = week.map(d => ({ date: d.date, ...totalsOf(d.ledger) }));
  const avgK = tots.reduce((s,t) => s+t.kcal, 0) / tots.length;
  const okDays = tots.filter(t => dayOk(t, t.date)).length;

  // Best and worst days
  const sorted = [...tots].sort((a,b) => {
    const aOk = dayOk(a, a.date) ? 1 : 0;
    const bOk = dayOk(b, b.date) ? 1 : 0;
    return bOk - aOk || Math.abs(a.kcal - FLOOR) - Math.abs(b.kcal - FLOOR);
  });
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  // The averages themselves are not repeated here — Rolling averages at the top of
  // this tab is the one place for them. This card carries the narrative and the
  // two days worth naming.
  wrap.innerHTML = weeklyNarrative(avgK, tots.length, okDays) + `
    <div class="report-best-worst">
      <div class="report-bw"><div class="rbw-label">🏆 Best day</div><div class="rbw-val">${best.date}<br>${Math.round(best.kcal)} kcal · ${best.p.toFixed(0)}g P</div></div>
      <div class="report-bw"><div class="rbw-label">⚠️ Worst day</div><div class="rbw-val">${worst.date}<br>${Math.round(worst.kcal)} kcal · ${worst.p.toFixed(0)}g P</div></div>
    </div>`;
}

// 7. TOP FOODS BAR CHART
// Weekly set targets per muscle, if the user has set any. Optional — an empty map just
// means the volume panel shows executed sets with no target marker.
function volumeTargets(){
  try{ const m = JSON.parse(localStorage.getItem('ledger_volume_targets')||'{}'); return m&&typeof m==='object'?m:{}; }catch(e){ return {}; }
}
// ---- data quality: intake variability, TDEE confidence, macro consistency ----
// The app's reads are only as good as the data feeding them. This panel makes the input
// quality visible — the cheapest, most honest thing it can show — so an adaptive TDEE that
// is really a guess reads as one, and a clean stretch reads as trustworthy.
function renderDataTrust(){
  const wrap = document.getElementById('dataTrust'); if (!wrap) return;
  const td = computeTDEE();
  const cDays = closedDays();                        // for macro consistency over the last week
  const week = cDays.slice(0,7).map(d=>totalsOf(d.ledger));
  const kcalCV = LedgerCore.intakeStats(week.map(t=>t.kcal)).cv;
  const pStat = LedgerCore.intakeStats(week.map(t=>t.p));
  const spanDays = cDays.length ? Math.round((Date.parse(cDays[0].date)-Date.parse(cDays[cDays.length-1].date))/86400000)+1 : 0;
  const rd = LedgerCore.tdeeReadout({
    formula: td.formulaBase||0, avgIntake: td.avgIntake, ratePerWeek: td.ratePerWeek,
    rateSEPerWeek:td.rateSEPerWeek,sampleDays:td.sampleDays,intakes:td.intakes||[],
    nWeighIns:td.nWeighIns||0,coverage:td.coverage });
  const trust = LedgerCore.dataTrust({
    intakeCV:rd.cv,nIntakeDays:rd.nIntakeDays,nWeighIns:rd.nWeighIns,spanDays,coverage:td.coverage });
  const dot = it => it.ok ? '<span class="trust-dot ok">●</span>'
                   : it.warn ? '<span class="trust-dot warn">●</span>' : '<span class="trust-dot bad">●</span>';
  const rows = trust.items.map(it =>
    `<div class="trust-row">${dot(it)}<span>${escapeHtml(it.label)}</span><span class="ink-dim">want ${escapeHtml(it.want)}</span></div>`).join('');
  // The TDEE disagreement is the headline the old readout hid: regression vs formula can be
  // hundreds of kcal apart; this span is a model range, not a statistical interval.
  const dis = rd.disagreement;
  let tdeeLine = '';
  if (dis.regression != null && dis.predictive > 0){
    tdeeLine = `<div class="trust-tdee">Adaptive TDEE <b>${rd.pointEstimate.toLocaleString()}</b> kcal `
      + `<span class="lift-conf ${CONF_CLS[rd.confidence]||'low'}">${rd.confidence} confidence</span><br>`
      + `<span class="ink-dim">weight-trend says ${dis.regression.toLocaleString()} · formula says ${dis.predictive.toLocaleString()}`
      + (dis.gapKcal>200 ? ` — they disagree by ${dis.gapKcal.toLocaleString()} kcal` : '') + `</span></div>`;
  }
  const consist = (kcalCV!=null || pStat.cv!=null)
    ? `<div class="trust-row"><span>Last ${week.length}-day consistency</span>`
      + `<span class="ink-dim">kcal CV ${kcalCV!=null?kcalCV+'%':'—'} · protein ${pStat.n?Math.round(pStat.mean)+'g ±'+pStat.sd:'—'}</span></div>`
    : '';
  wrap.innerHTML = tdeeLine + rows + consist
    + `<div class="trust-foot ink-dim">Input quality: <b class="trust-${trust.tier}">${trust.tier}</b>. `
    + `Intake pattern: <b>${escapeHtml(trust.consistency||'unknown')}</b> — variation describes behaviour and no longer lowers confidence by itself. These gate how much to believe the adaptive corridor, the fat-change estimate and the recomp read.</div>`;
}

// No fixed programme required: expected frequency is this user's median session count
// in the preceding six active weeks, and expected performance comes from each lift's
// own prior trajectory. A changing split therefore does not invalidate either read.
function renderTrainingConsistency(){
  const wrap=document.getElementById('trainingConsistency'); if(!wrap)return;
  const all=allWorkouts();
  const sessions=Object.keys(all).map(d=>all[d]).filter(s=>(s.exercises||[]).length);
  if(!sessions.length){wrap.innerHTML='<div class="empty">Log a few sessions and your rolling frequency baseline appears here.</div>';return;}
  const f=LedgerCore.frequencyConsistency(sessions,VIEW_DATE);
  const freq=f.expected==null
    ? `<b>${f.current} session${f.current===1?'':'s'} in the last 7 days</b> · a personal baseline appears after activity in earlier weeks.`
    : `<b>${f.current} vs ${f.expected} expected session${f.expected===1?'':'s'}</b> in the last 7 days · <span class="lift-conf ${f.status==='on-pace'?'high':f.status==='near'?'med':'low'}">${f.status.replace('-', ' ')}</span>`;
  const W=weightSeries();
  const scored=sessions.slice().sort((a,b)=>a.date<b.date?-1:1)
    .map(s=>({s,p:LedgerCore.sessionPerformance(s,sessions,{weights:W})}))
    .filter(x=>x.p.status==='ok');
  const latest=scored[scored.length-1];
  const perf=latest
    ? `<div class="trust-tdee" style="margin-top:10px">Latest comparable session (${fmtDMY(latest.s.date)}): <b>${latest.p.scorePct>=0?'+':''}${latest.p.scorePct.toFixed(1)}% vs expected</b> across ${latest.p.n} lift${latest.p.n===1?'':'s'} <span class="lift-conf ${CONF_CLS[latest.p.confidence]||'low'}">${latest.p.confidence}</span></div>`
    : `<div class="tactical" style="margin-top:10px">Expected-vs-actual performance appears after at least two prior logs of a lift. No planned sets are needed.</div>`;
  const last=f.daysSince==null?'':(f.daysSince===0?'Last trained today.':`Last trained ${f.daysSince} day${f.daysSince===1?'':'s'} ago.`);
  wrap.innerHTML=`<div class="trust-tdee">${freq}</div><div class="ink-dim" style="margin-top:5px">${last} Expected frequency is your own rolling median, so changing the split does not reset it.</div>${perf}`;
}

// ---- weekly training volume per muscle ----
// The app knew every set but never rolled it up per muscle, so a muscle trained at half its
// planned volume, or on back-to-back days, was invisible. This reads it back — fractional
// working-sets by muscle over the trailing 7 days, the gaps that expose frequency, and a
// prompt to tag any exercise the metadata does not yet know.
function renderMuscleVolume(){
  const wrap = document.getElementById('muscleVolume'); if (!wrap) return;
  const all = allWorkouts(), cat = exerciseCatalog();
  const sessions = Object.keys(all).map(d=>all[d]);
  if (!sessions.some(s=>(s.exercises||[]).length)){ wrap.innerHTML = '<div class="empty">Log a few sessions and volume-per-muscle appears here.</div>'; return; }
  const end = VIEW_DATE;
  const from = addDaysISO(end, -6);
  const range = { from, to: end };
  const vol = LedgerCore.weeklyVolumeByMuscle(sessions, cat, range);
  const freq = LedgerCore.muscleFrequency(sessions, cat, range);
  const targets = volumeTargets();
  // Per-muscle progression, rolled up from the individual exercise trends over the 8-week
  // trend window (not this week's volume): each muscle's read is the involvement-weighted,
  // trust-weighted mean of the lifts that train it, which cancels the per-exercise confounders
  // (session order, pre-exhaustion) that make a single lift's progress hard to read.
  const prog = LedgerCore.muscleProgress(liftTrends(all, weightSeries()), cat);
  const untagged = vol.__untagged || 0;
  const groups = Object.keys(vol).filter(g=>g!=='__untagged').sort((a,b)=>vol[b]-vol[a]);
  if (!groups.length && !untagged){ wrap.innerHTML = '<div class="empty">No sets in the last 7 days.</div>'; return; }
  const maxV = Math.max(1, ...groups.map(g=>vol[g]), ...Object.keys(targets).map(k=>+targets[k]||0));
  const progLine = g=>{
    const p = prog[g];
    if (!p) return `<div class="mv-prog"><span class="ink-dim">progression · needs a few more logged sessions</span></div>`;
    const cls = p.verdict==='progressing'?'up':p.verdict==='regressing'?'down':'flat';
    const arrow = p.verdict==='progressing'?'▲':p.verdict==='regressing'?'▼':'→';
    const word = p.verdict==='stalled'?'holding':p.verdict;
    const moe = p.se!=null ? ` <span class="ink-dim">±${p.se.toFixed(1)}</span>` : '';
    const conf = `<span class="lift-conf ${CONF_CLS[p.confidence]||'low'}">${p.confidence}</span>`;
    const drivers = p.contributors.slice(0,2).map(c=>{
      const nm = c.name.length>16 ? c.name.slice(0,15)+'…' : c.name;
      return escapeHtml(nm);
    }).join(', ');
    return `<div class="mv-prog ${cls}"><span class="arrow">${arrow}</span>`
      + `<span>${pctTxt(p.pctPerMonth)}${moe} · ${word}</span>${conf}`
      + `<span class="mv-drivers">${p.nExercises} lift${p.nExercises===1?'':'s'}: ${drivers}</span></div>`;
  };
  const rows = groups.map(g=>{
    const sets = vol[g], tgt = +targets[g]||0;
    const f = freq[g] || {sessions:0, gaps:[]};
    const backToBack = f.gaps.some(x=>x<=1);
    const pct = Math.max(6, sets/maxV*100), tpct = tgt>0 ? Math.min(100, tgt/maxV*100) : null;
    const short = tgt>0 && sets < tgt*0.75;
    const gapNote = f.sessions>=2 ? `${f.sessions}× · gaps ${f.gaps.join('/')}d` + (backToBack?' ⚠':'') : `${f.sessions}× this week`;
    return `<div class="mv-row">
      <div class="mv-name">${escapeHtml(LedgerCore.MUSCLE_LABEL[g]||g)}</div>
      <div class="mv-bar-wrap"><div class="mv-bar${short?' short':''}" style="width:${pct}%"></div>`
      + (tpct!=null?`<div class="mv-target" style="left:${tpct}%" title="target ${tgt}"></div>`:'') + `</div>
      <div class="mv-val">${sets%1?sets.toFixed(1):sets}${tgt>0?` / ${tgt}`:''}</div>
      <div class="mv-freq ink-dim">${gapNote}</div>
      ${progLine(g)}
    </div>`;
  }).join('');
  wrap.innerHTML = `<div class="mv-cap ink-dim">Working sets per muscle · last 7 days${Object.keys(targets).length?' · target marker shown':''}</div>`
    + rows
    + `<div class="mv-foot ink-dim">The footnote under each muscle is its <b>progression</b> — every exercise that trains it, weighted by involvement and trust, rolled into one %/month over the last 8 weeks. It reads a muscle a single lift can't: an isolation looking flat while the compounds that hit it climb still nets out as progress. ±&nbsp;is the margin; the tier is how far the pooled trend clears it.</div>`
    + (untagged ? `<div class="mv-untagged">⚠ ${untagged%1?untagged.toFixed(1):untagged} set${untagged===1?'':'s'} on exercises with no muscle tag — they are pooled, not counted per muscle. Newly-logged lifts outside the seed list need tagging.</div>` : '');
}

// ---- Goal projection ---------------------------------------------------------
// "I am 71 kg and want 76" is a question the app already has every input for: a fitted
// rate, its standard error, a calibrated maintenance and that maintenance's own earned
// confidence. What it must not do is answer with a date. A rate of 0.16 kg/wk with an
// SE of 0.12 puts the arrival anywhere from ten weeks to never, and the interval IS the
// finding — it says the trend has not separated from noise yet.
//
// The second reading is the inverse and is available immediately: what rate, and for
// bodyweight what daily surplus, would land the target by a chosen date. That one works
// on day one, when no trend exists.
const PROJ_TOL = { weight: 0.2, default: 0.3 };          // "close enough to have arrived"
const PROJ_LABEL = { weight: 'Bodyweight', waist: 'Waist', neck: 'Neck', hip: 'Hips',
  chest: 'Chest', shoulder: 'Shoulders', arm: 'Upper arm', forearm: 'Forearm',
  thigh: 'Thigh', calf: 'Calf' };
const PROJ_KEYS = ['weight','waist','chest','shoulder','arm','forearm','thigh','calf','neck','hip'];

function goalTargetsSave(){ saveTargets(); render(); }
// Current value and fitted rate for one tracked quantity. Weight comes from the weigh-in
// log (honouring TREND_START, so a diet-transition water swing never sets a projection);
// everything else from the tape.
function projSeries(key){
  if (key === 'weight'){
    const map = weightsMap();
    const all = Object.keys(map).filter(d=>+map[d]>0).sort();
    const use = all.filter(d => !TREND_START || d >= TREND_START);
    return (use.length >= 2 ? use : all).map(d=>({date:d, v:+map[d]}));
  }
  const m = measureMap(), out = [];
  Object.keys(m).sort().forEach(d => { if (m[d] && +m[d][key] > 0) out.push({date:d, v:+m[d][key]}); });
  return out;
}
function fmtWeeks(w){
  if (w == null) return '—';
  if (w < 1.5) return `${Math.round(w*7)} days`;
  if (w < 10)  return `${w.toFixed(1)} weeks`;
  return `${Math.round(w)} weeks`;
}
function etaDate(weeks){
  if (weeks == null) return null;
  return addDaysISO(ACTIVE_DATE, Math.round(weeks * 7));
}
function renderGoalProjection(){
  const wrap = document.getElementById('goalProjection'); if (!wrap) return;
  const form = document.getElementById('goalTargetForm');
  if (form){
    form.innerHTML = PROJ_KEYS.map(k => {
      const v = GOAL_TARGETS[k] != null ? GOAL_TARGETS[k] : '';
      const unit = k === 'weight' ? 'kg' : 'cm';
      return `<div><label for="gt_${k}">${escapeHtml(PROJ_LABEL[k])} (${unit})</label>`
        + `<input type="number" id="gt_${k}" data-goaltarget="${k}" min="0" step="0.1" inputmode="decimal" value="${v}" placeholder="no target"></div>`;
    }).join('') + `<div><label for="gt_date">Want it by (optional)</label>`
        + `<input type="date" id="gt_date" value="${escapeHtml(GOAL_TARGET_DATE||'')}"></div>`;
    form.querySelectorAll('[data-goaltarget]').forEach(el => {
      el.onchange = () => {
        const k = el.getAttribute('data-goaltarget'), v = parseFloat(el.value);
        if (isFinite(v) && v > 0) GOAL_TARGETS[k] = v; else delete GOAL_TARGETS[k];
        goalTargetsSave();
      };
    });
    const dEl = document.getElementById('gt_date');
    if (dEl) dEl.onchange = () => { GOAL_TARGET_DATE = dEl.value || ''; goalTargetsSave(); };
  }

  const keys = PROJ_KEYS.filter(k => +GOAL_TARGETS[k] > 0);
  if (!keys.length){
    wrap.innerHTML = '<div class="empty">Set a target below — a goal weight, or a waist you do not want to pass — and the app will project when the current trend gets there.</div>';
    return;
  }
  // The TDEE's own earned confidence gates any advice that rests on it. A required
  // surplus quoted off a formula-only maintenance is a guess wearing a number's clothes.
  const td = computeTDEE();
  const rd = LedgerCore.tdeeReadout({
    formula: td.formulaBase||0, avgIntake: td.avgIntake, ratePerWeek: td.ratePerWeek,
    sampleDays: td.sampleDays, intakes: td.intakes||[], nWeighIns: td.nWeighIns||0 });
  const tdeeConf = rd.confidence || 'low';    // tdeeConfidence returns a tier string, not an object
  const byDays = GOAL_TARGET_DATE
    ? Math.round((Date.parse(GOAL_TARGET_DATE) - Date.parse(ACTIVE_DATE))/86400000) : 0;

  const rows = keys.map(k => {
    const unit = k === 'weight' ? 'kg' : 'cm';
    const series = projSeries(k);
    const cur = series.length ? series[series.length-1].v : null;
    const tgt = +GOAL_TARGETS[k];
    const tr = series.length >= 2 ? LedgerCore.measureTrend(series.map(e=>({date:e.date, v:e.v}))) : null;
    const p = LedgerCore.projectGoal({
      current: cur, target: tgt,
      ratePerWeek: tr ? tr.perWeek : null, sePerWeek: tr ? tr.sePerWeek : null,
      tol: PROJ_TOL[k] || PROJ_TOL.default });
    // A tape projection owes nothing to the TDEE; a bodyweight one does, because the
    // only lever on it is intake.
    const conf = LedgerCore.projectionConfidence(p.confidence, tdeeConf, { ignoreTDEE: k !== 'weight' });

    const head = `<div class="proj-name">${escapeHtml(PROJ_LABEL[k])}</div>`
      + `<div class="proj-now">${cur!=null?cur.toFixed(1):'—'} → <b>${tgt.toFixed(1)}</b> ${unit}</div>`;
    let body, cls = 'flat';
    if (cur == null) body = `<div class="proj-line">Nothing logged for this yet.</div>`;
    else if (p.verdict === 'arrived'){ cls='up'; body = `<div class="proj-line">Already there.</div>`; }
    else if (p.verdict === 'thin')
      body = `<div class="proj-line">Needs a second ${k==='weight'?'weigh-in':'measurement'} before a trend exists.</div>`;
    else if (p.verdict === 'wrong-way'){
      cls='down';
      body = `<div class="proj-line">Moving <b>away</b> from it at ${Math.abs(p.ratePerWeek).toFixed(2)} ${unit}/wk.</div>`;
    } else if (p.verdict === 'unbounded'){
      cls='flat';
      body = `<div class="proj-line">At <b>${p.ratePerWeek.toFixed(2)} ${unit}/wk</b> the midpoint is ${fmtWeeks(p.weeks)} `
        + `(${fmtDMY(etaDate(p.weeks))}) — but the rate is not yet distinguishable from no change, `
        + `so the honest range is <b>${fmtWeeks(p.loWeeks)} to open-ended</b>.</div>`;
    } else {
      cls = 'up';
      body = `<div class="proj-line">At <b>${p.ratePerWeek.toFixed(2)} ${unit}/wk</b>: <b>${fmtDMY(etaDate(p.weeks))}</b>`
        + (p.loWeeks!=null ? ` <span class="ink-dim">(${fmtDMY(etaDate(p.loWeeks))} – ${fmtDMY(etaDate(p.hiWeeks))})</span>` : '')
        + ` · ${fmtWeeks(p.weeks)} away.</div>`;
    }
    // The inverse — but only for bodyweight. It earns its place because intake is a real
    // lever on the scale, so "you need +0.36 kg/wk" converts into a corridor you can
    // actually set. No such lever exists for a tape site: telling someone they need
    // 0.36 cm/wk of arm is not advice, and on a waist kept as a LIMIT rather than a goal
    // it reads as an instruction to gain the very thing they are watching.
    let need = '';
    if (k === 'weight' && byDays > 0 && cur != null && p.verdict !== 'arrived'){
      const r = LedgerCore.requiredRate(cur, tgt, byDays, { unit: 'kg' });
      need = `<div class="proj-need">To land it by ${fmtDMY(GOAL_TARGET_DATE)} you need `
        + `<b>${r.ratePerWeek>0?'+':''}${r.ratePerWeek.toFixed(2)} ${unit}/wk</b>`
        + ` — about <b>${r.kcalPerDay>0?'+':''}${r.kcalPerDay.toLocaleString()} kcal/day</b> against maintenance`
        + `<span class="ink-dim">, so a corridor near ${Math.round(td.blended + r.kcalPerDay).toLocaleString()}`
        + ` — worth only as much as that maintenance figure, which is <b>${escapeHtml(tdeeConf)}</b> confidence.</span>`
        + `</div>`;
    }
    const confTag = (p.verdict==='ok' || p.verdict==='unbounded')
      ? `<span class="lift-conf ${CONF_CLS[conf]||'low'}">${conf}</span>` : '';
    return `<div class="proj-row ${cls}">${head}${body}${need}
      <div class="proj-foot ink-dim">${series.length} reading${series.length===1?'':'s'}`
      + (tr && tr.sePerWeek!=null ? ` · rate ±${tr.sePerWeek.toFixed(2)} ${unit}/wk` : '')
      + (k==='weight' ? ` · maintenance ${Math.round(td.blended).toLocaleString()} kcal (${escapeHtml(tdeeConf)} confidence)` : '')
      + ` ${confTag}</div></div>`;
  }).join('');

  // Which target arrives FIRST is the reading no single projection gives. On a bulk the
  // waist reaching its limit before the scale reaches its goal is the signal to stop.
  const dated = keys.map(k => {
    const s = projSeries(k); if (s.length < 2) return null;
    const tr = LedgerCore.measureTrend(s.map(e=>({date:e.date, v:e.v})));
    const p = LedgerCore.projectGoal({ current: s[s.length-1].v, target: +GOAL_TARGETS[k],
      ratePerWeek: tr?tr.perWeek:null, sePerWeek: tr?tr.sePerWeek:null, tol: PROJ_TOL[k]||PROJ_TOL.default });
    return p.verdict === 'ok' ? { k, weeks: p.weeks } : null;
  }).filter(Boolean).sort((a,b)=>a.weeks-b.weeks);
  let first = '';
  if (dated.length >= 2 && dated[0].k !== 'weight')
    first = `<div class="proj-first">⚠ <b>${escapeHtml(PROJ_LABEL[dated[0].k])}</b> reaches its target around `
      + `${fmtDMY(etaDate(dated[0].weeks))} — before ${escapeHtml(PROJ_LABEL[dated[dated.length-1].k])} `
      + `(${fmtDMY(etaDate(dated[dated.length-1].weeks))}). Whichever limit you set to stop at arrives first.</div>`;

  wrap.innerHTML = rows + first
    + `<div class="mv-foot ink-dim">Projections are a <b>range</b>, never a date: the rate is a fitted slope with an error bar, and when that error bar reaches zero there is no upper bound to quote. Confidence combines how tightly the rate is pinned with how much the maintenance estimate has earned — a bodyweight projection can never be more trustworthy than the TDEE the intake advice rests on.</div>`;
}

// ---- Tissue vs training ------------------------------------------------------
// Nine circumferences have been collected since the Logs tab shipped and three were
// ever read. This closes the loop the app is uniquely able to close: measured tissue,
// against trained volume, against the strength trend for the same muscles.
//
// The waist is the reference, not a site. In a surplus every measurement grows, so the
// centimetre on its own says nothing — the site's size RELATIVE to the waist is the
// recomposition read, and it works unchanged for someone cutting.
const SITE_VERDICT = {
  'building':    ['up',   'gaining on the waist'],
  'proportional':['flat', 'growing with the waist'],
  'fat-leading': ['down', 'waist growing faster'],
  'leaning':     ['up',   'holding while the waist shrinks'],
  'fat-gaining': ['down', 'flat while the waist grows'],
  'growing':     ['up',   'growing'],
  'shrinking':   ['down', 'shrinking'],
  'holding':     ['flat', 'holding'],
  'thin':        ['flat', 'needs a second measurement']
};
const SITE_SIGNAL = {
  'confirmed':    'the strength trend agrees',
  'unconfirmed':  'but strength is not climbing — in a surplus this can be fat and water',
  'strength-only':'strength is climbing without the tape moving — neural gain, or a re-sited tape',
  'undertrained': 'and it is barely trained'
};
function measureSeriesByKey(){
  const map = measureMap(), out = {};
  Object.keys(map).sort().forEach(d => {
    const m = map[d]; if (!m) return;
    Object.keys(m).forEach(k => {
      if (+m[k] > 0) (out[k] = out[k] || []).push({ date: d, v: +m[k] });
    });
  });
  return out;
}
function renderSiteProgress(){
  const wrap = document.getElementById('siteProgress'); if (!wrap) return;
  const series = measureSeriesByKey();
  const sites = LedgerCore.MEASURE_SITE_KEYS.filter(k => (series[k]||[]).length);
  if (!sites.length){
    wrap.innerHTML = '<div class="empty">Log a chest, shoulder, arm, forearm, thigh or calf measurement on the <b>Logs</b> tab — measured twice, they become a recomposition read the scale cannot give you.</div>';
    return;
  }
  const all = allWorkouts(), cat = exerciseCatalog();
  const sessions = Object.keys(all).map(d=>all[d]);
  const end = VIEW_DATE;
  const vol = sessions.length ? LedgerCore.weeklyVolumeByMuscle(sessions, cat, { from: addDaysISO(end,-6), to: end }) : {};
  const prog = sessions.length ? LedgerCore.muscleProgress(liftTrends(all, weightSeries()), cat) : {};
  const rows = LedgerCore.siteProgress(series, vol, prog);
  const hasWaist = (series.waist||[]).length >= 2;   // any waist history at all enables the ratio path

  const body = rows.map(r => {
    const [cls, phrase] = SITE_VERDICT[r.verdict] || SITE_VERDICT.thin;
    const cm = r.cmPerMonth == null ? '—'
      : `${r.cmPerMonth>0?'+':''}${r.cmPerMonth.toFixed(2)} cm/mo`;
    const ratio = r.ratioPctPerMonth == null ? ''
      : ` · vs waist ${r.ratioPctPerMonth>0?'+':''}${r.ratioPctPerMonth.toFixed(1)}%/mo`;
    // The set count is a SUM across every muscle under the site, so it is deliberately
    // larger than any one of them in the Volume-per-muscle panel. Name them, or the two
    // panels look like they disagree.
    const mNames = r.muscles.map(m=>(LedgerCore.MUSCLE_LABEL[m]||m).toLowerCase()).join(', ');
    const train = r.sets > 0
      ? `${r.sets % 1 ? r.sets.toFixed(1) : r.sets} sets/wk across ${escapeHtml(mNames)}`
      : 'not trained this week';
    const str = r.strengthPct == null ? ''
      : ` · strength ${r.strengthPct>0?'+':''}${r.strengthPct.toFixed(1)}%/mo`
        + (r.strengthConfidence ? ` <span class="lift-conf ${CONF_CLS[r.strengthConfidence]||'low'}">${r.strengthConfidence}</span>` : '');
    const sig = r.signal !== 'none' && SITE_SIGNAL[r.signal]
      ? `<div class="site-sig ${cls}">${SITE_SIGNAL[r.signal]}</div>` : '';
    // Name and the headline rate share the top line; everything qualifying it sits below,
    // so a long site name can never squeeze the number into a wrap.
    // Not enough baseline to quote a rate: say what is missing instead of extrapolating
    // tape noise into a monthly figure.
    const verdictLine = r.reliable
      ? `<div class="site-verdict ${cls}">${phrase}<span class="ink-dim site-ratio">${ratio}</span></div>`
      : `<div class="site-verdict flat"><span class="ink-dim">no rate yet — ${escapeHtml(r.reason || 'needs more readings')}</span></div>`;
    return `<div class="site-row">
      <div class="site-name">${escapeHtml(r.label)}</div>
      <div class="site-move ${r.reliable?cls:'flat'}">${r.reliable?cm:`${r.n} reading${r.n===1?'':'s'}`}</div>
      ${verdictLine}
      <div class="site-train ink-dim">${r.latest!=null?r.latest.toFixed(1)+' cm now · ':''}${train}${str}</div>
      ${r.reliable?sig:''}
    </div>`;
  }).join('');

  wrap.innerHTML = `<div class="mv-cap ink-dim">Measured tissue vs trained volume · trends over every logged measurement</div>`
    + body
    + (hasWaist ? '' : '<div class="mv-untagged">⚠ Log your waist alongside these. Without it a centimetre is just a centimetre — the ratio to the waist is what separates tissue from a general surplus.</div>')
    + (rows.length && !rows.some(r=>r.reliable)
        ? `<div class="mv-untagged">⚠ No site has a long enough baseline yet. A tape carries about half a centimetre of placement noise and real tissue moves slowly, so a slope fitted across a few days is noise, not growth. Measure weekly in the same conditions; rates appear after about ${LedgerCore.MEASURE_MIN_SPAN} days of total baseline.</div>` : '')
    + `<div class="mv-foot ink-dim">In a surplus everything grows, so the raw centimetre is not the signal — <b>vs waist</b> is. A site gaining on the waist is tissue; a site flat while the waist climbs is not. Strength is the second opinion: a tape that moves while the lifts do too is the one reading you can trust.</div>`;
}

function renderTopFoods() {
  const wrap = document.getElementById('topFoodsList');
  const count = {};
  allDays(true).forEach(d => d.ledger.forEach(e => {
    if (!e.name) return;
    // A bulk import row is one day's totals under a placeholder name. Counting it
    // as a food put "Gemini import" at rank 1 with more sightings than any real
    // ingredient — a chart of the thing you have never once eaten.
    if (e.source === 'import') return;
    count[e.name] = (count[e.name] || 0) + 1;
  }));

  const top = Object.entries(count).sort((a,b) => b[1] - a[1]).slice(0, 8);
  if (!top.length) { wrap.innerHTML = '<div class="empty">No history yet.</div>'; return; }

  const maxCount = top[0][1];
  // Bars are chalk. Eight rotating hues said nothing the length and the count did not
  // already say, and colour in this app means one thing: out of tolerance.
  wrap.innerHTML = top.map(([name, cnt], i) => {
    const pct = Math.max(15, (cnt / maxCount) * 100);
    return `<div class="topfood-item">
      <span class="topfood-rank">${i+1}</span>
      <div class="topfood-bar-wrap"><div class="topfood-bar" style="width:${pct}%"><span>${escapeHtml(name)}</span></div></div>
      <span class="topfood-count">×${cnt}</span>
    </div>`;
  }).join('');
}
