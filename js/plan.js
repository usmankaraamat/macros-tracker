// plan.js -- The Plan view: supplement cycles, gap-closing meal combos, and the
// ternary meal engineer.

// ---- SUPPLEMENTS: alternate-day protocols and their dose log ----------------
// Two stores, because they age differently. The PROTOCOLS are settings — one small list,
// last-write-wins as a whole (same shape as templates). The DOSE LOG is per-day facts
// ({date: [ids]}), so it merges date-by-date through mergeSyncStates exactly like ledger
// days and weights: ticking a dose on your phone can't clobber yesterday's tick from the PC.
// A supplement doubles as its own schedule object — core.js reads .every/.anchor/.mode/.days
// off it directly, so there's no second shape to keep in step.
function supps(){ try{ const l=JSON.parse(localStorage.getItem('ledger_supps')||'[]'); return Array.isArray(l)?l:[]; }catch(e){ return []; } }
function suppsStamp(){ return getKey('ledger_supps_updated'); }
function saveSupps(list){
  try{ localStorage.setItem('ledger_supps', JSON.stringify(list)); }catch(e){}
  setKey('ledger_supps_updated', new Date().toISOString());
  scheduleSync(); render();
}
function suppLog(){ try{ const m=JSON.parse(localStorage.getItem('ledger_supp_log')||'{}'); return m&&typeof m==='object'?m:{}; }catch(e){ return {}; } }
function suppLogMeta(){ try{ return JSON.parse(localStorage.getItem('ledger_supp_log_meta')||'{}'); }catch(e){ return {}; } }
function saveSuppLog(map, meta){
  try{ localStorage.setItem('ledger_supp_log', JSON.stringify(map));
       localStorage.setItem('ledger_supp_log_meta', JSON.stringify(meta)); }catch(e){}
}
// {date:true} for one supplement, the shape core.js's window walker wants.
function suppTakenMap(id){
  const log = suppLog(), m = {};
  Object.keys(log).forEach(d=>{ if ((log[d]||[]).indexOf(id) >= 0) m[d] = true; });
  return m;
}
// Tick / untick a dose on the day being viewed. Empty days are stored, not deleted — a
// cleared day is data and has to propagate through sync like any other edit.
function toggleSupp(id, date){
  const log = suppLog(), meta = suppLogMeta();
  const cur = (log[date] || []).slice();
  const i = cur.indexOf(id);
  if (i >= 0) cur.splice(i, 1); else cur.push(id);
  log[date] = cur; meta[date] = new Date().toISOString();
  saveSuppLog(log, meta); scheduleSync();
  render();   // the Today strip and the Plan cards both read this
}
function suppCadenceText(s){
  if (Array.isArray(s.days) && s.days.length) return s.days.map(i=>WEEKDAYS[i]).join('/');
  const n = Math.max(1, Math.round(s.every||1));
  const base = n===1 ? 'daily' : n===2 ? 'every other day' : `every ${n} days`;
  return n>1 && s.mode==='rolling' ? base+' (rolling)' : base;
}
// "Wed 30 Jul" — short enough for a card line, unambiguous about which day is meant.
function suppDayLabel(iso, today){
  if (iso === today) return 'today';
  if (iso === addDaysISO(today, 1)) return 'tomorrow';
  const dt = new Date(iso+'T00:00:00Z');
  return WEEKDAYS[LedgerCore.isoWeekdayMon(iso)] + ' ' + dt.getUTCDate() + ' ' +
         ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()];
}
const SUPP_STRIP_DAYS = 14;
function renderSupps(){
  const wrap = document.getElementById('suppToday'); if (!wrap) return;
  document.getElementById('suppDate').textContent = VIEW_DATE===ACTIVE_DATE ? 'today' : VIEW_DATE;
  const list = supps();
  if (!list.length){
    wrap.innerHTML = '<div class="empty">No protocols yet. Add one below and it will tell you whether today is an ON day.</div>';
    document.getElementById('suppSummary').hidden = true;
    return;
  }
  let dueNow = 0, pending = 0;
  wrap.innerHTML = list.map((s, i)=>{
    const taken = suppTakenMap(s.id);
    const cells = LedgerCore.supplementWindow(s, taken, VIEW_DATE, SUPP_STRIP_DAYS);
    const st = LedgerCore.supplementStats(cells);
    const cell = cells[cells.length-1];
    if (cell.due) { dueNow++; if (!cell.taken) pending++; }
    const cls = cell.taken ? 'done' : (cell.due ? 'on' : 'off');
    // The one line that answers the question: take it, done, or off — and if off, when next.
    let sub;
    if (cell.taken)   sub = cell.due ? '✓ taken' : '✓ taken · off-schedule dose';
    else if (cell.due) sub = '● ON — take it';
    else {
      const nx = LedgerCore.supplementNextDue(s, addDaysISO(VIEW_DATE,1), lastDoseUpTo(taken, VIEW_DATE));
      sub = '○ OFF' + (nx ? ' · next ' + suppDayLabel(nx, VIEW_DATE) : '');
    }
    const strip = cells.map(c=>{
      const k = c.due ? (c.taken ? 'due hit' : (c.date===VIEW_DATE ? 'due' : 'due miss'))
                      : (c.taken ? 'extra' : '');
      return `<div class="supp-dot ${k}${c.date===VIEW_DATE?' today':''}" title="${c.date} · ${c.due?'ON':'off'}${c.taken?' · taken':''}"></div>`;
    }).join('');
    const tail = st.streak>1 ? ` · streak ${st.streak}` : '';
    return `<div class="supp-card ${cls}">
      <div class="supp-main">
        <div class="supp-name">${escapeHtml(s.name)}${s.dose?` <small>${escapeHtml(s.dose)}</small>`:''}</div>
        <div class="supp-sub">${sub}</div>
        <div class="supp-strip" role="img" aria-label="Last ${SUPP_STRIP_DAYS} days: ${st.taken} of ${st.due} due doses taken">${strip}</div>
        <div class="supp-sub">${suppCadenceText(s)} · ${st.taken}/${st.due} of the last ${SUPP_STRIP_DAYS} days${tail}</div>
      </div>
      <button type="button" class="supp-take ${cell.due && !cell.taken ? '' : 'ghost'}" data-supptake="${i}">${cell.taken?'Undo':'Take'}</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-supptake]').forEach(b=>{
    b.onclick = ()=>{ const s = supps()[+b.dataset.supptake]; if (s) toggleSupp(s.id, VIEW_DATE); };
  });
  const sum = document.getElementById('suppSummary');
  sum.hidden = false;
  const when = VIEW_DATE===ACTIVE_DATE ? 'today' : 'that day';
  sum.textContent = dueNow === 0
    ? `Nothing due ${when} — all ${list.length} ${list.length>1?'protocols are':'protocol is'} off-cycle.`
    : pending === 0 ? `All ${dueNow} due ${when} logged.`
    : `${pending} of ${dueNow} due ${when} still to take.`;
}

// The nav badge is visible from every tab, so it is refreshed on every render
// rather than only when the Plan tab happens to be on screen. Only the live day
// nags — browsing history should never raise an alarm.
function updateSuppBadge(){
  const badge = document.getElementById('suppBadge');
  if (!badge) return;
  let pending = 0;
  if (VIEW_DATE === ACTIVE_DATE){
    supps().forEach(s=>{
      const cells = LedgerCore.supplementWindow(s, suppTakenMap(s.id), VIEW_DATE, SUPP_STRIP_DAYS);
      const cell = cells[cells.length-1];
      if (cell.due && !cell.taken) pending++;
    });
  }
  badge.hidden = pending === 0;
  badge.textContent = pending || '';
  badge.setAttribute('aria-label', pending ? `${pending} supplements still to take` : '');
}

// The compact "is today an ON day?" answer, shown on Today. Managing the
// protocols themselves stays on Plan — this is only the daily question.
function renderSuppToday(){
  const panel = document.getElementById('suppTodayPanel');
  const strip = document.getElementById('suppTodayStrip');
  if (!panel || !strip) return;
  const due = [];
  supps().forEach(s=>{
    const cells = LedgerCore.supplementWindow(s, suppTakenMap(s.id), VIEW_DATE, SUPP_STRIP_DAYS);
    const cell = cells[cells.length-1];
    if (cell.due) due.push({ s, taken: cell.taken });
  });
  if (!due.length){ panel.hidden = true; return; }
  panel.hidden = false;
  const outstanding = due.filter(d => !d.taken);
  strip.innerHTML = due.map((d,i)=>
    `<button type="button" class="chip${d.taken ? ' on' : ''}" data-suppquick="${i}"
       aria-pressed="${d.taken}">${d.taken ? '✓ ' : ''}${escapeHtml(d.s.name)}</button>`).join('') +
    `<span class="supp-sub" style="margin-left:auto">${
      outstanding.length ? `<b>${outstanding.length}</b> still to take` : 'all logged'}</span>`;
  strip.querySelectorAll('[data-suppquick]').forEach(b=>{
    b.onclick = ()=>{
      const d = due[+b.dataset.suppquick];
      if (!d) return;
      toggleSupp(d.s.id, VIEW_DATE);
      haptic();
      toast(d.taken ? `${d.s.name} un-logged` : `${d.s.name} logged`);
    };
  });
}
// Most recent logged dose at or before `iso` — the phase reference a rolling cycle counts from.
function lastDoseUpTo(taken, iso){
  let last = null;
  Object.keys(taken).forEach(d=>{ if (taken[d] && d <= iso && (last===null || d > last)) last = d; });
  return last;
}
function suppMicroSummary(s){
  const keys = s && s.micros ? Object.keys(s.micros).filter(k=>+s.micros[k]>0) : [];
  if (!keys.length) return '';
  const txt = keys.map(k=>{ const r = LedgerCore.microRef(k); return `${r?r.name:k} ${s.micros[k]}${r?r.unit:''}`; }).join(' · ');
  return `<div class="sr-sub">✚ ${escapeHtml(txt)}</div>`;
}
function renderSuppManage(){
  const wrap = document.getElementById('suppManage'); if (!wrap) return;
  const list = supps();
  if (!list.length){ wrap.innerHTML = '<div class="empty">Nothing to manage yet.</div>'; return; }
  wrap.innerHTML = list.map((s,i)=>
    `<div class="supp-row"><div><div>${escapeHtml(s.name)}${s.dose?` <span class="sr-sub">${escapeHtml(s.dose)}</span>`:''}</div>`+
    `<div class="sr-sub">${suppCadenceText(s)}${s.anchor&&!(s.days&&s.days.length)?` · anchored ${s.anchor}`:''}</div>${suppMicroSummary(s)}</div>`+
    `<div class="supp-row-btns"><button type="button" class="sm ghost" data-suppedit="${escapeAttr(s.id)}">Edit</button>`+
    `<button type="button" class="sm ghost" data-suppdel="${i}">Remove</button></div></div>`).join('');
  wrap.querySelectorAll('[data-suppedit]').forEach(b=>{
    b.onclick = ()=> editSupp(b.dataset.suppedit);
  });
  wrap.querySelectorAll('[data-suppdel]').forEach(b=>{
    b.onclick = ()=>{
      const l = supps(), s = l[+b.dataset.suppdel];
      if (!s) return;
      if (SUPP_EDIT_ID === s.id) resetSuppForm();   // don't leave the form editing a gone protocol
      saveSupps(l.filter(v=>v.id!==s.id));
      toast(`Removed ${s.name} — its dose history is kept`,
        { tone:'warn', undo: ()=> saveSupps(l) });
    };
  });
}
// ---- supplement form ----
// The form doubles as an editor: SUPP_EDIT_ID is the id being changed (null = adding a new
// one), so an existing protocol can gain nutrients or a fixed schedule without deleting it.
// SUPP_MICROS is the per-dose nutrient map under construction, built by the label reader or
// by hand and stored on the protocol as `.micros`.
let SUPP_DAYS_PICK = [];
let SUPP_EDIT_ID = null;
let SUPP_MICROS = {};
let suppLabelPhotoB64 = null;
function renderSuppDayPick(){
  const el = document.getElementById('suppDaysPick'); if (!el) return;
  el.innerHTML = WEEKDAYS.map((d,i)=>`<span class="chip${SUPP_DAYS_PICK.indexOf(i)>=0?' on':''}" data-suppday="${i}">${d}</span>`).join('');
  el.querySelectorAll('[data-suppday]').forEach(c=>{
    c.onclick = ()=>{
      const i = +c.dataset.suppday, at = SUPP_DAYS_PICK.indexOf(i);
      if (at>=0) SUPP_DAYS_PICK.splice(at,1); else SUPP_DAYS_PICK.push(i);
      SUPP_DAYS_PICK.sort((a,b)=>a-b); renderSuppDayPick();
    };
  });
}
document.getElementById('suppKind').addEventListener('change', ()=>{
  const byDays = document.getElementById('suppKind').value === 'days';
  document.getElementById('suppDaysWrap').hidden  = !byDays;
  document.getElementById('suppEveryWrap').hidden = byDays;
  document.getElementById('suppPhaseWrap').hidden = byDays;
});

// ---- nutrients per dose: label reader + by-hand entry ----
function showSuppNutriMsg(html, bad){
  const el = document.getElementById('suppNutriMsg'); if (!el) return;
  el.hidden = !html; el.className = 'tactical' + (bad ? ' bad' : ''); el.innerHTML = html || '';
}
function renderSuppMicroPick(){
  const sel = document.getElementById('suppMicroPick'); if (!sel) return;
  sel.innerHTML = LedgerCore.MICRO_REF.map(m=>`<option value="${m.key}">${m.name} (${m.unit})</option>`).join('');
  updateSuppMicroForm();
}
function renderSuppMicroList(){
  const el = document.getElementById('suppMicroList'); if (!el) return;
  const keys = Object.keys(SUPP_MICROS).filter(k=>+SUPP_MICROS[k]>0);
  if (!keys.length){ el.innerHTML = '<div class="sr-sub">No nutrients recorded yet — read a label or add them by hand.</div>'; return; }
  // Registry order, so the chips read top-to-bottom like the panel does.
  el.innerHTML = LedgerCore.MICRO_KEYS.filter(k=>keys.indexOf(k)>=0).map(k=>{
    const r = LedgerCore.microRef(k);
    return `<span class="chip on" data-micdel="${k}" role="button" tabindex="0" title="Remove">${escapeHtml(r?r.name:k)} ${SUPP_MICROS[k]}${r?r.unit:''} ✕</span>`;
  }).join(' ');
  el.querySelectorAll('[data-micdel]').forEach(c=>{
    c.onclick = ()=>{ delete SUPP_MICROS[c.dataset.micdel]; renderSuppMicroList(); };
  });
}
// The Amount field's unit + the compound→elemental helper follow the chosen nutrient: minerals
// with known salt forms (calcium, magnesium, iron, zinc, potassium) get a "salt form" select
// that converts a label's compound weight to the elemental amount that actually counts.
function updateSuppMicroForm(){
  const key = document.getElementById('suppMicroPick').value;
  const ref = LedgerCore.microRef(key);
  document.getElementById('suppMicroUnit').textContent = ref ? '('+ref.unit+')' : '';
  const forms = LedgerCore.ELEMENTAL_FRACTION[key];
  document.getElementById('suppElemWrap').hidden = !forms;
  if (forms){
    document.getElementById('suppElemForm').innerHTML =
      '<option value="">elemental — as listed on the label</option>' +
      Object.keys(forms).map(f=>`<option value="${escapeAttr(f)}">${key.toUpperCase()} ${escapeHtml(f)}</option>`).join('');
  }
  updateSuppElemHint();
}
function updateSuppElemHint(){
  const hint = document.getElementById('suppElemHint');
  const key = document.getElementById('suppMicroPick').value;
  const forms = LedgerCore.ELEMENTAL_FRACTION[key];
  const form = forms ? document.getElementById('suppElemForm').value : '';
  const amt = +document.getElementById('suppMicroAmt').value;
  if (!form || !(amt>0)){ hint.hidden = true; hint.textContent=''; return; }
  const el = LedgerCore.elementalMg(key, form, amt);
  hint.hidden = false;
  hint.textContent = el!=null ? `${amt} mg compound → ~${el} mg elemental` : 'unknown salt form';
}
document.getElementById('suppMicroPick').addEventListener('change', updateSuppMicroForm);
document.getElementById('suppElemForm').addEventListener('change', updateSuppElemHint);
document.getElementById('suppMicroAmt').addEventListener('input', updateSuppElemHint);
document.getElementById('suppMicroAdd').onclick = ()=>{
  const key = document.getElementById('suppMicroPick').value;
  const forms = LedgerCore.ELEMENTAL_FRACTION[key];
  const form = forms ? document.getElementById('suppElemForm').value : '';
  let amt = +document.getElementById('suppMicroAmt').value;
  if (form){ const el = LedgerCore.elementalMg(key, form, amt); if (el!=null) amt = el; }   // compound → elemental
  if (!(amt>0)){ showSuppNutriMsg('Enter an amount above 0.', true); return; }
  SUPP_MICROS[key] = Math.round(amt*100)/100;    // overwrite: re-adding a nutrient corrects it
  document.getElementById('suppMicroAmt').value = '';
  if (forms) document.getElementById('suppElemForm').value = '';
  updateSuppElemHint();
  renderSuppMicroList();
};

// Photo attach for the label — its own state so it never crosses into the meal composer.
function setSuppPhoto(b64, label){
  suppLabelPhotoB64 = b64;
  const chip = document.getElementById('suppPhotoChip'); if (!chip) return;
  chip.hidden = !b64;
  if (b64){ document.getElementById('suppPhotoThumb').src = 'data:image/jpeg;base64,'+b64;
            document.getElementById('suppPhotoName').textContent = label || 'label photo'; }
}
async function handleSuppPhotoPick(ev){
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  try { setSuppPhoto(await shrinkImage(file), file.name); showSuppNutriMsg('Photo attached — press <b>Read label</b>.'); }
  catch(e){ showSuppNutriMsg(escapeHtml(e.message), true); }
}
document.getElementById('suppPhotoBtn').onclick = ()=> document.getElementById('suppPhotoFile').click();
document.getElementById('suppGalleryBtn').onclick = ()=> document.getElementById('suppPhotoGallery').click();
document.getElementById('suppPhotoClear').onclick = ()=> setSuppPhoto(null);
document.getElementById('suppPhotoFile').onchange = handleSuppPhotoPick;
document.getElementById('suppPhotoGallery').onchange = handleSuppPhotoPick;
document.getElementById('suppReadBtn').onclick = async ()=>{
  const text = (document.getElementById('suppLabelText').value||'').trim();
  if (!text && !suppLabelPhotoB64){ showSuppNutriMsg('Paste the label text or attach a photo first.', true); return; }
  const btn = document.getElementById('suppReadBtn'); btn.disabled = true;
  showSuppNutriMsg('<span class="spin"></span>Reading the label…');
  try {
    const r = await aiParseSupplement(text, suppLabelPhotoB64);
    Object.keys(r.micros).forEach(k=>{ SUPP_MICROS[k] = r.micros[k]; });
    const nameEl = document.getElementById('suppName'), doseEl = document.getElementById('suppDose');
    if (r.name && !nameEl.value.trim()) nameEl.value = r.name;
    if (r.dose && !doseEl.value.trim()) doseEl.value = r.dose;
    renderSuppMicroList();
    const n = Object.keys(r.micros).length;
    showSuppNutriMsg(n
      ? `Read ${n} nutrient${n>1?'s':''} via ${escapeHtml(AI_VIA)} — check the amounts, then add the supplement below.`
      : `${escapeHtml(AI_VIA)} found no tracked nutrients on that label. Add them by hand.`, !n);
    setSuppPhoto(null);
    document.getElementById('suppLabelText').value = '';
  } catch(e){ showSuppNutriMsg('Read failed: '+escapeHtml(e.message), true); }
  finally { btn.disabled = false; }
};

function resetSuppForm(){
  SUPP_EDIT_ID = null; SUPP_MICROS = {}; SUPP_DAYS_PICK = [];
  document.getElementById('suppName').value = ''; document.getElementById('suppDose').value = '';
  document.getElementById('suppLabelText').value = '';
  setSuppPhoto(null); showSuppNutriMsg('');
  renderSuppMicroList(); renderSuppDayPick();
  document.getElementById('suppAddBtn').textContent = 'Add supplement';
  document.getElementById('suppCancelEdit').hidden = true;
}
function editSupp(id){
  const s = supps().filter(v=>v.id===id)[0]; if (!s) return;
  SUPP_EDIT_ID = id;
  SUPP_MICROS = {};
  if (s.micros) Object.keys(s.micros).forEach(k=>{ if (+s.micros[k]>0) SUPP_MICROS[k] = s.micros[k]; });
  document.getElementById('suppName').value = s.name || '';
  document.getElementById('suppDose').value = s.dose || '';
  if (Array.isArray(s.days) && s.days.length){
    document.getElementById('suppKind').value = 'days';
    SUPP_DAYS_PICK = s.days.slice();
  } else {
    document.getElementById('suppKind').value = 'every';
    document.getElementById('suppEvery').value = s.every || 1;
    document.getElementById('suppMode').value = s.mode === 'rolling' ? 'rolling' : 'fixed';
    document.getElementById('suppAnchor').value = s.anchor || '';
  }
  document.getElementById('suppKind').dispatchEvent(new Event('change'));   // sync wrap visibility
  renderSuppDayPick(); renderSuppMicroList();
  document.getElementById('suppNutriWrap').open = Object.keys(SUPP_MICROS).length > 0;
  document.getElementById('suppAddBtn').textContent = 'Save changes';
  document.getElementById('suppCancelEdit').hidden = false;
  document.getElementById('suppFormMsg').textContent = `Editing ${s.name} — change what you need, then Save.`;
  const nm = document.getElementById('suppName');
  nm.scrollIntoView({ behavior:'smooth', block:'center' }); nm.focus();
}
document.getElementById('suppCancelEdit').onclick = ()=>{
  resetSuppForm();
  document.getElementById('suppFormMsg').textContent = 'Edit cancelled.';
};
document.getElementById('suppAddBtn').onclick = ()=>{
  const msg = document.getElementById('suppFormMsg');
  const name = (document.getElementById('suppName').value||'').trim();
  if (!name){ document.getElementById('suppName').focus(); msg.textContent='Give it a name first.'; return; }
  const s = { id: SUPP_EDIT_ID || ('s'+Date.now().toString(36)+Math.random().toString(36).slice(2,6)),
              name: name, dose: (document.getElementById('suppDose').value||'').trim() };
  if (document.getElementById('suppKind').value === 'days'){
    if (!SUPP_DAYS_PICK.length){ msg.textContent='Pick at least one weekday.'; return; }
    s.days = SUPP_DAYS_PICK.slice();
  } else {
    s.every = Math.max(1, Math.round(+document.getElementById('suppEvery').value || 1));
    s.mode  = document.getElementById('suppMode').value === 'rolling' ? 'rolling' : 'fixed';
    s.anchor = document.getElementById('suppAnchor').value || ACTIVE_DATE;
  }
  const micros = {};
  Object.keys(SUPP_MICROS).forEach(k=>{ if (+SUPP_MICROS[k]>0) micros[k] = SUPP_MICROS[k]; });
  if (Object.keys(micros).length) s.micros = micros;
  const list = supps();
  const editing = SUPP_EDIT_ID && list.some(v=>v.id===SUPP_EDIT_ID);
  saveSupps(editing ? list.map(v=> v.id===SUPP_EDIT_ID ? s : v) : list.concat([s]));
  const verb = editing ? 'Updated' : 'Added';
  const nCount = Object.keys(micros).length;
  resetSuppForm();
  msg.textContent = `${verb} ${name} · ${suppCadenceText(s)}`
    + (nCount ? ` · ${nCount} nutrient${nCount>1?'s':''}/dose` : '') + '.';
  toast(`${verb} ${name}`);
};
renderSuppMicroPick();
renderSuppMicroList();

// Render the Plan tab. Only called when Plan is the visible tab.
function renderPlanTab(){
  renderSuppManage();       // the daily dose strip lives on Logs now; Plan only configures protocols
  renderBudget();
  renderTernary();
  renderTacticalLine();
}

// The one-line read on where the day stands, under the gap-closing combos.
function renderTacticalLine(){
  const tac = document.getElementById('tactical');
  if (!tac) return;
  const t = totals();
  const remKcal = FLOOR - t.kcal, remP = Math.max(0, P_TARGET - t.p);
  if (t.kcal < 1){ tac.textContent = ''; return; }
  if (remKcal > 0)
    tac.textContent = `${Math.round(remKcal)} kcal to the floor, ${remP.toFixed(0)}g protein outstanding.`;
  else if (t.kcal <= CEIL)
    tac.textContent = `Inside the corridor with ${Math.round(CEIL - t.kcal)} kcal of ceiling headroom.`;
  else
    tac.textContent = `Ceiling breached by ${Math.round(t.kcal - CEIL)} kcal — integrity compromised.`;
}

function renderBudget() {
  const wrap = document.getElementById('budgetSuggestions');
  const t = totals();
  const remKcal = FLOOR - t.kcal;
  const remP = Math.max(0, P_TARGET - t.p);

  if (t.kcal < 1) {
    wrap.innerHTML = '<div class="empty">Log some food and combinations that close the remaining gap appear here.</div>';
    return;
  }

  if (remKcal <= 0) {
    const headroom = CEIL - t.kcal;
    if (headroom > 0) {
      wrap.innerHTML = `<div class="budget-item"><div class="budget-text">Floor reached, with <strong>${Math.round(headroom)} kcal</strong> of ceiling headroom${remP > 0 ? ` — still <strong>${remP.toFixed(0)}g protein</strong> to cover` : ''}.</div></div>`
        + proteinFixHTML(t, remP);
    } else {
      wrap.innerHTML = `<div class="budget-item"><div class="budget-text">Ceiling breached by <strong>${Math.round(-headroom)} kcal</strong>. Close the day and start the next one clean.</div></div>`;
    }
    return;
  }

  // Solve 2-food combos: for each pair (A, B), solve:
  //   A.kcal/100 * gA + B.kcal/100 * gB = remKcal
  //   A.p/100   * gA + B.p/100   * gB = remP (or best-effort if remP is 0)
  const combos = LedgerCore.budgetCombos(Object.entries(foodBase), remKcal, remP);

  const staples = [];
  const others = [];
  const isStaple = (c) => {
    const names = [c.nameA.toLowerCase(), c.nameB.toLowerCase()];
    const hasChicken = names.some(n => n.includes('chicken'));
    return hasChicken && (names.some(n => n.includes('rice')) || names.some(n => n.includes('potato')));
  };
  
  combos.forEach(c => isStaple(c) ? staples.push(c) : others.push(c));
  const top = [...staples, ...others].slice(0, 4);

  if (!top.length) {
    wrap.innerHTML = `<div class="empty"><strong>${Math.round(remKcal)} kcal</strong> to go, but no balanced pair exists in your food list yet. Log a few more foods and combinations appear here.</div>`;
    return;
  }

  const html = top.map(c =>
    `<div class="budget-item">
      <span class="budget-icon">${foodIcon(c.nameA)}</span>
      <div class="budget-text"><strong>${c.gA}g ${escapeHtml(c.nameA)}</strong> + <strong>${c.gB}g ${escapeHtml(c.nameB)}</strong><br>
        ${c.kcal} kcal · ${c.p}g protein
      </div>
    </div>`).join('');

  wrap.innerHTML = `<span class="panel-title" style="margin-bottom:6px">${Math.round(remKcal)} kcal to the floor · ${remP.toFixed(0)}g protein needed</span>` + html;
}

// ---- TERNARY MEAL ENGINEER ----
// Balance three foods against a strict calorie target on a 2-simplex. A dragged point
// carries barycentric weights (fraction of the budget per food); the overlay marks the
// region that clears the outstanding protein need. All math lives in LedgerCore.ternary.
const TV = [[120,20],[26,188],[214,188]];              // triangle vertices: A apex, B, C
// Slots are distinguished on a chalk ramp, not by hue. Hue in this app means
// out-of-tolerance, and three arbitrary food slots are not a tolerance state.
const TCOL = ['var(--chalk)','var(--graphite)','var(--rule-lit)'];
const tState = { foods:[null,null,null], w:[1/3,1/3,1/3], kcalTouched:false };

function ternFoodObjs(){ return tState.foods.map(n => getBase(n) || {kcal:0,p:0,f:0,c:0}); }
function ternTargetKcal(){ const v = parseFloat(document.getElementById('ternKcal').value); return v>0 ? v : 0; }
function ternProteinNeed(){ return Math.max(P_TARGET - totals().p, 0); }

// Keep the three selects populated with every known food, preserving the picks.
function syncTernSelects(){
  const keys = Object.keys(foodBase);
  ['ternA','ternB','ternC'].forEach((id,slot)=>{
    const sel = document.getElementById(id);
    if (!sel) return;
    if (!tState.foods[slot] || !foodBase[tState.foods[slot]]){
      // First fill / stale pick: prefer a sensible staple, else the slot-th food.
      const pref = [/chicken/i,/rice|potato/i,/egg/i][slot];
      tState.foods[slot] = keys.find(k=>pref.test(k) && !tState.foods.includes(k)) || keys[slot] || keys[0];
    }
    if (sel.options.length !== keys.length || sel.value !== tState.foods[slot]){
      sel.innerHTML = keys.map(k=>`<option ${k===tState.foods[slot]?'selected':''}>${k}</option>`).join('');
      sel.value = tState.foods[slot];
    }
  });
}

function renderTernary(){
  const plot = document.getElementById('ternPlot');
  if (!plot) return;
  syncTernSelects();
  if (!tState.kcalTouched){
    const gap = Math.max(FLOOR - totals().kcal, 0);
    document.getElementById('ternKcal').value = Math.max(Math.round(gap), 200);
  }
  const foods = ternFoodObjs();
  const kcal = ternTargetKcal();
  const bad = foods.some(f=>!f || f.kcal<=0);
  const msg = document.getElementById('ternMsg');
  if (bad || kcal<=0){
    plot.innerHTML = '';
    document.getElementById('ternReadout').innerHTML =
      '<div class="tern-msg">Pick three foods with known calories and a target above 0.</div>';
    msg.textContent = '';
    return;
  }
  const pNeed = ternProteinNeed();
  const T = LedgerCore.ternary;

  // The zone that clears the outstanding protein, and its boundary. Verdigris
  // is the app's "confirmed good" signal, which is exactly what this region is.
  const poly = T.greenPolygon(foods, kcal, pNeed, TV);
  const cross = T.isoProteinCrossings(foods, kcal, pNeed, TV);
  const greenSvg = poly.length>=3
    ? `<polygon points="${poly.map(p=>p.join(',')).join(' ')}" fill="var(--verdigris-wash)" stroke="none"/>` : '';
  const lineSvg = cross.length===2
    ? `<line x1="${cross[0][0]}" y1="${cross[0][1]}" x2="${cross[1][0]}" y2="${cross[1][1]}" stroke="var(--verdigris)" stroke-width="1.2" stroke-dasharray="4 3"/>` : '';

  const tri = `<polygon points="${TV.map(p=>p.join(',')).join(' ')}" fill="none" stroke="var(--rule-lit)" stroke-width="1"/>`;
  const dots = TV.map((v,i)=>`<circle cx="${v[0]}" cy="${v[1]}" r="4" fill="${TCOL[i]}"/>`).join('');
  const labels = TV.map((v,i)=>{
    const anchor = i===0?'middle':i===1?'end':'start';
    const dx = i===0?0:i===1?2:-2, dy = i===0?-9:16;
    const nm = tState.foods[i].length>11 ? tState.foods[i].slice(0,10)+'…' : tState.foods[i];
    return `<text x="${v[0]+dx}" y="${v[1]+dy}" text-anchor="${anchor}" class="tern-vtx-label" fill="${TCOL[i]}">${escapeHtml(nm)}</text>`;
  }).join('');
  const knobXY = T.cartesianFromBary(tState.w, TV);
  const knob = `<circle id="ternKnob" cx="${knobXY[0]}" cy="${knobXY[1]}" r="8" class="tern-knob"/>`;

  plot.innerHTML =
    `<svg id="ternSvg" viewBox="-14 -6 268 214" preserveAspectRatio="xMidYMid meet"
          role="application" tabindex="0"
          aria-label="Drag or use arrow keys to shift the calorie split between the three foods">
       ${tri}${greenSvg}${lineSvg}${dots}${labels}${knob}
     </svg>`;
  attachTernDrag();
  updateTernReadout();
  document.getElementById('ternHint').textContent =
    pNeed > 0 ? 'drag the point · shaded zone covers your protein' : 'drag the point';
}

function updateTernReadout(){
  const foods = ternFoodObjs();
  const kcal = ternTargetKcal();
  if (foods.some(f=>!f||f.kcal<=0) || kcal<=0) return;
  const T = LedgerCore.ternary;
  const grams = T.baryToGrams(tState.w, foods, kcal);
  const tot = T.totalsForGrams(grams, foods);
  const pNeed = ternProteinNeed();
  const pHit = tot.p >= pNeed - 0.05;

  const rows = tState.foods.map((n,i)=>
    `<div class="tern-line">
       <span class="tl-name"><span class="tl-dot" style="background:${TCOL[i]}"></span>${n}</span>
       <span class="tl-g">${Math.round(grams[i])} g</span>
     </div>`).join('');
  document.getElementById('ternReadout').innerHTML = rows +
    `<div class="tern-macros">
       <span><b>${Math.round(tot.kcal)}</b> kcal</span>
       <span class="${pHit?'pok':'pshort'}"><b>${tot.p.toFixed(0)}</b>g P${pNeed>0?` / ${Math.round(pNeed)} need`:''}</span>
       <span><b>${tot.f.toFixed(0)}</b>g F</span>
       <span><b>${tot.c.toFixed(0)}</b>g C</span>
     </div>`;
  const knob = document.getElementById('ternKnob');
  if (knob){ const xy = T.cartesianFromBary(tState.w, TV); knob.setAttribute('cx',xy[0]); knob.setAttribute('cy',xy[1]); }
}

function attachTernDrag(){
  const svg = document.getElementById('ternSvg');
  if (!svg) return;
  let dragging = false;
  const toBary = ev => {
    const r = svg.getBoundingClientRect();
    // Map client px into the viewBox coordinate space (viewBox -14 -6 268 214).
    const sx = -14 + (ev.clientX - r.left) / r.width * 268;
    const sy = -6  + (ev.clientY - r.top)  / r.height * 214;
    return LedgerCore.ternary.clampBary(LedgerCore.ternary.baryFromCartesian(sx, sy, TV));
  };
  const move = ev => { tState.w = toBary(ev); updateTernReadout(); ev.preventDefault(); };
  svg.addEventListener('pointerdown', ev => { dragging = true; svg.setPointerCapture(ev.pointerId); move(ev); });
  svg.addEventListener('pointermove', ev => { if (dragging) move(ev); });
  svg.addEventListener('pointerup',   () => { dragging = false; });
  svg.addEventListener('pointercancel',()=> { dragging = false; });

  // Keyboard equivalent: arrows shift weight between the slots, so the widget is
  // usable without a pointer instead of being drag-only.
  svg.addEventListener('keydown', ev => {
    const STEP = ev.shiftKey ? 0.10 : 0.03;
    const w = tState.w.slice();
    const shift = (from, to) => {
      const d = Math.min(STEP, w[from]);
      w[from] -= d; w[to] += d;
    };
    if (ev.key === 'ArrowUp')         { shift(1, 0); shift(2, 0); }
    else if (ev.key === 'ArrowDown')  { shift(0, 1); shift(0, 2); }
    else if (ev.key === 'ArrowLeft')  { shift(2, 1); }
    else if (ev.key === 'ArrowRight') { shift(1, 2); }
    else if (ev.key === 'Home')       { w[0] = w[1] = w[2] = 1/3; }
    else return;
    ev.preventDefault();
    const sum = w[0] + w[1] + w[2] || 1;
    tState.w = w.map(x => x / sum);
    updateTernReadout();
  });
}

document.getElementById('ternKcal').addEventListener('input', ()=>{ tState.kcalTouched = true; renderTernary(); });
['ternA','ternB','ternC'].forEach((id,slot)=>{
  document.getElementById(id).addEventListener('change', e=>{ tState.foods[slot] = e.target.value; renderTernary(); });
});

// ---- Ternary slot search: pick ANY food (USDA), not just the registered few ----
// A 🔍 on a slot opens the shared search; a chosen result is registered into the food
// registry (so it joins every select) and assigned to that slot.
let ternSearchSlot = 0;
function openTernSearch(slot){
  ternSearchSlot = slot;
  const box = document.getElementById('ternSearch');
  document.getElementById('ternSearchLbl').textContent =
    'Search any food (USDA) → Slot ' + 'ABC'[slot];
  box.hidden = false;
  document.getElementById('ternSearchResults').innerHTML = '';
  const inp = document.getElementById('ternSearchIn');
  inp.focus(); inp.select();
}
document.querySelectorAll('.tern-find').forEach(btn=>{
  btn.onclick = ()=> openTernSearch(+btn.dataset.slot);
});
document.getElementById('ternSearchBtn').onclick = async ()=>{
  const q = document.getElementById('ternSearchIn').value.trim();
  const out = document.getElementById('ternSearchResults');
  if (!q){ out.innerHTML=''; return; }
  out.innerHTML = skeleton(4);
  announce('Searching USDA');
  try {
    const results = await usdaSearch(q);
    if (!results.length){
      out.innerHTML = `<div class="tactical">No matches for “${escapeHtml(q)}”. Try a plainer name.</div>`;
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
        registerFood(r.name, r.base, 'USDA');   // joins every food select, incl. the ternary slots
        tState.foods[ternSearchSlot] = r.name;
        document.getElementById('ternSearch').hidden = true;
        renderTernary();
      };
    });
  } catch(err){ out.innerHTML = `<div class="tactical bad">${escapeHtml(err.message)}</div>`; }
};
document.getElementById('ternSearchIn').addEventListener('keydown', e=>{ if (e.key==='Enter') document.getElementById('ternSearchBtn').click(); });
document.getElementById('ternAdd').onclick = ()=>{
  const foods = ternFoodObjs();
  const kcal = ternTargetKcal();
  if (foods.some(f=>!f||f.kcal<=0) || kcal<=0) return;
  const grams = LedgerCore.ternary.baryToGrams(tState.w, foods, kcal);
  const before = ledger.slice();
  let added = 0;
  tState.foods.forEach((name,i)=>{
    const g = Math.round(grams[i]);
    if (g < 1) return;
    pushEntry(computeEntry(name, g, true, getBase(name), foodSource[name] || 'DB'));
    added++;
  });
  if (!added){
    document.getElementById('ternMsg').textContent = 'Every portion rounded to zero — raise the calorie target.';
    return;
  }
  haptic(); save(); render();
  document.getElementById('ternMsg').textContent =
    `Added ${added} ${added === 1 ? 'item' : 'items'} to the ledger.`;
  toast(`Logged ${added} ${added === 1 ? 'item' : 'items'} from the engineer`,
    { undo: ()=>{ ledger = before; save(); render(); } });
};
