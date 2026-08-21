// trends.js -- The Trends view: history, rolling averages, compliance heatmap,
// weight/TDEE/goal, fat-change estimate, and the weekly report card.

// ---- HISTORY PANEL ----
function dayOk(t){ return t.kcal >= FLOOR && t.kcal <= CEIL && t.p >= P_TARGET; }
function renderHistSummary(){
  const el = document.getElementById('histSummary');
  // Most recent CLOSED days (the open day is excluded so its running total doesn't
  // swing the average as the user eats), newest first.
  const all = closedDays();
  if (!all.length){ el.hidden = true; return; }
  const week = all.slice(0,7).map(d=>totalsOf(d.ledger));
  const avgK = week.reduce((s,t)=>s+t.kcal,0)/week.length;
  const avgP = week.reduce((s,t)=>s+t.p,0)/week.length;
  const okN = week.filter(dayOk).length;
  let streak = 0;
  for (const d of all){ if (dayOk(totalsOf(d.ledger))) streak++; else break; }
  el.hidden = false;
  el.textContent = `Last ${week.length} logged ${week.length>1?'days':'day'}: avg ${Math.round(avgK)} kcal · ${avgP.toFixed(0)}g protein · ${okN} of ${week.length} on target` + (streak>1 ? ` · ${streak}-day streak` : '');
}
function renderHistory(){
  renderHistSummary();
  const wrap = document.getElementById('histList');
  const days = allDays(false);
  if (!days.length){ wrap.innerHTML = '<div class="empty">No previous days yet.</div>'; return; }
  wrap.innerHTML = days.map((d,di)=>{
    const t = totalsOf(d.ledger);
    const inC = t.kcal >= FLOOR && t.kcal <= CEIL;
    const pOk = t.p >= P_TARGET;
    const mark = inC && pOk ? '<span style="color:var(--verdigris)">✓</span>'
               : t.kcal > CEIL ? '<span style="color:var(--hot)">✗</span>'
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
const TREND_W = 300, TREND_H = 70, TREND_PADL = 4, TREND_PADR = 34,
      TREND_PADT = 8, TREND_PADB = 14, TREND_DAYS = 45;

function trendSeries(){
  const map = weightsMap(), tot = {};
  closedDays().forEach(d => { tot[d.date] = totalsOf(d.ledger); });   // open day excluded, as elsewhere
  const dates = Array.from(new Set(Object.keys(map).concat(Object.keys(tot))))
    .filter(d => (+map[d] > 0) || (tot[d] && tot[d].kcal > 0)).sort();
  if (!dates.length) return null;
  // Window the last TREND_DAYS, but never draw empty axis: with three weeks of
  // history the charts should span three weeks, not sit squashed into a corner.
  const end = dates[dates.length - 1];
  const start = [addDaysISO(end, -(TREND_DAYS - 1)), dates[0]].sort().pop();
  const inWin = d => d >= start && d <= end;
  return { start, end,
    w: dates.filter(d => inWin(d) && +map[d] > 0).map(d => ({ date:d, kg:+map[d] })),
    k: dates.filter(d => inWin(d) && tot[d] && tot[d].kcal > 0).map(d => ({ date:d, kcal:tot[d].kcal })) };
}
// The shared x-mapping. Both charts call this, which is the whole point.
function trendX(s){
  const t0 = Date.parse(s.start), t1 = Date.parse(s.end);
  const uW = TREND_W - TREND_PADL - TREND_PADR;
  return d => TREND_PADL + (t1 === t0 ? uW/2 : uW * (Date.parse(d) - t0) / (t1 - t0));
}
function trendAxis(s){
  return `<text x="${TREND_PADL}" y="${TREND_H-2}" font-size="8" fill="var(--faint)" font-family="var(--data)">${s.start}</text>`
       + `<text x="${TREND_W-2}" y="${TREND_H-2}" text-anchor="end" font-size="8" fill="var(--faint)" font-family="var(--data)">${s.end}</text>`;
}
function trendSVG(inner){
  return `<svg viewBox="0 0 ${TREND_W} ${TREND_H}" style="width:100%;display:block">${inner}</svg>`;
}
function weightChartSVG(s, X){
  const pts = s.w;
  if (pts.length < 2) return '';
  const uH = TREND_H - TREND_PADT - TREND_PADB;
  const kMin = Math.min(...pts.map(p=>p.kg)), kMax = Math.max(...pts.map(p=>p.kg));
  const yPad = Math.max(0.3, (kMax-kMin)*0.15);
  const Y = k => TREND_PADT + uH*(1-(k-kMin+yPad)/((kMax-kMin)+2*yPad));
  const path = pts.map((p,i)=>`${i?'L':'M'}${X(p.date).toFixed(1)},${Y(p.kg).toFixed(1)}`).join(' ');
  const dots = pts.map(p=>`<circle cx="${X(p.date).toFixed(1)}" cy="${Y(p.kg).toFixed(1)}" r="2" fill="var(--chalk)"/>`).join('');
  const last = pts[pts.length-1];
  return trendSVG(
    `<path d="${path}" fill="none" stroke="var(--chalk)" stroke-width="1.5" stroke-linejoin="round"/>${dots}`
    + `<text x="${TREND_W-2}" y="${Y(last.kg)+3}" text-anchor="end" font-size="9" fill="var(--graphite)" font-family="var(--data)">${last.kg}kg</text>`
    + trendAxis(s));
}
// Intake against the corridor. The band is the corridor; a dot only takes colour
// when the day landed out of tolerance, same rule as everything else here.
function kcalChartSVG(s, X){
  const pts = s.k;
  if (pts.length < 2) return '';
  const uH = TREND_H - TREND_PADT - TREND_PADB;
  const yMax = Math.max(CEIL*1.15, ...pts.map(p=>p.kcal)) * 1.02;
  const Y = v => TREND_PADT + uH*(1 - v/yMax);
  const bTop = Y(CEIL), bBot = Y(FLOOR);
  const band = `<rect x="${TREND_PADL}" y="${bTop.toFixed(1)}" width="${TREND_W-TREND_PADL-TREND_PADR}" height="${(bBot-bTop).toFixed(1)}" fill="var(--chalk-wash)"/>`
    + `<line x1="${TREND_PADL}" y1="${bBot.toFixed(1)}" x2="${TREND_W-TREND_PADR}" y2="${bBot.toFixed(1)}" stroke="var(--rule-lit)" stroke-width="1" stroke-dasharray="3 3"/>`
    + `<line x1="${TREND_PADL}" y1="${bTop.toFixed(1)}" x2="${TREND_W-TREND_PADR}" y2="${bTop.toFixed(1)}" stroke="var(--rule-lit)" stroke-width="1" stroke-dasharray="3 3"/>`;
  const path = pts.map((p,i)=>`${i?'L':'M'}${X(p.date).toFixed(1)},${Y(p.kcal).toFixed(1)}`).join(' ');
  const dots = pts.map(p=>{
    const c = p.kcal > CEIL ? 'var(--hot)' : p.kcal >= FLOOR ? 'var(--chalk)' : 'var(--brass)';
    return `<circle cx="${X(p.date).toFixed(1)}" cy="${Y(p.kcal).toFixed(1)}" r="2.2" fill="${c}"/>`;
  }).join('');
  return trendSVG(band
    + `<path d="${path}" fill="none" stroke="var(--chalk)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}`
    + `<text x="${TREND_W-2}" y="${(bTop+3).toFixed(1)}" text-anchor="end" font-size="8" fill="var(--faint)" font-family="var(--data)">${Math.round(CEIL)}</text>`
    + trendAxis(s));
}

function renderWeight(){
  document.getElementById('wDate').textContent = VIEW_DATE===ACTIVE_DATE ? 'today' : VIEW_DATE;
  const map = weightsMap();
  const inEl = document.getElementById('wIn');
  if (document.activeElement !== inEl) inEl.value = map[VIEW_DATE] || '';
  const entries = Object.keys(map).sort().map(d=>({date:d, kg:+map[d]})).filter(e=>e.kg>0);
  const chart = document.getElementById('wChart'), kChart = document.getElementById('kcalChart');
  const stats = document.getElementById('wStats');

  const s = trendSeries();
  const X = s ? trendX(s) : null;
  chart.innerHTML  = s ? (weightChartSVG(s, X) || '<div class="empty">Two weigh-ins draw the trend.</div>') : '';
  kChart.innerHTML = s ? (kcalChartSVG(s, X)   || '<div class="empty">Close two days to draw intake.</div>') : '';
  document.getElementById('wChartCap').textContent = 'Weight · kg';
  document.getElementById('kChartCap').textContent = `Intake · kcal vs ${Math.round(FLOOR)}–${Math.round(CEIL)}`;

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
  const days7 = allDays(true).slice(0,7);
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
    if (!(td.blended>0)){ out.className='tactical'; out.innerHTML='Fill in your <b>body profile</b> in ⚙ Settings (or a maintenance range above) to estimate fat change.'; return; }
    const m=Math.round(150 - 75*td.w);            // ±150 early, tightening to ±75 fully calibrated
    maintLow=td.blended-m; maintHigh=td.blended+m;
    maintTxt = `adaptive TDEE ${td.blended.toLocaleString()} ±${m}`;
  }
  let start=startEl.value, end=endEl.value;
  if (start>end){ const t=start; start=end; end=t; }        // tolerate a reversed range

  const tot={}; allDays(true).forEach(d => { tot[d.date]=totalsOf(d.ledger); });
  const intakes=[];
  Object.keys(tot).forEach(d => { if (d>=start && d<=end && tot[d].kcal>0) intakes.push(tot[d].kcal); });
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
  let eva='';
  if (wIn.length>=2){
    const actual = +map[wIn[wIn.length-1]] - +map[wIn[0]];
    const expected = (e.sum - ((maintLow+maintHigh)/2)*e.n)/7700;
    const agree = Math.abs(actual-expected) < 0.4;
    eva = `<span style="display:block;margin-top:5px;color:var(--graphite);border-left:2px solid var(--rule);padding-left:8px">`
      + `Scale check: expected ${expected>=0?'+':''}${expected.toFixed(2)} kg, actual ${actual>=0?'+':''}${actual.toFixed(2)} kg`
      + ` — ${agree?'model is tracking your weight':'diverging — logging gaps or maintenance is off'}.</span>`;
  }
  // Raw ingredients for a by-hand maintenance check: avg intake + real weight delta over the range.
  const avgIn=Math.round(e.sum/e.n);
  let raw=`<span style="display:block;margin-top:5px;color:var(--graphite);border-left:2px solid var(--rule);padding-left:8px">`
    + `Avg intake <b>${avgIn.toLocaleString()}</b> kcal/day over ${e.n} logged day${e.n>1?'s':''}`;
  if (wIn.length>=2){
    const first=+map[wIn[0]], last=+map[wIn[wIn.length-1]];
    const dw=last-first, wdays=Math.round((Date.parse(wIn[wIn.length-1])-Date.parse(wIn[0]))/86400000);
    raw+=` · weight ${first}→${last} kg (<b>${dw>=0?'+':''}${dw.toFixed(1)} kg</b> over ${wdays} day${wdays>1?'s':''})`;
    // Maintenance from your own numbers: intake minus the daily kcal the weight change accounts for.
    if (wdays>0){
      const maint=Math.round((avgIn - dw*7700/wdays)/5)*5;
      raw+=` → implied maintenance ≈ <b>${maint.toLocaleString()}</b> kcal/day`;
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
  const tr = winW.length>=2 ? LedgerCore.weightTrend(winW) : null;
  const sampleDays = winW.length>=2 ? Math.round((Date.parse(winW[winW.length-1].date)-Date.parse(winW[0].date))/86400000)+1 : 0;
  const tot={}; allDays(true).forEach(d=>{ tot[d.date]=totalsOf(d.ledger); });
  // Exclude the still-open day: its partial intake would drag the average (and thus the
  // adaptive corridor) around as you log meals. TDEE only moves when a day closes.
  const intakes=Object.keys(tot).filter(d=>d>=start && d<=end && d!==ACTIVE_DATE && tot[d].kcal>0).map(d=>tot[d].kcal);
  const avgIntake = intakes.length ? intakes.reduce((a,b)=>a+b,0)/intakes.length : 0;
  const cal = LedgerCore.calibrateTDEE(formula, avgIntake, tr?tr.ratePerWeek:null, sampleDays);
  return Object.assign(cal, {kg, avgIntake:Math.round(avgIntake), sampleDays,
    formulaBase: formula, ratePerWeek: tr?tr.ratePerWeek:null,
    intakes: intakes, nWeighIns: winW.length});
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
  const td = GOAL.mode!=='off' ? computeTDEE() : null;
  const boundsFor = date => {
    if (!td || !(td.blended>0)) return { floor: FLOOR_M, ceil: CEIL_M };
    const off = TRAIN.cycle
      ? (isTrainingDay(date) ? (+TRAIN.trainOffset||0) : (+TRAIN.restOffset||0))
      : goalOffset();
    return LedgerCore.corridorFromTDEE(td.blended, off, GOAL.band||100);
  };
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
    echo('tactical', 'Add your age and height in <b>⚙ Settings</b> to get an adaptive TDEE.');
    return;
  }
  const bits=[];
  if (hasProfile) bits.push(`formula ${td.formula.toLocaleString()}`);
  bits.push(td.dataTDEE!=null
    ? `measured ${td.dataTDEE.toLocaleString()} (${Math.round(td.w*100)}% weighted over ${td.sampleDays}d)`
    : `measured pending — needs ~7+ days of weigh-ins`);
  // Say so when weigh-ins are being excluded, or the number looks unexplained.
  if (TREND_START) bits.push(`weigh-ins before ${TREND_START} excluded`);
  out.className='tactical good';
  out.innerHTML = `<b>Adaptive TDEE ≈ ${td.blended.toLocaleString()} kcal/day</b> · ${bits.join(' · ')}.`;
  echo('tactical good', `<b>Adaptive TDEE ≈ ${td.blended.toLocaleString()} kcal/day</b> · ${bits.join(' · ')}. Edit your profile in ⚙ Settings.`);
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
    const days=allDays(false); if(!days.length) return;      // nothing to brief on yet
    const yt=totalsOf(days[0].ledger);
    const yMark = yt.kcal>CEIL_M?'over ceiling':(yt.kcal>=FLOOR_M?'in corridor ✓':'under floor');
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
    card.className='digest-card '+(yMark.includes('✓')?'good':(yt.kcal>CEIL_M?'bad':'meh'));
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
    const tots = arr.map(d => totalsOf(d.ledger));
    return {
      kcal: tots.reduce((s,t) => s+t.kcal, 0) / tots.length,
      p: tots.reduce((s,t) => s+t.p, 0) / tots.length,
      ok: tots.filter(dayOk).length,
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
  renderMuscleVolume();
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
  const okDays = tots.filter(dayOk).length;

  // Best and worst days
  const sorted = [...tots].sort((a,b) => {
    const aOk = dayOk(a) ? 1 : 0;
    const bOk = dayOk(b) ? 1 : 0;
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
    sampleDays: td.sampleDays, intakes: td.intakes||[], nWeighIns: td.nWeighIns||0 });
  const trust = LedgerCore.dataTrust({
    intakeCV: rd.cv, nIntakeDays: rd.nIntakeDays, nWeighIns: rd.nWeighIns, spanDays: spanDays });
  const dot = it => it.ok ? '<span class="trust-dot ok">●</span>'
                   : it.warn ? '<span class="trust-dot warn">●</span>' : '<span class="trust-dot bad">●</span>';
  const rows = trust.items.map(it =>
    `<div class="trust-row">${dot(it)}<span>${escapeHtml(it.label)}</span><span class="ink-dim">want ${escapeHtml(it.want)}</span></div>`).join('');
  // The TDEE disagreement is the headline the old readout hid: regression vs formula can be
  // hundreds of kcal apart, and the honest answer is the interval, not one number.
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
    + `<div class="trust-foot ink-dim">Trust tier: <b class="trust-${trust.tier}">${trust.tier}</b>. `
    + `These gate how much to believe the adaptive corridor, the fat-change estimate and the recomp read.</div>`;
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
  const end = Object.keys(all).sort().pop() || VIEW_DATE;
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
