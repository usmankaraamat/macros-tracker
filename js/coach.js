// coach.js -- the session planner on Lift → Log today: the readiness strip and card, today's
// generated session (shown as exercise cards by renderLiftSession in lift.js), and the nudge
// log. Every decision comes from planner.js (window.LedgerPlanner, pure rules); this file only
// gathers inputs, draws, and stores what was pressed. No AI anywhere.
//
// Storage
//   ledger_nudges        {date: nudgeRecord + {choice:'use'|'keep'|null, choiceAt}}  synced, exported
//   ledger_nudges_meta   {date: isoStamp}  drives the per-day last-write-wins merge in sync.js
//   eatify_coach_day     {date, feel, swaps:{fromId: toId}}  this device only, today only

const NUDGE_KEY = 'ledger_nudges', NUDGE_META_KEY = 'ledger_nudges_meta', COACH_DAY_KEY = 'eatify_coach_day';
function nudgeLog(){ try{ const m = JSON.parse(localStorage.getItem(NUDGE_KEY)||'{}'); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; }catch(e){ return {}; } }
function nudgeLogMeta(){ try{ const m = JSON.parse(localStorage.getItem(NUDGE_META_KEY)||'{}'); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; }catch(e){ return {}; } }
function saveNudgeLog(map, meta){
  try{ localStorage.setItem(NUDGE_KEY, JSON.stringify(map)); localStorage.setItem(NUDGE_META_KEY, JSON.stringify(meta)); }catch(e){}
}
function recordNudge(date, rec){
  const m = nudgeLog(), meta = nudgeLogMeta();
  m[date] = rec; meta[date] = new Date().toISOString();
  saveNudgeLog(m, meta); scheduleSync();
}
// The feel tap and any swaps hold for one day on this device; a new day starts clean.
function coachDay(date){
  try{ const v = JSON.parse(localStorage.getItem(COACH_DAY_KEY)||'null'); if (v && v.date === date) return Object.assign({ feel:null, swaps:{} }, v); }catch(e){}
  return { date, feel: null, swaps: {} };
}
function saveCoachDay(v){ try{ localStorage.setItem(COACH_DAY_KEY, JSON.stringify(v)); }catch(e){} }

// Yesterday's logged kcal against the corridor floor that applied to yesterday. A day with no
// entries is "unknown", so nothing is passed rather than zero.
function yesterdayIntake(date){
  const y = LedgerPlanner.addDays(date, -1);
  let l = null;
  try{ l = JSON.parse(localStorage.getItem('ledger_' + y)||'null'); }catch(e){}
  if (!Array.isArray(l) || !l.length) return null;
  const kcal = totalsOf(l).kcal, floor = dayBounds()(y).floor;
  return kcal > 0 && floor > 0 ? { kcal, floor } : null;
}

// The plan for one day, computed once per Lift render (renderLift clears it). Today's own
// logged sets never change it: the engine reads history before the day only.
let coachPlan = null, coachOpen = false, coachOpenDate = null;
function coachCalendarIds(){
  const ids = [];
  liftPlanDay().forEach(s => (s.exercises||[]).forEach(x => { if (x.kind !== '--') ids.push(planLiftName(x.name).id); }));
  return ids;
}
function coachPlanFor(date){
  const ps = plannerSettings(), day = coachDay(date), cal = coachCalendarIds();
  const key = JSON.stringify([date, ps.settings, day.feel, day.swaps, cal]);
  if (coachPlan && coachPlan.key === key) return coachPlan;
  let out;
  try{
    const input = { planned: cal.length ? cal : undefined };
    if (day.feel) input.feel = day.feel;
    const intake = yesterdayIntake(date);
    if (intake) input.intake = intake;
    out = LedgerPlanner.planToday({ workouts: allWorkouts(), catalogue: exerciseCatalog(), weights: weightSeries(),
      today: date, config: ps.config, readinessInput: input });
  }catch(e){ console.warn('planner failed', e); coachPlan = { key, failed: true, date }; return coachPlan; }
  const ctx = { index: out.index, state: out.state, readiness: out.readiness, config: ps.config, model: out.model };
  out.items = out.session.items.map(it => {
    const to = day.swaps[it.id];
    return (to && LedgerPlanner.swapItem(it, to, ctx)) || it;
  });
  out.changes = cal.length ? LedgerPlanner.planChanges(cal, { items: out.items }, out.readiness) : [];
  Object.assign(out, { key, date, ctx, calendarIds: cal, settings: ps, day,
    dayOff: out.readiness.reasons.some(r => r.code === 'NOT_A_TRAINING_DAY') });
  coachPlan = out;
  return out;
}
function coachChoice(date){ const r = nudgeLog()[date]; return (r && r.choice) || null; }
// Which list the exercise cards show. A calendar plan stays the default until "Use this plan";
// with no calendar plan the generated session is the list unless he chose "Train as planned".
function coachListActive(c){
  if (!c || c.failed || c.dayOff || c.session.rest || !c.items.length) return false;
  const ch = coachChoice(c.date);
  return c.calendarIds.length ? ch === 'use' : ch !== 'keep';
}
// The exercise cards' rows for the generated session, in the shape renderLiftSession uses for
// calendar rows (si -1 marks a generated row).
function coachPlannedRows(c){
  return c.items.map((it, xi) => ({ si: -1, xi, gen: it, id: it.id, log: it.name, bare: it.name, note: '',
    sets: it.sets, x: { name: it.name, target: it.prescription.text, kind: it.pattern === 'compound' ? 'C' : 'I' } }));
}
// The small swap list under a generated card: the engine's alternatives for the original lift,
// ready ones first, then lifts he has rarely done (labelled); a lift inside its recovery window
// or skipped by the readiness rules is never offered. "Back to" undoes a swap.
function coachSwapHTML(c, it, xi){
  const orig = it.swappedFrom ? it.swappedFrom.id : it.id;
  let alts = [];
  // Lifts already on today's list are not offered: one lift, one card.
  try{ alts = LedgerPlanner.alternatives(orig, c.ctx, 8)
    .filter(a => (a.available || a.blocked === 'RARELY_DONE') && !c.items.some(x => x.id === a.id)); }catch(e){}
  const opts = alts.slice(0, 3).map(a => `<button type="button" class="sm ghost" data-cswap="${xi}" data-to="${escapeAttr(a.id)}">${escapeHtml(a.name)}${a.available ? '' : ' <span class="ink-dim">(rarely done)</span>'}</button>`);
  if (it.swappedFrom) opts.push(`<button type="button" class="sm ghost" data-cswap="${xi}" data-to="">Back to ${escapeHtml(it.swappedFrom.name)}</button>`);
  if (!opts.length) return '';
  return `<details class="xc-swap"><summary>swap</summary><div class="xc-swap-opts">${opts.join('')}</div></details>`;
}
function bindCoachSwaps(el, c){
  el.querySelectorAll('[data-cswap]').forEach(b => {
    b.onclick = () => {
      const it = c.items[+b.dataset.cswap]; if (!it) return;
      const orig = it.swappedFrom ? it.swappedFrom.id : it.id;
      const day = coachDay(c.date);
      if (b.dataset.to) day.swaps[orig] = b.dataset.to; else delete day.swaps[orig];
      saveCoachDay(day);
      renderCoach(); renderLiftSession(allWorkouts(), weightSeries());
    };
  });
}

const COACH_TONE = { train: 'ok', pull_back: 'warn', swap: 'info', rest: 'bad' };
const COACH_FEEL = [['low', 'Low'], ['ok', 'OK'], ['good', 'Good']];
function coachDateLabel(iso){
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
// "3 days since last session" → <b>3 days</b> since last session, as in the mock-up.
function coachFactHTML(f){
  const m = /^(\d+(?: of \d+| → \d+)?(?: (?:days?|lifts?|reps))?),?\s+(.+)$/.exec(f.label);
  return m ? `<div><b>${escapeHtml(m[1])}</b>${escapeHtml(m[2])}</div>` : `<div>${escapeHtml(f.label)}</div>`;
}
function renderCoach(){
  const el = document.getElementById('liftReadiness');
  if (!el) return;
  if (typeof LedgerPlanner === 'undefined'){ el.hidden = true; return; }
  if (coachOpenDate !== VIEW_DATE){ coachOpen = false; coachOpenDate = VIEW_DATE; }   // collapsed on every new day
  const c = coachPlanFor(VIEW_DATE);
  if (c.failed){ el.hidden = true; el.innerHTML = ''; return; }
  const rd = c.readiness;
  const tone = c.dayOff ? 'off' : (COACH_TONE[rd.answer] || 'off');
  const hasSession = !c.dayOff && !c.session.rest && c.items.length > 0;
  // One record a day for the live day, so the nudge log knows the advice was seen even when no
  // button is pressed. Pressing a button rewrites it with the choice.
  if (VIEW_DATE === ACTIVE_DATE && !nudgeLog()[VIEW_DATE])
    recordNudge(VIEW_DATE, Object.assign(LedgerPlanner.nudgeRecord(rd, { items: c.items, muscles: c.session.muscles }), { choice: null }));
  el.hidden = false;
  const strip = `<button type="button" class="rd-strip rd-${tone}" id="rdToggle" aria-expanded="${coachOpen}" aria-controls="rdCard">
      <i class="rd-dot" aria-hidden="true"></i><b>${escapeHtml(rd.headline)}</b><span>${coachOpen ? 'less ‹' : 'why ›'}</span></button>`;
  if (!coachOpen){ el.innerHTML = strip; bindCoach(el, c); return; }

  const facts = rd.facts.slice(0, 4).map(coachFactHTML).join('');
  const rows = LedgerPlanner.daysSinceRows(c.state, c.settings.config).map(r =>
    `<span>${escapeHtml(r.label)}</span><i style="--w:${Math.round(r.width * 100)}%" class="rd-bar ${r.tone}"></i><span>${r.days == null ? 'never' : r.days + ' d'}</span>`).join('');
  const feel = c.dayOff ? '' : `<div class="sub">How do you feel today?</div>
    <div class="rd-feel" role="group" aria-label="How do you feel today">${COACH_FEEL.map(([v, t]) =>
      `<button type="button" class="sm${c.day.feel === v ? '' : ' ghost'}" data-feel="${v}" aria-pressed="${c.day.feel === v}">${t}</button>`).join('')}</div>`;
  let plan = '';
  if (hasSession){
    const nameOf = id => (c.state.lifts[id] && c.state.lifts[id].name) || id;
    const li = c.calendarIds.length
      ? c.changes.map(x => x.kind === 'skip' ? `<li><b>skip</b>${escapeHtml(nameOf(x.id))}</li>`
          : x.kind === 'add' ? `<li><b>add</b>${escapeHtml(x.name)} ${escapeHtml(x.text)}${x.block === 'legs' ? ' · leg block' : ''}</li>`
          : `<li><b>cap</b>${escapeHtml(x.text)}</li>`).join('') || '<li>No changes: the calendar plan matches.</li>'
      : c.items.map(it => `<li><b>${it.block === 'legs' ? 'legs' : 'add'}</b>${escapeHtml(it.name)} ${escapeHtml(it.prescription.text)}</li>`).join('');
    const dropped = c.session.dropped.length ? ` · dropped for time: ${c.session.dropped.map(d => escapeHtml(d.name)).join(', ')}` : '';
    const choice = coachChoice(c.date);
    plan = `<div class="sub">${c.calendarIds.length ? 'Changes to today’s plan' : 'Today’s session'}</div>
      <ul class="chg">${li}</ul>
      <div class="rd-mins">About ${c.session.minutes} min of ${c.session.budget}${dropped}</div>
      ${(c.session.notes||[]).map(n => `<div class="rd-mins">${escapeHtml(n.text)}</div>`).join('')}
      <div class="btns">
        <button type="button" class="${choice === 'keep' ? 'ghost' : ''}" data-choice="use" aria-pressed="${choice === 'use'}">Use this plan</button>
        <button type="button" class="${choice === 'keep' ? '' : 'ghost'}" data-choice="keep" aria-pressed="${choice === 'keep'}">Train as planned</button>
      </div>
      ${choice ? `<div class="rd-mins">${choice === 'use' ? 'Using this plan today.' : 'Training as planned today.'}</div>` : ''}`;
  } else if (!c.dayOff && c.session.rest){
    plan = `<div class="rd-mins">No session today. The logger still works if you train anyway.</div>`;
  } else if (c.dayOff){
    plan = `<div class="rd-mins">No session is planned. The logger below still works if you train anyway.</div>`;
  }
  el.innerHTML = strip + `<div class="rc rd-${tone}" id="rdCard">
      <div class="lab"><span>Readiness</span><span>${escapeHtml(coachDateLabel(VIEW_DATE))}</span></div>
      <div class="say">${escapeHtml(rd.sentence)}</div>
      <div class="facts">${facts}</div>
      ${feel}
      <div class="sub">Days since trained</div>
      <div class="mus">${rows}</div>
      ${plan}
      ${c.settings.fallback ? '<div class="rd-mins">Your saved planner settings are not valid; the defaults are in use. Check Settings → Workout planner.</div>' : ''}
    </div>`;
  bindCoach(el, c);
}
function bindCoach(el, c){
  const t = document.getElementById('rdToggle');
  if (t) t.onclick = () => { coachOpen = !coachOpen; renderCoach(); };
  el.querySelectorAll('[data-feel]').forEach(b => {
    b.onclick = () => {
      const day = coachDay(c.date);
      day.feel = day.feel === b.dataset.feel ? null : b.dataset.feel;
      saveCoachDay(day);
      renderCoach(); renderLiftSession(allWorkouts(), weightSeries());
    };
  });
  el.querySelectorAll('[data-choice]').forEach(b => {
    b.onclick = () => {
      const rec = LedgerPlanner.nudgeRecord(c.readiness, { items: c.items, muscles: c.session.muscles });
      recordNudge(c.date, Object.assign(rec, { choice: b.dataset.choice, choiceAt: new Date().toISOString() }));
      haptic();
      renderCoach(); renderLiftSession(allWorkouts(), weightSeries());
      toast(b.dataset.choice === 'use' ? 'Today’s list is the generated session' : 'Keeping today’s plan');
    };
  });
}
