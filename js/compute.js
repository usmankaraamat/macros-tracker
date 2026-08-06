// compute.js -- Deterministic per-entry math and the day/history aggregates that
// every view reads. Thin glue over core.js -- no DOM.

// ---- CORE: compute one entry's contribution with penalties applied ----
// base = per-100g nutrients; source tags provenance so AI estimates read as provisional.
// partOf (optional): the dish this entry was decomposed out of. Every recompute path
// must pass it through or a grams edit would quietly orphan an ingredient from its meal.
function computeEntry(name, grams, weighed, base, source, partOf) {
  base = base || getBase(name);
  return LedgerCore.computeEntry(name, grams, weighed, base, source,
    {inflate:INFLATE, deduct:DEDUCT}, partOf);
}

// Escape untrusted text (food/template/dish names from AI, USDA, imports, sync) before
// it goes into any innerHTML/SVG string. Names are the one field an attacker can shape,
// and localStorage holds the sync passphrase + API keys, so an unescaped name is a
// credential-theft XSS. Works for both HTML and SVG text contexts.
function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// Log an entry, stamping the real wall-clock time it was added so meal-timing features
// can learn from it later. Only the live day gets a timestamp — a back-filled past day
// would carry a misleading "now", so those stay unstamped.
function pushEntry(e){ if (VIEW_DATE === ACTIVE_DATE) e.at = new Date().toISOString(); ledger.push(e); return e; }
function totalsOf(l) {
  return l.reduce((t,e)=>({
    kcal:t.kcal+e.kcal, p:t.p+e.p, f:t.f+e.f, c:t.c+(e.c||0), ca:t.ca+e.ca, ph:t.ph+e.ph,
    fib:t.fib+(e.fib||0), sug:t.sug+(e.sug||0), na:t.na+(e.na||0),
    k:t.k+(e.k||0), mg:t.mg+(e.mg||0), fe:t.fe+(e.fe||0), zn:t.zn+(e.zn||0), vc:t.vc+(e.vc||0), vd:t.vd+(e.vd||0)
  }), {kcal:0,p:0,f:0,c:0,ca:0,ph:0,fib:0,sug:0,na:0,k:0,mg:0,fe:0,zn:0,vc:0,vd:0});
}
function totals(){ return totalsOf(ledger); }

// ---- HISTORY: every logged day already lives in localStorage under ledger_YYYY-MM-DD ----
function allDays(includeToday){
  const days = [];
  try {
    for (let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      const m = k && k.match(/^ledger_(\d{4}-\d{2}-\d{2})$/);
      if (!m) continue;
      if (!includeToday && m[1]===VIEW_DATE) continue;   // caller overlays the in-memory day itself
      try {
        const l = JSON.parse(localStorage.getItem(k));
        if (Array.isArray(l) && l.length) days.push({date:m[1], ledger:l});
      } catch(e){}
    }
  } catch(e){}
  return days.sort((a,b)=> a.date<b.date ? 1 : -1);   // newest first
}

// Days for rolling stats: every stored day EXCEPT the open (live) day. The open day is
// still changing as the user eats, so counting it makes the averages fluctuate all day.
// A *past* day being edited on-screen is overlaid with its live in-memory ledger.
function closedDays(){
  const days = allDays(true).filter(d => d.date !== ACTIVE_DATE);
  if (ledger.length && VIEW_DATE !== ACTIVE_DATE){
    const i = days.findIndex(d => d.date === VIEW_DATE);
    if (i >= 0) days[i] = {date: VIEW_DATE, ledger}; else days.push({date: VIEW_DATE, ledger});
  }
  return days.sort((a,b)=> a.date<b.date ? 1 : -1);   // newest first
}

// ---- SOLVER: rice(r) + chicken(k) grams to LAND at FLOOR kcal, protein as a floor ----
// kcal-to-floor is an equality (land at 1700, don't overshoot toward ceiling).
// protein-to-120 is a FLOOR (>= fine, overshoot allowed) — this distinction matters:
// forcing protein-equality falsely flags satisfiable cases as conflicts.
function solveFridge(t) {
  return LedgerCore.solveFridge(t, {floor:FLOOR, ceil:CEIL, pTarget:P_TARGET, rice:RICE, chk:CHK});
}
