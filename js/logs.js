// logs.js -- The Logs view: the day's manual entries in one place — weigh-in, body
// measurements (with the U.S. Navy body-fat estimate they feed), and the supplement
// dose strip. Everything here writes to VIEW_DATE, the same day the rest of the app edits,
// and syncs per-day like the food ledger.

// ---- BODY MEASUREMENTS -----------------------------------------------------
// Stored as {date: {key: cm}} with per-date stamps, so a set taken on the phone and a
// correction made on the PC merge date-by-date through mergeSyncStates exactly like the
// weigh-ins and the ledger days. Only the fields you actually filled are stored.
function measureMap(){ try{ const m=JSON.parse(localStorage.getItem('ledger_measures')||'{}'); return m&&typeof m==='object'?m:{}; }catch(e){ return {}; } }
function measureMeta(){ try{ return JSON.parse(localStorage.getItem('ledger_measures_meta')||'{}'); }catch(e){ return {}; } }
function saveMeasures(map, meta){
  try{ localStorage.setItem('ledger_measures', JSON.stringify(map));
       localStorage.setItem('ledger_measures_meta', JSON.stringify(meta)); }catch(e){}
}

// The fields, in display order. `navy` marks the ones the body-fat estimate reads:
// true = both sexes, 'female' = only used in the women's formula (the hip). The rest are
// tracked for their own trend. `how` is shown once in the "How to measure" panel — the
// whole point of writing it down is that the same landmark is used every single time.
const MEASURE_FIELDS = [
  { key:'waist',   label:'Waist (navel)', navy:true,
    how:'Around the narrowest point, level with your navel. Stand relaxed, arms at your sides, tape horizontal all the way round. Measure after a normal breath out — never suck in or push the belly out.' },
  { key:'neck',    label:'Neck', navy:true,
    how:'Just below the Adam’s apple (larynx), with the tape sloping very slightly downward toward the front. Keep your shoulders down and don’t flare the neck out.' },
  { key:'hip',     label:'Hips', navy:'female',
    how:'Around the widest part of your buttocks, feet together, tape level to the floor. Required for the women’s body-fat estimate; optional for men, but a good progress marker.' },
  { key:'chest',   label:'Chest',
    how:'Around the fullest part, level with the nipples, arms relaxed at your sides. Measure after a normal exhale.' },
  { key:'shoulder',label:'Shoulders',
    how:'Around the widest part of your shoulders and deltoids, arms hanging relaxed.' },
  { key:'arm',     label:'Upper arm',
    how:'Around the largest part of the upper arm. Pick flexed or relaxed and always use the same one, on the same arm, every time.' },
  { key:'forearm', label:'Forearm',
    how:'Around the widest part below the elbow, arm relaxed and hanging at your side.' },
  { key:'thigh',   label:'Thigh',
    how:'Around the largest part of the upper thigh, just below the buttock crease. Weight even on both feet, same leg each time.' },
  { key:'calf',    label:'Calf',
    how:'Around the widest part of the calf, standing with your weight spread evenly.' }
];
const MEASURE_LABEL = {}; MEASURE_FIELDS.forEach(f=> MEASURE_LABEL[f.key] = f.label);

// The measures for a given day, or null. Empty objects are treated as "no data".
function measuresOn(date){ const m = measureMap()[date]; return m && Object.keys(m).length ? m : null; }
// Most recent day with any measures at or before `date` — the body-fat readout falls back
// to your last set when today's is blank, because a tape is not a daily ritual like a scale.
function latestMeasuresUpTo(date){
  const map = measureMap();
  const days = Object.keys(map).filter(d=> d<=date && map[d] && Object.keys(map[d]).length).sort();
  return days.length ? { date: days[days.length-1], m: map[days[days.length-1]] } : null;
}
// Body fat for one measurement set, using the current profile (height/sex don't change day
// to day, so reading them live is correct). Null unless the set has what the formula needs.
function bfFor(m){
  if (!m) return null;
  return LedgerCore.navyBodyFat(PROFILE.sex, +PROFILE.height, +m.waist, +m.neck, +m.hip);
}
// Body-fat % over time, one point per day that carries the needed tape marks — the series
// the trend and the recomp cross-check read.
function bfSeries(){
  const map = measureMap();
  return Object.keys(map).sort().map(d=>{
    const bf = bfFor(map[d]);
    return bf!=null ? { date:d, v:bf } : null;
  }).filter(Boolean);
}
// Waist over time (cm), the third axis for the recomp verdict.
function waistSeries(){
  const map = measureMap();
  return Object.keys(map).sort().map(d=> (+((map[d]||{}).waist)>0 ? { date:d, v:+map[d].waist } : null)).filter(Boolean);
}
// Waist trend over the last six weeks — the same horizon the lift trends and the weight
// trend use in the recomp card, so all three axes describe the same stretch of time.
function waistTrendRecent(){
  const s = waistSeries();
  if (s.length < 2) return null;
  const last = s[s.length-1].date;
  const recent = s.filter(e => (Date.parse(last)-Date.parse(e.date))/86400000 <= 42);
  return LedgerCore.measureTrend(recent.length>=2 ? recent : s);
}

// ---- rendering -------------------------------------------------------------
function renderMeasureForm(){
  const wrap = document.getElementById('measureForm'); if (!wrap) return;
  const cur = measureMap()[VIEW_DATE] || {};
  const sex = PROFILE.sex;
  wrap.innerHTML = MEASURE_FIELDS.map(f=>{
    const need = f.navy === true || (f.navy === 'female' && sex === 'female');
    const tag = need ? ' <span class="measure-req" title="feeds the body-fat estimate">◈</span>' : '';
    const v = cur[f.key] != null ? cur[f.key] : '';
    return `<div><label for="m_${f.key}">${escapeHtml(f.label)}${tag}</label>`
      + `<input type="number" id="m_${f.key}" data-mkey="${f.key}" min="0" step="0.1" inputmode="decimal" placeholder="cm" value="${v}"></div>`;
  }).join('');
}
function renderMeasureHowto(){
  const el = document.getElementById('measureHowtoBody'); if (!el) return;
  el.innerHTML = MEASURE_FIELDS.map(f=>
    `<div class="howto-item"><div class="howto-name">${escapeHtml(f.label)}</div><div class="howto-txt">${escapeHtml(f.how)}</div></div>`).join('');
}
function renderBodyFat(){
  const el = document.getElementById('bfReadout'); if (!el) return;
  const trendEl = document.getElementById('bfTrend');
  const latest = latestMeasuresUpTo(VIEW_DATE);
  const bf = latest ? bfFor(latest.m) : null;
  if (bf == null){
    // Say precisely what is missing rather than a generic prompt.
    const need = [];
    if (!(+PROFILE.height > 0)) need.push('your height in ⚙ Settings');
    const m = latest ? latest.m : {};
    if (!(+((m||{}).waist) > 0)) need.push('a waist measurement');
    if (!(+((m||{}).neck) > 0)) need.push('a neck measurement');
    if (PROFILE.sex === 'female' && !(+((m||{}).hip) > 0)) need.push('a hip measurement');
    el.className = '';
    el.innerHTML = `<div class="empty">Add ${need.length ? need.join(', ') : 'a waist and neck measurement'} to estimate body fat.</div>`;
    if (trendEl) trendEl.hidden = true;
    return;
  }
  const kg = latestWeight();
  const comp = kg > 0 ? LedgerCore.bodyComposition(kg, bf) : null;
  const stale = latest.date !== VIEW_DATE;
  el.className = 'bf-readout';
  el.innerHTML =
    `<div class="bf-big">${bf.toFixed(1)}<span class="bf-unit">% body fat</span></div>`
    + (comp ? `<div class="bf-split"><span><b>${comp.leanKg}</b> kg lean</span><span><b>${comp.fatKg}</b> kg fat</span><span class="sr-sub">at ${kg} kg</span></div>` : '')
    + `<div class="sr-sub" style="margin-top:6px">Navy tape estimate${stale ? ` · from your last set on ${fmtDMY(latest.date)}` : ''}. Trend matters more than the exact figure — it reads a few points high or low against a DEXA.</div>`;

  // Trend of the body-fat series itself, when there is enough to fit one.
  if (trendEl){
    const s = bfSeries();
    if (s.length >= 2){
      const last = s[s.length-1].date;
      const recent = s.filter(e => (Date.parse(last)-Date.parse(e.date))/86400000 <= 60);
      const tr = LedgerCore.measureTrend(recent.length>=2 ? recent : s);
      if (tr){
        const pm = tr.perMonth;
        const dir = Math.abs(pm) < 0.2 ? 'holding steady'
                  : pm < 0 ? `down ${Math.abs(pm).toFixed(1)} pts/month` : `up ${pm.toFixed(1)} pts/month`;
        const cls = Math.abs(pm) < 0.2 ? 'tactical' : (pm < 0 ? 'tactical good' : 'tactical bad');
        trendEl.hidden = false; trendEl.className = cls;
        trendEl.innerHTML = `<b>Body fat ${dir}</b> over the last ${s.length} logged set${s.length>1?'s':''} (${s[0].v.toFixed(1)}% → ${s[s.length-1].v.toFixed(1)}%).`;
      } else trendEl.hidden = true;
    } else trendEl.hidden = true;
  }
}
function renderMeasureLog(){
  const wrap = document.getElementById('measureLog'); if (!wrap) return;
  const map = measureMap();
  const dates = Object.keys(map).filter(d=> map[d] && Object.keys(map[d]).length).sort().reverse();
  if (!dates.length){ wrap.innerHTML = '<div class="empty">No measurements logged yet.</div>'; return; }
  // Only show columns that have at least one value, so the table stays narrow for someone
  // who only ever logs a waist.
  const cols = MEASURE_FIELDS.filter(f=> dates.some(d=> +((map[d]||{})[f.key]) > 0));
  const head = `<tr><th>Date</th>${cols.map(f=>`<th>${escapeHtml(f.label.replace(/\s*\(.*\)/,''))}</th>`).join('')}<th>BF%</th></tr>`;
  const rows = dates.slice(0, 30).map(d=>{
    const m = map[d];
    const cells = cols.map(f=> `<td>${+m[f.key]>0 ? (+m[f.key]).toFixed(1) : '—'}</td>`).join('');
    const bf = bfFor(m);
    return `<tr><td>${fmtDMY(d)}</td>${cells}<td>${bf!=null ? bf.toFixed(1) : '—'}</td></tr>`;
  }).join('');
  wrap.innerHTML = `<div style="overflow-x:auto"><table class="measure-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}
function renderLogsDate(){
  const note = document.getElementById('logsDateNote'); if (!note) return;
  const set = id => { const el = document.getElementById(id); if (el) el.textContent = VIEW_DATE===ACTIVE_DATE ? 'today' : prettyDate(VIEW_DATE); };
  set('wDate'); set('mDate');
  note.hidden = VIEW_DATE === ACTIVE_DATE;
  note.innerHTML = VIEW_DATE === ACTIVE_DATE ? '' : `Logging to <b>${prettyDate(VIEW_DATE)}</b> — use the date arrows in the header to return to today.`;
}
function renderLogsTab(){
  renderLogsDate();
  renderSupps();          // the daily dose strip, moved here from Plan
  renderMeasureForm();
  renderBodyFat();
  renderMeasureLog();
}

// ---- form actions ----------------------------------------------------------
document.getElementById('mSaveBtn').onclick = ()=>{
  const cur = {};
  document.querySelectorAll('#measureForm [data-mkey]').forEach(inp=>{
    const v = parseFloat(inp.value);
    if (v > 0) cur[inp.dataset.mkey] = Math.round(v*10)/10;
  });
  const map = measureMap(), meta = measureMeta();
  if (Object.keys(cur).length){ map[VIEW_DATE] = cur; }
  else { delete map[VIEW_DATE]; }        // all-blank save clears the day
  meta[VIEW_DATE] = new Date().toISOString();
  saveMeasures(map, meta); scheduleSync();
  renderBodyFat(); renderMeasureLog();
  const msg = document.getElementById('mFormMsg');
  msg.hidden = false;
  const n = Object.keys(cur).length;
  msg.textContent = n ? `Saved ${n} measurement${n>1?'s':''} for ${VIEW_DATE===ACTIVE_DATE?'today':prettyDate(VIEW_DATE)}.`
                      : `Cleared measurements for ${VIEW_DATE===ACTIVE_DATE?'today':prettyDate(VIEW_DATE)}.`;
  toast(n ? 'Measurements saved' : 'Measurements cleared');
};
document.getElementById('mClearBtn').onclick = ()=>{
  document.querySelectorAll('#measureForm [data-mkey]').forEach(inp=> inp.value='');
  const map = measureMap(), meta = measureMeta();
  if (map[VIEW_DATE]){ delete map[VIEW_DATE]; meta[VIEW_DATE] = new Date().toISOString();
    saveMeasures(map, meta); scheduleSync(); renderBodyFat(); renderMeasureLog(); }
  const msg = document.getElementById('mFormMsg'); msg.hidden = false;
  msg.textContent = `Cleared measurements for ${VIEW_DATE===ACTIVE_DATE?'today':prettyDate(VIEW_DATE)}.`;
};
renderMeasureHowto();
