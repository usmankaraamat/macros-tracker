// app.js -- Boot, wiring, tab control, settings, import/export, service worker.

const gearBtn = document.getElementById('gear');
gearBtn.onclick = ()=>{
  const p = document.getElementById('settingsPanel');
  const open = p.hidden;
  p.hidden = !open;
  gearBtn.setAttribute('aria-expanded', String(open));
  if (open) p.scrollIntoView({ block:'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
};

function refreshKeyUI(){
  const st = document.getElementById('keyStatus');
  const bits = [];
  bits.push(hasUSDA() ? 'USDA ✓ (your key)' : 'USDA — not set');
  bits.push(hasGemini() ? 'Gemini ✓' : 'Gemini — not set');
  if (hasOR()) bits.push('OpenRouter ✓');
  st.textContent = bits.join('  ·  ') + (hasUSDA()&&hasAI() ? '  · all systems go.' : '  · AI parse disabled until a Gemini or OpenRouter key is set.');
  document.getElementById('usdaBtn').disabled = !hasUSDA();
  // A dead send button with no explanation is a dead end — say why it is off.
  const send = document.getElementById('parseBtn');
  send.disabled = !hasAI();
  send.title = hasAI() ? 'Parse meal (Enter)' : 'Add a Gemini or OpenRouter key in ⚙ Settings to parse meals';
  document.getElementById('nlInput').placeholder = hasAI()
    ? 'Describe a meal…'
    : 'No AI key — use ⌃ to search USDA';
}
document.getElementById('saveKeys').onclick = ()=>{
  setKey(LS.usda,  document.getElementById('usdaKey').value.trim());
  setKey(LS.gem,   document.getElementById('geminiKey').value.trim());
  setKey(LS.model, document.getElementById('geminiModel').value.trim());
  setKey(LS.or,    document.getElementById('orKey').value.trim());
  refreshKeyUI();
  setStatus(document.getElementById('keyStatus'),
    'Saved. ' + (hasUSDA()&&hasAI() ? 'All systems go.' : 'Some keys still missing.'),
    (hasUSDA()&&hasAI()) ? 'good' : null);
};

document.getElementById('saveSync').onclick = ()=>{
  setKey(LS.supaUrl, document.getElementById('supaUrl').value.trim());
  setKey(LS.supaKey, document.getElementById('supaKey').value.trim());
  setKey(LS.pass,    document.getElementById('syncPass').value);
  syncCreds = null;                            // passphrase may have changed — re-derive
  const st = document.getElementById('syncStatus');
  if (syncConfigured()){ setStatus(st, 'Saved — syncing…', 'good'); syncNow(); }
  else { setSyncDot('off'); setStatus(st, 'Sync off — set a passphrase to enable it.'); }
};
document.getElementById('syncNowBtn').onclick = ()=>{
  const st = document.getElementById('syncStatus');
  if (!syncConfigured()){ setStatus(st, 'Set a passphrase and Save sync first.', 'bad'); return; }
  setStatus(st, 'Syncing…'); syncNow();
};

// Discover which models this key can actually use, and pick a valid one.
document.getElementById('loadModelsBtn').onclick = async ()=>{
  const st = document.getElementById('keyStatus');
  setKey(LS.gem, document.getElementById('geminiKey').value.trim());  // use whatever's typed
  refreshKeyUI();
  if (!hasGemini()){ setStatus(st, 'Enter your Gemini key first.', 'bad'); return; }
  setStatus(st, 'Loading available models…');
  try {
    const list = await listGeminiModels();
    if (!list.length){ setStatus(st, 'No usable models returned for this key.', 'bad'); return; }
    document.getElementById('modelList').innerHTML = list.map(n=>`<option value="${n}">`).join('');
    const field = document.getElementById('geminiModel');
    const cur = field.value.trim();
    if (!list.includes(cur)) {
      const alt = pickModel(list);
      field.value = alt; setKey(LS.model, alt);
      setStatus(st, `${list.length} models found — set to “${alt}”. Click a suggestion to change, then Save.`, 'good');
    } else {
      setStatus(st, `${list.length} models found — current “${cur}” is valid.`, 'good');
    }
  } catch(err){ setStatus(st, err.message, 'bad'); }
};

// Manual USDA search → clickable results that load into the picker.
document.getElementById('usdaBtn').onclick = async ()=>{
  const q = document.getElementById('usdaSearch').value.trim();
  const out = document.getElementById('searchResults');
  if (!q){ out.innerHTML=''; return; }
  out.innerHTML = skeleton(4);
  announce('Searching USDA');
  try {
    const results = await usdaSearch(q);
    if (!results.length){
      out.innerHTML = `<div class="tactical">No matches for “${escapeHtml(q)}”. Try a plainer name — "greek yogurt" rather than a brand.</div>`;
      return;
    }
    out.innerHTML = results.map((r,i)=>
      `<div class="result">
         <div><div class="rname">${escapeHtml(r.name)}</div>
           <div class="rmeta">${Math.round(r.base.kcal)} kcal · P ${r.base.p.toFixed(1)} · F ${r.base.f.toFixed(1)} /100g</div></div>
         <button type="button" class="sm ghost" data-i="${i}">Use</button>
       </div>`).join('');
    out.querySelectorAll('button[data-i]').forEach(btn=>{
      btn.onclick = ()=>{
        const r = results[+btn.dataset.i];
        registerFood(r.name, r.base, 'USDA');
        document.getElementById('food').value = r.name;
        out.innerHTML = `<div class="tactical good">Loaded “${escapeHtml(r.name)}”. Set grams below and add.</div>`;
        updateProjection();
        document.getElementById('grams').focus();
      };
    });
  } catch(err){ out.innerHTML = `<div class="tactical bad">${err.message}</div>`; }
};

// ---- NAVIGATION DRAWER ----------------------------------------------------
// Sections live in a drawer so the bottom edge can belong to the composer.
const navToggleBtn = document.getElementById('navToggle');
const sidebarEl = document.getElementById('sidebar');
const navBackdropEl = document.getElementById('navBackdrop');
function navOpen(){
  if (!sidebarEl.hidden) return;
  sidebarEl.hidden = false;
  navBackdropEl.hidden = false;
  navToggleBtn.setAttribute('aria-expanded', 'true');
  const cur = sidebarEl.querySelector('[aria-selected="true"]');
  (cur || sidebarEl.querySelector('button')).focus();
}
function navClose(returnFocus){
  if (sidebarEl.hidden) return;
  sidebarEl.hidden = true;
  navBackdropEl.hidden = true;
  navToggleBtn.setAttribute('aria-expanded', 'false');
  if (returnFocus) navToggleBtn.focus();
}
navToggleBtn.onclick = ()=> sidebarEl.hidden ? navOpen() : navClose(true);
document.getElementById('navClose').onclick = ()=> navClose(true);
navBackdropEl.onclick = ()=> navClose(true);

// ---- TABS -----------------------------------------------------------------
// Four views share one scroll; the drawer swaps which <main> is visible. Only
// the visible tab is rendered, so a keystroke on Today no longer rebuilds the
// heatmap, the ternary plot and every lift trend.
const TABS = { today:'tabToday', plan:'tabPlan', lift:'tabLift', trends:'tabTrends' };
function showTab(name){
  if (!TABS[name]) name = 'today';
  ACTIVE_TAB = name;
  Object.keys(TABS).forEach(t=>{
    const view = document.getElementById(TABS[t]);
    if (view) view.hidden = (t !== name);
  });
  document.querySelectorAll('.sidebar-tabs button').forEach(b=>
    b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  // The composer is a Today control — it is hidden, and its space reclaimed,
  // everywhere else.
  const onToday = name === 'today';
  document.getElementById('composer').hidden = !onToday;
  document.body.classList.toggle('with-composer', onToday);
  if (!onToday) closeComposerMenu();
  try{ localStorage.setItem('ledger_tab', name); }catch(e){}
  window.scrollTo({top:0, behavior:'auto'});
  render();   // charts that measure layout (ternary) size correctly when first revealed
}
document.querySelectorAll('.sidebar-tabs button').forEach(b=>{
  b.onclick = ()=>{ showTab(b.dataset.tab); navClose(true); };
});
// Arrow keys move between tabs, which is what a vertical tablist is expected to do.
document.querySelector('.sidebar-tabs').addEventListener('keydown', ev=>{
  const keys = Object.keys(TABS);
  const i = keys.indexOf(ACTIVE_TAB);
  let next = null;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') next = keys[(i + 1) % keys.length];
  else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') next = keys[(i - 1 + keys.length) % keys.length];
  else if (ev.key === 'Home') next = keys[0];
  else if (ev.key === 'End') next = keys[keys.length - 1];
  if (!next) return;
  ev.preventDefault();
  showTab(next);
  document.getElementById('tabbtn-' + next).focus();
});
// Escape closes whichever overlay is open, drawer first. A bottom sheet owns
// Escape while it is up (openSheet handles it), so defer to it.
document.addEventListener('keydown', ev=>{
  if (ev.key !== 'Escape' || _sheetClose) return;
  if (!sidebarEl.hidden){ ev.preventDefault(); navClose(true); return; }
  const menu = document.getElementById('composerMenu');
  if (menu && !menu.hidden){ ev.preventDefault(); closeComposerMenu(true); }
});

// ---- DAY NAVIGATION -------------------------------------------------------
// The header date steps back through history and forward to the live day. This
// used to be reachable only by hunting for a cell in the compliance heatmap.
document.getElementById('dayPrev').onclick = ()=> viewDay(prevDayStr(VIEW_DATE), true);
document.getElementById('dayNext').onclick = ()=> viewDay(nextDay(VIEW_DATE), true);

// ---- THE COMPOSER ---------------------------------------------------------
// One input pinned to the bottom. Enter parses; the ⌃ opens the other ways in —
// camera, gallery, and the manual USDA search, which used to be a separate
// button competing with Parse for the same row.
const nlInputEl = document.getElementById('nlInput');
const composerMenuEl = document.getElementById('composerMenu');
const composerMoreBtn = document.getElementById('composerMore');

function closeComposerMenu(returnFocus){
  if (composerMenuEl.hidden) return;
  composerMenuEl.hidden = true;
  composerMoreBtn.setAttribute('aria-expanded', 'false');
  if (returnFocus) composerMoreBtn.focus();
}
composerMoreBtn.onclick = ()=>{
  const open = composerMenuEl.hidden;
  composerMenuEl.hidden = !open;
  composerMoreBtn.setAttribute('aria-expanded', String(open));
  if (open) composerMenuEl.querySelector('button').focus();
};

// The bar grows with the text up to a few lines, then scrolls — a chat bar that
// stays one line when you have typed one line. An empty box drops back to its
// min-height rather than sizing itself to a placeholder that wraps.
function autoGrow(){
  nlInputEl.style.height = '';
  if (!nlInputEl.value) return;
  nlInputEl.style.height = 'auto';
  nlInputEl.style.height = Math.min(nlInputEl.scrollHeight, 132) + 'px';
}
nlInputEl.addEventListener('input', autoGrow);
autoGrow();

// Reveal the manual USDA block (in the page, where it has room) and take the
// user to it. Called from the ⌃ menu and from the frequent-food chips.
function openManual(){
  const blk = document.getElementById('manualBlock');
  blk.hidden = false;
  document.getElementById('manualToggle').setAttribute('aria-expanded', 'true');
  blk.scrollIntoView({ block:'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  return blk;
}
document.getElementById('manualToggle').onclick = ()=>{
  const blk = document.getElementById('manualBlock');
  closeComposerMenu();
  if (blk.hidden){
    openManual();
    document.getElementById('usdaSearch').focus({ preventScroll: true });
  } else {
    blk.hidden = true;
    document.getElementById('manualToggle').setAttribute('aria-expanded', 'false');
  }
};
// The photo pickers are wired in food.js; they only need the menu to get out of
// the way once they have fired.
['photoBtn','galleryBtn'].forEach(id =>
  document.getElementById(id).addEventListener('click', ()=> closeComposerMenu()));
// A click anywhere else dismisses the menu, the way a menu is expected to behave.
document.addEventListener('click', ev=>{
  if (composerMenuEl.hidden) return;
  if (!document.getElementById('composer').contains(ev.target)) closeComposerMenu();
});

// Ghost needle: while the manual grams field holds a value, show where the
// instrument will land once this item is added — errors caught before they happen.
function clearProjection(){ const p=document.getElementById('projCursor'); if (p) p.hidden = true; }
function updateProjection(){
  const proj = document.getElementById('projCursor');
  if (!proj) return;
  const name = document.getElementById('food').value;
  const grams = parseFloat(document.getElementById('grams').value);
  const base = getBase(name);
  if (!name || !base || !grams || grams<=0){ proj.hidden = true; return; }
  const add = computeEntry(name, grams, document.getElementById('weighed').checked, false, false, base, foodSource[name]||'DB');
  proj.style.left = scalePct(totals().kcal + add.kcal) + '%';
  proj.hidden = false;
}
document.getElementById('grams').addEventListener('input', updateProjection);
document.getElementById('food').addEventListener('change', updateProjection);

// Targets: user-overridable, protocol defaults recoverable in one tap.
function fillTargetInputs(){
  document.getElementById('tFloor').value = FLOOR_M;
  document.getElementById('tCeil').value  = CEIL_M;
  document.getElementById('tP').value     = P_CFG.val;
  document.getElementById('tPMode').value = P_CFG.mode;
  document.getElementById('tCMax').value  = C_CAP.val || '';
  document.getElementById('tCMode').value = C_CAP.mode;
  document.getElementById('tFMax').value  = F_CAP.val || '';
  document.getElementById('tFMode').value = F_CAP.mode;
  document.getElementById('penK').value   = Math.round((INFLATE-1)*100);
  document.getElementById('penP').value   = Math.round((1-DEDUCT)*100);
  document.getElementById('penOK').value  = OIL_KCAL;
  document.getElementById('penOF').value  = OIL_FAT;
  fillMealPlan(); fillTrain();
}
// Meal plan editor: one "HH:MM kcal Name" per line.
function mealPlanToText(){ return MEAL_PLAN.map(m=>`${m.t} ${m.kcal} ${m.name}`).join('\n'); }
function fillMealPlan(){ const el=document.getElementById('mealPlanInput'); if (el && document.activeElement!==el) el.value = mealPlanToText(); }
function parseMealPlan(txt){
  const out=[];
  String(txt||'').split('\n').forEach(line=>{
    const m=/^\s*(\d{1,2}:\d{2})\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && hoursOf(m[1])!=null) out.push({t:m[1], kcal:+m[2], name:m[3].trim()});
  });
  return out.sort((a,b)=>hoursOf(a.t)-hoursOf(b.t));
}
// Training schedule editor.
function trainSplitToText(){ return TRAIN.split.map((s,i)=>`${WEEKDAYS[i]} ${s}`).join('\n'); }
function fillTrain(){
  const el=document.getElementById('trainSplitInput'); if(!el) return;
  if (document.activeElement!==el) el.value = trainSplitToText();
  document.getElementById('trainStart').value  = TRAIN.start;
  document.getElementById('trainEnd').value    = TRAIN.end;
  document.getElementById('trainCycle').checked = TRAIN.cycle;
  document.getElementById('trainOffset').value = TRAIN.trainOffset;
  document.getElementById('restOffset').value  = TRAIN.restOffset;
  document.getElementById('cycleOffsets').hidden = !TRAIN.cycle;
}
function parseTrainSplit(txt){
  const map={mon:0,tue:1,wed:2,thu:3,fri:4,sat:5,sun:6};
  const out = TRAIN.split.slice();
  String(txt||'').split('\n').forEach(line=>{
    const m=/^\s*([A-Za-z]{3})[A-Za-z]*\s+(.+?)\s*$/.exec(line);
    if (m){ const idx=map[m[1].toLowerCase()]; if (idx!=null) out[idx]=m[2].trim(); }
  });
  return out;
}
document.getElementById('saveTargets').onclick = ()=>{
  const st = document.getElementById('targetStatus');
  const f = +document.getElementById('tFloor').value, c = +document.getElementById('tCeil').value;
  const p = +document.getElementById('tP').value, pMode = document.getElementById('tPMode').value;
  const cm = +document.getElementById('tCMax').value || 0, fm = +document.getElementById('tFMax').value || 0;
  const cMode = document.getElementById('tCMode').value, fMode = document.getElementById('tFMode').value;
  if (!(f>0 && c>0 && p>0)){ setStatus(st,'Floor, ceiling and protein must be positive.','bad'); return; }
  if (c < f){ setStatus(st,'Ceiling cannot be below floor.','bad'); return; }
  if ((pMode==='pct' && p>100) || (cMode==='pct' && cm>100) || (fMode==='pct' && fm>100)){ setStatus(st,'Percentage values cannot exceed 100.','bad'); return; }
  FLOOR=FLOOR_M=f; CEIL=CEIL_M=c; P_CFG={mode:pMode, val:p};
  C_CAP={mode:cMode, val:cm}; F_CAP={mode:fMode, val:fm};
  saveTargets(); render();
  const note = GOAL.mode!=='off' ? ' Manual base saved — the goal still auto-drives the live corridor (turn Goal off to use these).' : '';
  setStatus(st,'Targets saved. Corridor, solver and history all follow the new numbers.'+note,'good');
};
document.getElementById('resetTargets').onclick = ()=>{
  FLOOR=FLOOR_M=PROTOCOL.floor; CEIL=CEIL_M=PROTOCOL.ceil; P_CFG={mode:'g', val:PROTOCOL.p};
  C_CAP={mode:'g', val:0}; F_CAP={mode:'g', val:0};
  saveTargets(); fillTargetInputs(); render();
  setStatus(document.getElementById('targetStatus'),'Protocol defaults restored (1700/1900 · 120g protein · caps off).','good');
};
document.getElementById('saveMealPlan').onclick = ()=>{
  const st = document.getElementById('mealPlanStatus');
  const plan = parseMealPlan(document.getElementById('mealPlanInput').value);
  if (!plan.length){ setStatus(st,'No valid lines. Format: "HH:MM kcal Name" (e.g. 07:30 800 Breakfast).','bad'); return; }
  MEAL_PLAN = plan; saveTargets(); fillMealPlan(); render();
  setStatus(st, `Saved ${plan.length} meals · plan total ${plan.reduce((s,m)=>s+m.kcal,0)} kcal (scaled to your corridor).`, 'good');
};
document.getElementById('clearMealPlan').onclick = ()=>{
  MEAL_PLAN = []; saveTargets(); fillMealPlan(); render();
  setStatus(document.getElementById('mealPlanStatus'),'Meal plan cleared — pacing is now an even linear ramp.','good');
};
document.getElementById('trainCycle').addEventListener('change', ()=>{
  document.getElementById('cycleOffsets').hidden = !document.getElementById('trainCycle').checked;
});
document.getElementById('saveTrain').onclick = ()=>{
  const st = document.getElementById('trainStatus');
  TRAIN.split       = parseTrainSplit(document.getElementById('trainSplitInput').value);
  TRAIN.start       = document.getElementById('trainStart').value || '18:00';
  TRAIN.end         = document.getElementById('trainEnd').value   || '20:00';
  TRAIN.cycle       = document.getElementById('trainCycle').checked;
  TRAIN.trainOffset = +document.getElementById('trainOffset').value || 0;
  TRAIN.restOffset  = +document.getElementById('restOffset').value  || 0;
  saveTargets(); fillTrain(); render();
  const nTrain = TRAIN.split.filter(s=> s && s.trim().toLowerCase()!=='rest').length;
  let msg = `Saved · ${nTrain} training day${nTrain===1?'':'s'} (${TRAIN.start}–${TRAIN.end}).`;
  if (TRAIN.cycle && nTrain>0){
    const avg = Math.round((nTrain*TRAIN.trainOffset + (7-nTrain)*TRAIN.restOffset)/7);
    msg += ` Corridor cycles: train ${TRAIN.trainOffset>=0?'+':''}${TRAIN.trainOffset}, rest ${TRAIN.restOffset>=0?'+':''}${TRAIN.restOffset} · weekly avg ${avg>=0?'+':''}${avg}.`;
  }
  setStatus(st, msg, 'good');
};
document.getElementById('savePens').onclick = ()=>{
  const st = document.getElementById('targetStatus');
  const k = +document.getElementById('penK').value, p = +document.getElementById('penP').value;
  const ok = +document.getElementById('penOK').value, of = +document.getElementById('penOF').value;
  if ([k,p,ok,of].some(v=>isNaN(v)||v<0) || p>=100){ setStatus(st,'Penalties must be ≥0 (protein cut below 100).','bad'); return; }
  INFLATE = 1 + k/100; DEDUCT = 1 - p/100; OIL_KCAL = ok; OIL_FAT = of;
  savePens(); render();
  setStatus(st,`Penalties saved: +${k}% kcal / −${p}% P unweighed · oil ${ok} kcal / ${of}g fat per tbsp. Applies to new entries.`,'good');
};
document.getElementById('resetPens').onclick = ()=>{
  INFLATE = 1 + PROTOCOL.penK/100; DEDUCT = 1 - PROTOCOL.penP/100;
  OIL_KCAL = PROTOCOL.oilK; OIL_FAT = PROTOCOL.oilF;
  savePens(); fillTargetInputs(); render();
  setStatus(document.getElementById('targetStatus'),'Protocol penalties restored (+10% / −10% · 132 kcal / 14g per tbsp).','good');
};

document.getElementById('resetBtn').onclick = async ()=>{
  if (!ledger.length){ toast('Nothing logged for this day.'); return; }
  const label = VIEW_DATE === ACTIVE_DATE ? 'today' : prettyDate(VIEW_DATE);
  const ok = await confirmSheet({
    title: `Clear ${label}?`,
    body: `All ${ledger.length} ${ledger.length === 1 ? 'entry' : 'entries'} for this day are removed. You can undo it straight after.`,
    confirmLabel: 'Clear entries',
    tone: 'danger'
  });
  if (!ok) return;
  const before = ledger.slice();
  ledger = []; save(); render();
  toast(`Cleared ${before.length} ${before.length === 1 ? 'entry' : 'entries'}`,
    { tone:'warn', undo: ()=>{ ledger = before; save(); render(); } });
};
// Export EVERY logged day (plus targets) — this is the durable backup, so it must
// carry the whole history, not just today.
document.getElementById('exportBtn').onclick = async ()=>{
  const days = {};
  allDays(true).forEach(d => { days[d.date] = d.ledger; });
  days[VIEW_DATE] = ledger;                       // the on-screen day's live state wins
  const payload = { exported: dateStr(), version: 2,
    targets: {floor:FLOOR_M,ceil:CEIL_M,pCfg:P_CFG,p:Math.round(P_TARGET),cCap:C_CAP,fCap:F_CAP,maint:MAINT,profile:PROFILE,goal:GOAL,mealPlan:MEAL_PLAN,train:TRAIN},
    pen: {k:Math.round((INFLATE-1)*100), p:Math.round((1-DEDUCT)*100), oilK:OIL_KCAL, oilF:OIL_FAT},
    weights: weightsMap(), templates: templates(),
    supps: supps(), suppLog: suppLog(),
    workouts: allWorkouts(), wkMeta: workoutMeta(), exercises: exerciseCatalog(),
    days, date: ACTIVE_DATE, ledger, totals: totals() };   // date/ledger kept for v1 compat
  // Bind the backup to this sync account when one is set, so a shared/leaked export can
  // only be re-imported on the owning passphrase (import refuses a mismatched owner).
  const pass = getKey(LS.pass);
  if (pass) payload.owner = await sha256hex(pass);
  const blob = new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`ledger_${ACTIVE_DATE}.json`; a.click(); URL.revokeObjectURL(url);
};

// Import: merge a previously exported ledger back in (durability backstop against eviction).
document.getElementById('importBtn').onclick = ()=> document.getElementById('importFile').click();
document.getElementById('importFile').onchange = (ev)=>{
  const file = ev.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = async ()=>{
    try {
      const data = JSON.parse(reader.result);
      // Account-bound backup: if it carries an owner hash, only the sync account whose
      // passphrase hashes to it may import (gates a personal backup to its owner).
      if (data.owner) {
        const pass = getKey(LS.pass);
        if (!pass) {
          await alertSheet({ title:'Backup is account-bound',
            body:'This backup belongs to a sync account. Set that account’s passphrase in Settings, then import it again.' });
          ev.target.value=''; return;
        }
        if (await sha256hex(pass) !== data.owner) {
          await alertSheet({ title:'Wrong account',
            body:'This backup belongs to a different sync account. It can only be imported on the account that created it.' });
          ev.target.value=''; return;
        }
      }
      // Recompute from stored raw fields + carried base so imported entries stay consistent.
      const rebuild = l => l.map(e => {
        const base = e.base || DB[e.name];
        return (e.name && base && 'weighed' in e)
          ? computeEntry(e.name, e.grams, e.weighed, e.isCurry, e.halfOil, base, e.source)
          : e;
      });
      if (data.days && typeof data.days === 'object') {
        // v2 backup: restore every day + targets.
        const dates = Object.keys(data.days).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d));
        if (!dates.length) throw new Error('no days in backup');
        const go = await confirmSheet({
          title: `Restore ${dates.length} ${dates.length === 1 ? 'day' : 'days'}?`,
          body: 'Days already stored under the same date are overwritten. Everything else is left alone.',
          confirmLabel: 'Restore backup'
        });
        if (!go) return;
        dates.forEach(d=>{
          const l = rebuild(data.days[d]);
          try { localStorage.setItem('ledger_'+d, JSON.stringify(l)); } catch(e){}
          stampSyncMeta(d);                    // imported now = edited now, for sync LWW
          if (d === VIEW_DATE) ledger = l;
        });
        if (data.targets){
          FLOOR=+data.targets.floor||FLOOR; CEIL=+data.targets.ceil||CEIL;
          if (data.targets.pCfg) P_CFG={mode:data.targets.pCfg.mode==='pct'?'pct':'g', val:+data.targets.pCfg.val||PROTOCOL.p};
          else if (+data.targets.p) P_CFG={mode:'g', val:+data.targets.p};
          if (data.targets.cCap) C_CAP={mode:data.targets.cCap.mode==='pct'?'pct':'g', val:+data.targets.cCap.val||0};
          else if (+data.targets.cMax) C_CAP={mode:'g', val:+data.targets.cMax};
          if (data.targets.fCap) F_CAP={mode:data.targets.fCap.mode==='pct'?'pct':'g', val:+data.targets.fCap.val||0};
          else if (+data.targets.fMax) F_CAP={mode:'g', val:+data.targets.fMax};
          saveTargets();
        }
        if (data.pen){
          INFLATE = 1 + (+data.pen.k||0)/100; DEDUCT = 1 - (+data.pen.p||0)/100;
          OIL_KCAL = +data.pen.oilK>=0 ? +data.pen.oilK : OIL_KCAL;
          OIL_FAT  = +data.pen.oilF>=0 ? +data.pen.oilF : OIL_FAT;
          savePens();
        }
        fillTargetInputs();
        if (data.weights && typeof data.weights === 'object'){
          const map = Object.assign({}, data.weights, weightsMap());   // restore fills gaps; local wins on clash
          const meta = weightsMeta(); const now = new Date().toISOString();
          Object.keys(data.weights).forEach(d=>{ if(!meta[d]) meta[d]=now; });
          saveWeights(map, meta);
        }
        if (Array.isArray(data.templates) && data.templates.length){
          const names = new Set(templates().map(t=>t.name));
          saveTemplates(templates().concat(data.templates.filter(t=>t && t.name && !names.has(t.name))));
        }
        if (Array.isArray(data.supps) && data.supps.length){
          const ids = new Set(supps().map(s=>s.id));
          saveSupps(supps().concat(data.supps.filter(s=>s && s.id && s.name && !ids.has(s.id))));
        }
        if (data.suppLog && typeof data.suppLog === 'object'){
          const map = Object.assign({}, data.suppLog, suppLog());   // restore fills gaps; local wins on clash
          const meta = suppLogMeta(); const now = new Date().toISOString();
          Object.keys(data.suppLog).forEach(d=>{ if(!meta[d]) meta[d]=now; });
          saveSuppLog(map, meta);
        }
        // Training sessions restore per-day, same as the food ledger: a day already on
        // this device wins, so a restore fills gaps rather than overwriting newer work.
        if (data.workouts && typeof data.workouts === 'object'){
          const meta = workoutMeta(), now = new Date().toISOString();
          Object.keys(data.workouts).forEach(d=>{
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
            const w = data.workouts[d];
            if (!w || !Array.isArray(w.exercises)) return;
            if (localStorage.getItem(WK_PREFIX+d)) return;
            try{ localStorage.setItem(WK_PREFIX+d, JSON.stringify(w)); }catch(e){}
            meta[d] = (data.wkMeta && data.wkMeta[d]) || now;
          });
          saveWorkoutMeta(meta);
        }
        if (Array.isArray(data.exercises) && data.exercises.length){
          const ids = new Set(exerciseCatalog().map(c=>c.id));
          const add = data.exercises.filter(c=>c && c.id && c.name && !ids.has(c.id));
          if (add.length) saveCatalog(exerciseCatalog().concat(add));
        }
      } else if (data.ledger && Array.isArray(data.ledger)) {
        // v1 single-day export.
        if (ledger.length){
          const go = await confirmSheet({
            title: 'Replace this day?',
            body: `The ${ledger.length} ${ledger.length === 1 ? 'entry' : 'entries'} on screen are replaced with ${data.ledger.length} from the backup.`,
            confirmLabel: 'Replace entries',
            tone: 'danger'
          });
          if (!go) return;
        }
        ledger = rebuild(data.ledger);
      } else throw new Error('no ledger array');
      save(); render();
      toast('Backup restored');
    } catch(err){
      await alertSheet({ title:'Import failed', body: err.message });
    }
    ev.target.value='';
  };
  reader.readAsText(file);
};

// Register service worker (relative path keeps scope under /macros-tracker/).
// The new SW skipWaiting()s on install; when it takes over an existing page,
// offer a one-tap reload so the fresh shell actually loads.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let offered = false;
  const showToast = ()=>{
    if (!hadController || offered) return;
    offered = true;
    toast('A new version is ready.', { undoLabel:'Reload', ms: 20000, undo: ()=> location.reload() });
  };
  // controllerchange fires when the fresh SW (skipWaiting + clients.claim) takes over.
  navigator.serviceWorker.addEventListener('controllerchange', showToast);
  window.addEventListener('load', ()=>{
    // updateViaCache:'none' forces the browser to re-fetch sw.js bypassing the HTTP cache,
    // so a new version is detected even while GitHub Pages still serves a cached script.
    navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).then(reg=>{
      reg.update();                                    // check for a new SW right away
      reg.addEventListener('updatefound', ()=>{        // and when one starts installing
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener('statechange', ()=>{ if (nw.state==='activated') showToast(); });
      });
    }).catch(err => console.warn('SW registration failed:', err));
  });
  // Re-check whenever the app is reopened or refocused — catches updates without a manual reload.
  document.addEventListener('visibilitychange', ()=>{
    if (document.visibilityState==='visible')
      navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(()=>{});
  });
}

// Hydrate key fields from storage on boot.
function loadKeys(){
  document.getElementById('usdaKey').value   = getKey(LS.usda);
  document.getElementById('geminiKey').value = getKey(LS.gem);
  document.getElementById('geminiModel').value = getKey(LS.model) || 'gemini-3.5-flash-lite';
  document.getElementById('orKey').value     = getKey(LS.or);
  document.getElementById('supaUrl').value   = getKey(LS.supaUrl);
  document.getElementById('supaKey').value   = getKey(LS.supaKey);
  document.getElementById('syncPass').value  = getKey(LS.pass);
  refreshKeyUI();
}

// Ask the browser to keep our localStorage from being evicted under storage pressure.
// Best-effort: silently ignored where unsupported or denied — Export remains the backup.
function requestPersistence(){
  if (navigator.storage && navigator.storage.persist && navigator.storage.persisted){
    navigator.storage.persisted().then(p => { if (!p) navigator.storage.persist().catch(()=>{}); }).catch(()=>{});
  }
}

document.getElementById('closeDayBtn').onclick = closeDay;
document.getElementById('backToTodayBtn').onclick = ()=> viewDay(ACTIVE_DATE, true);
updateDayLabel();
document.getElementById('suppAnchor').value = ACTIVE_DATE;   // "an ON day you're sure of" defaults to today
renderSuppDayPick();
loadTargets(); fillTargetInputs(); loadKeys(); initFoods(); load(); requestPersistence();
showTab('today');   // a logging app always opens on Today (also renders)
maybeShowBrief();   // one-line plan for the day, once per day
if (syncConfigured()) syncNow(); else setSyncDot('off');   // boot pull+push (no-op when unconfigured)
