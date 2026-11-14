// test-planner.mjs — tests for planner.js on synthetic fixtures (never the owner's data).
//   node scripts/test-planner.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../core.js');
const P = require('../planner.js');

let passed = 0, failed = 0;
function ok(cond, name, info) {
  if (cond) passed++;
  else { failed++; console.log('FAIL', name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ''); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

// ---- Fixtures -------------------------------------------------------------------------
// A catalogue with three familiar lifts for each priority muscle, two per leg muscle, and
// a few maintenance lifts. Seed ids pick up core's EXERCISE_META; custom ones carry maps.
const CAT = [
  { id: 'bench-press', name: 'Bench press', aliases: ['bench'] },
  { id: 'incline-dumbbell-press', name: 'Incline dumbbell press', aliases: [] },
  { id: 'machine-chest-fly', name: 'Machine chest fly', aliases: ['pec deck'], muscles: { chest: 1 }, pattern: 'isolation' },
  { id: 'lat-pulldown', name: 'Lat pulldown', aliases: [] },
  { id: 'cable-pulldown-v-bar', name: 'Cable pulldown (V-bar)', aliases: [], muscles: { lats: 1, biceps: 0.4 }, pattern: 'compound' },
  { id: 'straight-arm-pulldown', name: 'Straight arm pulldown', aliases: [], muscles: { lats: 1 }, pattern: 'isolation' },
  { id: 'lateral-raise', name: 'Lateral raise', aliases: [] },
  { id: 'cable-lateral-raise', name: 'Cable lateral raise', aliases: [], muscles: { sideDelts: 1 }, pattern: 'isolation' },
  { id: 'machine-lateral-raise', name: 'Machine lateral raise', aliases: [], muscles: { sideDelts: 1 }, pattern: 'isolation' },
  { id: 'seated-cable-row', name: 'Seated cable row', aliases: [] },
  { id: 'face-pull', name: 'Face pull', aliases: [] },
  { id: 'tricep-pushdown', name: 'Tricep pushdown', aliases: [] },
  { id: 'bicep-curl', name: 'Bicep curl', aliases: [] },
  { id: 'leg-press', name: 'Leg press', aliases: [] },
  { id: 'leg-extension', name: 'Leg extension', aliases: [] },
  { id: 'leg-curl', name: 'Leg curl', aliases: [] },
  { id: 'romanian-deadlift', name: 'Romanian deadlift', aliases: ['rdl'] },
  { id: 'never-done-press', name: 'Decline machine press', aliases: [], muscles: { chest: 1 }, pattern: 'compound' }
];
const BASE = { 'bench-press': 60, 'incline-dumbbell-press': 24, 'machine-chest-fly': 40, 'lat-pulldown': 55,
  'cable-pulldown-v-bar': 50, 'straight-arm-pulldown': 25, 'lateral-raise': 8, 'cable-lateral-raise': 7,
  'machine-lateral-raise': 30, 'seated-cable-row': 50, 'face-pull': 20, 'tricep-pushdown': 25,
  'bicep-curl': 12, 'leg-press': 120, 'leg-extension': 50, 'leg-curl': 40, 'romanian-deadlift': 70 };
const A = ['bench-press', 'lat-pulldown', 'lateral-raise', 'machine-chest-fly', 'face-pull', 'tricep-pushdown'];
const B = ['incline-dumbbell-press', 'cable-pulldown-v-bar', 'cable-lateral-raise', 'seated-cable-row', 'bicep-curl'];
const Cc = ['machine-chest-fly', 'straight-arm-pulldown', 'machine-lateral-raise', 'bench-press', 'face-pull'];
const LEGS = ['leg-press', 'leg-curl', 'leg-extension', 'romanian-deadlift'];
const add = (iso, n) => P.addDays(iso, n);

// One session: each lift gets 3 sets at a load that climbs `prog` per week, reps 10,9,8.
function sess(date, ids, o) {
  const opt = o || {};
  const week = Math.floor((Date.parse(date) - Date.parse('2026-01-01')) / (7 * 864e5));
  return { date, deload: false, exercises: ids.map(id => ({
    id, name: (CAT.find(c => c.id === id) || { name: id }).name, rir: opt.rir != null ? opt.rir : 2,
    sets: (opt.reps || [10, 9, 8]).map(r => ({ kg: Math.round((BASE[id] || 20) * (1 + (opt.prog != null ? opt.prog : 0.01) * week) * 2) / 2, reps: r }))
  })) };
}
// Six weeks, training Mon/Wed/Fri/Sun-ish on a rotating A/B/C split, legs in the first 3 weeks.
function history(end, o) {
  const opt = o || {};
  const out = [];
  const start = add(end, -42);
  const days = [0, 2, 4, 6];
  let k = 0;
  for (let w = 0; w < 6; w++) days.forEach(d => {
    const date = add(start, w * 7 + d);
    if (date >= end) return;
    const ids = [A, B, Cc][k++ % 3].slice();
    if (opt.legs !== false && w < 3 && d === 0) ids.unshift('leg-press', 'leg-curl');
    out.push(sess(date, ids, opt));
  });
  return out.filter(s => !opt.until || s.date <= opt.until);
}
const cfg = P.resolveConfig({});
const T = '2026-03-02';                    // a Monday

// ---- 1. Config validation -------------------------------------------------------------
{
  ok(P.validateConfig({}).ok, 'defaults validate');
  ok(P.validateConfig({ priorities: ['chest', 'lats'], daysPerWeek: { min: 3, max: 4, preferred: 3 } }).ok, 'custom priorities validate');
  const bad = [
    [{ priorities: ['pecs'] }, 'unknown muscle'],
    [{ priorities: ['chest', 'chest'] }, 'duplicate priority'],
    [{ daysPerWeek: { min: 5, max: 3, preferred: 4 } }, 'min > max days'],
    [{ daysPerWeek: { min: 3, max: 9, preferred: 4 } }, 'max days > 7'],
    [{ liftWindow: { earliest: 6, idealMin: 4, idealMax: 8 } }, 'earliest > idealMin'],
    [{ weeklySets: { priority: { min: 20, aim: 14, max: 12 } } }, 'band out of order'],
    [{ weeklySets: { legsFloor: { quads: -3 } } }, 'negative leg floor'],
    [{ restMode: 'nap' }, 'bad restMode'],
    [{ rirCap: { compound: 9 } }, 'rir cap > 5'],
    [{ repRange: { compound: [10, 6] } }, 'rep range reversed'],
    [{ sessionMinutes: 5 }, 'session too short'],
    [{ maxConsecutiveDays: 0 }, 'zero consecutive days'],
    [{ volumeAims: { wings: 10 } }, 'unknown muscle in volumeAims']
  ];
  bad.forEach(([c, name]) => ok(!P.validateConfig(c).ok, 'rejects: ' + name, P.validateConfig(c).errors));
  let threw = false; try { P.resolveConfig({ restMode: 'nap' }); } catch (e) { threw = true; }
  ok(threw, 'resolveConfig throws on invalid config');
  const w = P.validateConfig({ priorities: ['lats', 'chest'] }).config.priorities;
  ok(w[0].muscle === 'lats' && w[0].weight > w[1].weight, 'priority order sets weight');
}

// ---- 2. Readiness: the four answers ---------------------------------------------------
function ready(sessions, today, input, c) {
  const conf = P.resolveConfig(c || {});
  const index = P.buildIndex(sessions, CAT, today);
  const model = P.recoveryModel(index, conf);
  const state = P.weekState(index, conf, model);
  return { r: P.readiness(index, state, conf, input || {}, model), index, state, model, conf };
}
{
  // Last session 3 days ago, RIR 2, steady progress -> train.
  const h = history(T, { until: add(T, -3) });
  const { r } = ready(h, T);
  eq(r.answer, 'train', 'train: rested, RIR 2, progressing');
  ok(r.reasons.some(x => x.code === 'CLEAR'), 'train carries CLEAR code');
  ok(r.facts.length >= 4 && r.facts.every(f => f.code && f.label), 'train has four or more labelled facts', r.facts);

  // Same, but everything to failure in the last week -> pull back.
  const hf = history(T, { until: add(T, -3) }).map(s => s.date >= add(T, -7) ? sess(s.date, s.exercises.map(x => x.id), { rir: 0 }) : s);
  const pf = ready(hf, T).r;
  eq(pf.answer, 'pull_back', 'pull_back: lifts to failure');
  ok(pf.reasons.some(x => x.code === 'FAILURE_SHARE_HIGH'), 'pull_back reason FAILURE_SHARE_HIGH');
  ok(pf.modifiers.rirExtra === cfg.pullBackRirExtra, 'pull_back raises the RIR cap');
  ok(pf.facts[0].code === 'TO_FAILURE', 'pull_back leads with the failure fact', pf.facts[0]);

  // Low intake yesterday -> pull back with its code.
  const li = ready(h, T, { intake: { kcal: 1500, floor: 2500 } }).r;
  ok(li.answer === 'pull_back' && li.reasons.some(x => x.code === 'LOW_INTAKE_YESTERDAY'), 'low intake yesterday pulls back', li.reasons);
  const unl = ready(h, T, { intake: { kcal: 0, floor: 2500 } }).r;
  eq(unl.answer, 'train', 'an unlogged day (0 kcal) is not low intake');

  // Chest yesterday (after a rest day), chest is the top priority -> swap.
  // Top priority = highest weight x share of weekly aim missing; with chest the only priority
  // and chest trained yesterday after a rest day, chest is both top and unrecovered.
  const hs = history(T, { until: add(T, -3) }).concat([sess(add(T, -1), ['bench-press'])]);
  const sw = ready(hs, T, {}, { priorities: ['chest'] }).r;
  eq(sw.answer, 'swap', 'swap: top priority trained yesterday');
  ok(sw.reasons.some(x => x.code === 'PRIORITY_NOT_RECOVERED'), 'swap reason PRIORITY_NOT_RECOVERED', sw.reasons);

  // Planned lift inside its window -> swap with PLANNED_IN_WINDOW, and it is avoided.
  const hp = history(T, { until: add(T, -3) }).concat([sess(add(T, -2), ['lateral-raise'])]);
  const pw = ready(hp, T, { planned: ['lateral-raise'] }).r;
  ok(pw.answer === 'swap' && pw.reasons.some(x => x.code === 'PLANNED_IN_WINDOW'), 'swap: planned lift inside its window', pw.reasons);
  eq(pw.modifiers.avoid['lateral-raise'], 'IN_WINDOW', 'planned lift in window is avoided');

  // Two days in a row already -> rest.
  const hr = history(T, { until: add(T, -3) }).concat([sess(add(T, -2), A), sess(add(T, -1), B)]);
  const rs = ready(hr, T).r;
  eq(rs.answer, 'rest', 'rest: two consecutive days already');
  ok(rs.reasons.some(x => x.code === 'CONSECUTIVE_LIMIT'), 'rest reason CONSECUTIVE_LIMIT');

  // restMode 'lighter' never says rest.
  const lt = ready(hr, T, {}, { restMode: 'lighter' }).r;
  ok(lt.answer === 'pull_back' && lt.lighter && lt.reasons.some(x => x.code === 'LIGHTER_INSTEAD_OF_REST'), 'restMode lighter turns rest into a lighter session', lt);
  ok(['train', 'pull_back', 'swap', 'rest'].indexOf(lt.answer) >= 0, 'answer is one of the four');
}

// ---- 3. Session generator -------------------------------------------------------------
function today(sessions, day, c, input) {
  return P.planToday({ sessions, catalogue: CAT, today: day, config: c || {}, readinessInput: input || {} });
}
{
  // Never inside a lift's window: every item's daysSince >= its effective earliest.
  for (let i = 0; i < 10; i++) {
    const day = add(T, i);
    const h = history(day);
    const out = today(h, day);
    out.session.items.forEach(it => {
      const l = out.state.lifts[it.id];
      ok(l.daysSince == null || l.daysSince >= it.window.earliest, `no lift inside its window (${day} ${it.id})`, { ds: l.daysSince, w: it.window });
    });
  }

  // Leg block first when legs are under their floor, gone when they are met.
  const noLegs = history(T, { until: add(T, -3) });           // legs only in weeks 1-3, so 0 in the last 7 days
  const s1 = today(noLegs, T).session;
  ok(s1.legBlock && s1.items[0].block === 'legs', 'leg block first when legs are under floor', s1.items.map(i => i.id));
  ok(s1.items.filter(i => i.block === 'legs').every(i => i.prescription.rirCap >= cfg.rirCap.legs), 'leg block capped at the legs RIR');
  const legDone = noLegs.concat([sess(add(T, -3), ['leg-press', 'leg-extension', 'leg-curl', 'romanian-deadlift'], { reps: [10, 10, 10, 10] })]);
  const s2 = today(legDone, T).session;
  ok(!s2.legBlock, 'no leg block when legs met their floor', s2.items.map(i => i.id));

  // Never-logged lift is not chosen while staples exist.
  ok(!s1.items.some(i => i.id === 'never-done-press'), 'a never-logged lift is not chosen over staples');

  // Time budget: a 35-minute budget drops the lowest-value items and fits.
  const tight = today(noLegs, T, { sessionMinutes: 35 }).session;
  const loose = today(noLegs, T, { sessionMinutes: 120 }).session;
  ok(tight.minutes <= 35, 'time budget respected', tight.minutes);
  ok(tight.dropped.length > 0, 'time budget drops items');
  const keptMin = Math.min.apply(null, tight.items.map(i => i.value));
  ok(tight.dropped.every(d => d.value <= keptMin + 1e-9), 'dropped items are the lowest value', { dropped: tight.dropped, keptMin });
  ok(loose.items.length >= tight.items.length, 'a bigger budget keeps at least as much');

  // Rest answer gives an empty session; lighter gives fewer sets, more RIR.
  const hr = history(T, { until: add(T, -3) }).concat([sess(add(T, -2), A), sess(add(T, -1), B)]);
  const r = today(hr, T);
  ok(r.session.rest && r.session.items.length === 0, 'rest answer -> no session');
  const lt = today(hr, T, { restMode: 'lighter' });
  ok(!lt.session.rest && lt.session.lighter && lt.session.items.length <= 4 && !lt.session.legBlock, 'lighter session is short, no leg block', lt.session.items.map(i => i.id));

  // Every item carries a reason code and a reason sentence.
  ok(s1.items.every(i => i.reasons.length && i.reasonText), 'every item has reasons');
}

// ---- 4. Double progression ----------------------------------------------------------
{
  const mk = (sets, rir, pattern, equipment) => ({ info: { pattern: pattern || 'compound', equipment: equipment || 'barbell' },
    lastTop: { kg: sets[0].kg, reps: sets[0].reps, bw: false, date: '2026-01-01' }, lastSets: sets, lastRir: rir });
  const s = n => Array.from({ length: 3 }, () => ({ kg: 60, reps: n }));
  const up = P.prescribe(mk(s(10), 2), cfg, 2, 3, false);
  ok(up.rule === 'ADD_LOAD' && up.kg === 62.5 && up.reps === 6, 'top of range -> add load, back to bottom', up);
  const reps = P.prescribe(mk([{ kg: 60, reps: 8 }, { kg: 60, reps: 8 }, { kg: 60, reps: 7 }], 2), cfg, 2, 3, false);
  ok(reps.rule === 'ADD_REPS' && reps.kg === 60 && reps.reps === 9, 'inside range at same RIR -> one more rep', reps);
  const fail = P.prescribe(mk([{ kg: 60, reps: 9 }, { kg: 60, reps: 8 }], 0), cfg, 2, 3, false);
  ok(fail.kg === 60 && fail.reps === 7 && fail.rule === 'HOLD', 'from failure to RIR 2 -> same load, reps you can do 2 short', fail);
  const db = P.prescribe(mk([{ kg: 12, reps: 15 }, { kg: 12, reps: 15 }], 1, 'isolation', 'dumbbell'), cfg, 1, 3, false);
  ok(db.kg === 14 && db.reps === 10, 'dumbbell steps 2 kg', db);
  const fresh = P.prescribe({ info: { pattern: 'isolation', equipment: 'cable' }, lastTop: null, lastSets: [] }, cfg, 1, 3, false);
  ok(fresh.rule === 'NEW' && fresh.kg === null, 'no history -> find a load');
}

// ---- 5. Week planner ----------------------------------------------------------------
function plan(sessions, day, n, c) {
  return P.planWeek({ sessions, catalogue: CAT, today: day, config: c || {}, daysPerWeek: n });
}
function validWeek(w, sessions, n, label) {
  const conf = P.resolveConfig({});
  const trainDays = w.days.filter(d => d.train);
  ok(trainDays.length === n, `${label}: ${n} training days`, trainDays.length);
  // No more than maxConsecutive in a row, counting the history into today.
  const trained = new Set(sessions.map(s => s.date).concat(trainDays.map(d => d.date)));
  let run = 0, worst = 0;
  for (let i = -7; i < 7; i++) { const d = add(w.from, i); if (trained.has(d)) { run++; worst = Math.max(worst, run); } else run = 0; }
  ok(worst <= conf.maxConsecutiveDays || sessions.some(s => s.date >= add(w.from, -conf.maxConsecutiveDays)), `${label}: no run longer than ${conf.maxConsecutiveDays}`, worst);
  // Each session fits the budget; lifts never repeat inside their window across the week.
  const last = {};
  sessions.forEach(s => s.exercises.forEach(x => { last[x.id] = s.date; }));
  trainDays.forEach(d => {
    ok(d.session.minutes <= conf.sessionMinutes, `${label}: ${d.date} fits the time budget`, d.session.minutes);
    d.session.items.forEach(it => {
      const gap = last[it.id] ? (Date.parse(d.date) - Date.parse(last[it.id])) / 864e5 : null;
      ok(gap == null || gap >= it.window.earliest, `${label}: ${it.id} on ${d.date} respects its window`, { gap, w: it.window.earliest });
    });
    d.session.items.forEach(it => { last[it.id] = d.date; });
  });
  // A priority muscle is never the main target on two consecutive days.
  const hitDay = {};
  trainDays.forEach(d => d.session.items.forEach(it => {
    if (hitDay[it.muscle] && hitDay[it.muscle] !== d.date) {
      const gap = (Date.parse(d.date) - Date.parse(hitDay[it.muscle])) / 864e5;
      ok(gap >= conf.muscleMinGapDays, `${label}: ${it.muscle} not on back-to-back days`, gap);
    }
    hitDay[it.muscle] = d.date;
  }));
}
{
  const h = history(T, { until: add(T, -2) });
  [3, 4, 5].forEach(n => validWeek(plan(h, T, n), h, n, `${n}-day week`));
  const w4 = plan(h, T, 4);
  ['chest', 'lats', 'sideDelts'].forEach(g => {
    const s = w4.summary[g];
    ok(s && s.days >= 2 && s.lifts >= 2, `4-day week: ${g} twice, through two different lifts`, s);
  });
  ok(w4.legBlocks >= 1 && w4.legBlocks <= 2, '4-day week has one or two leg blocks', w4.legBlocks);

  // Asked for 5 days right after two days in a row: today must be rest, plan stays valid.
  const tired = h.concat([sess(add(T, -2), A), sess(add(T, -1), B)]);
  const w5 = plan(tired, T, 5);
  ok(!w5.days[0].train, 'after two consecutive days, today is not a training day');
  validWeek(w5, tired, w5.daysPerWeek, '5-day week after two in a row');

  // A missed day re-plans: plan today, skip it, plan tomorrow from what happened.
  const p0 = plan(h, T, 4);
  ok(p0.days[0].train, 'baseline plan trains today');
  const p1 = plan(h, add(T, 1), 4);               // nothing logged today
  validWeek(p1, h, 4, 'replan after a missed day');
  const p0first = p0.days[0].session.items.map(i => i.muscle);
  const p1first = (p1.days.find(d => d.train) || { session: { items: [] } }).session.items.map(i => i.muscle);
  ok(p0first.filter(g => ['chest', 'lats', 'sideDelts'].indexOf(g) >= 0).some(g => p1first.indexOf(g) >= 0),
    'the missed session\'s priority muscles move to the next training day', { p0first, p1first });

  // An extra day: he trained today although the plan said rest -> tomorrow respects the run.
  const extra = h.concat([sess(add(T, 1), Cc)]);
  const pe = plan(extra, add(T, 2), 4);
  validWeek(pe, extra, 4, 'replan after an extra day');
}

// ---- 6. Thin data falls back to defaults ------------------------------------------
{
  const tiny = [sess(add(T, -9), A), sess(add(T, -4), A)];
  const idx = P.buildIndex(tiny, CAT, T);
  const m = P.recoveryModel(idx, cfg);
  ok(m.global.source === 'default' && m.global.confidence === 'none' && m.global.value === cfg.liftWindow.earliest, 'thin data keeps the default lift window', m.global);
  ok(/default kept/.test(m.global.note), 'thin data says the default was kept', m.global.note);
  const win = P.effectiveWindow(m, cfg, 'bench-press', 'chest');
  ok(win.source === 'default' && win.earliest === cfg.liftWindow.earliest, 'effective window falls back to config');

  // learnFloor on synthetic observations: a clear effect with plenty of data is adopted,
  // the same effect on a small sample is not.
  const evs = (nShort, nLong, pShort, pLong) => {
    const out = [];
    for (let i = 0; i < nShort; i++) out.push({ gapLift: 1 + (i % 3), pr: i < nShort * pShort });
    for (let i = 0; i < nLong; i++) out.push({ gapLift: 4 + (i % 6), pr: i < nLong * pLong });
    return out;
  };
  const big = P.learnFloor(evs(60, 150, 0.2, 0.5), 'gapLift', [2, 3, 4, 5], 3, cfg.learning);
  ok(big.source === 'learned' && big.value === 4 && (big.confidence === 'high' || big.confidence === 'medium'), 'clear effect on enough data is learned', big);
  const small = P.learnFloor(evs(8, 12, 0.2, 0.5), 'gapLift', [2, 3, 4, 5], 3, cfg.learning);
  ok(small.source === 'default' && small.value === 3 && small.confidence === 'none', 'same effect on a small sample is not adopted', small);
  const weak = P.learnFloor(evs(40, 120, 0.38, 0.42), 'gapLift', [2, 3, 4, 5], 3, cfg.learning);
  ok(weak.source === 'default' && weak.confidence === 'low', 'a weak difference is reported but not adopted', weak);
  const floorGuard = P.learnFloor(evs(60, 150, 0.2, 0.5).map(e => ({ gapLift: e.gapLift === 1 ? 1 : e.gapLift, pr: e.pr })), 'gapLift', [2], 3, cfg.learning);
  ok(floorGuard.value >= cfg.learning.hardFloorDays, 'learned value never under the hard floor');
}

// ---- 7. Determinism ---------------------------------------------------------------
{
  const h = history(T, { until: add(T, -2) });
  const a = JSON.stringify(plan(h, T, 4).days);
  const b = JSON.stringify(plan(h, T, 4).days);
  ok(a === b, 'same input, same week plan');
  const shuffled = P.planWeek({ sessions: h.slice().reverse(), catalogue: CAT.slice().reverse(), today: T, config: {}, daysPerWeek: 4 });
  ok(JSON.stringify(shuffled.days) === a, 'input order does not change the plan',
    JSON.parse(a).map((d, i) => d.train ? d.session.items.map(x => x.id + ':' + x.sets).join(',') + ' VS ' + (shuffled.days[i].session ? shuffled.days[i].session.items.map(x => x.id + ':' + x.sets).join(',') : '-') : '').filter(Boolean));
  const t1 = JSON.stringify(today(h, T).session), t2 = JSON.stringify(today(h, T).session);
  ok(t1 === t2, 'same input, same session');
}

// ---- 8. Alternatives, volume adjustment, calendar linking, nudge log -----------------
{
  const h = history(T, { until: add(T, -3) });
  const out = today(h, T);
  const alts = P.alternatives('lateral-raise', { state: out.state, index: out.index, config: {}, model: out.model, readiness: out.readiness }, 3);
  ok(alts.length >= 2 && alts.every(a => a.id !== 'lateral-raise'), 'alternatives exclude the lift itself', alts);
  ok(alts[0].sameFamily && out.state.lifts[alts[0].id].info.primary === 'sideDelts', 'first alternative trains the same muscle with the same movement', alts[0]);

  // Volume adjustment on hand-built states.
  const st = (verdicts, done, drops) => {
    const lifts = {}, byLift = {};
    verdicts.forEach((v, i) => {
      const id = 'x' + i;
      lifts[id] = { id, info: { primary: 'chest' }, verdict: v, lastDate: add(T, -2) };
      byLift[id] = [0, 1, 2].map(k => ({ date: add(T, -2 - 3 * k), sets: drops ? [{ kg: 50, reps: 10 }, { kg: 50, reps: 5 }] : [{ kg: 50, reps: 10 }, { kg: 50, reps: 10 }], rir: 1 }));
    });
    const muscles = {};
    C.MUSCLE_GROUPS.forEach(g => { muscles[g] = { target: { min: 0, aim: 0, max: 0 }, done: 0 }; });
    muscles.chest = { target: { min: 12, aim: 14, max: 20 }, done: done };
    return { index: { today: T, byLift }, state: { lifts, muscles } };
  };
  const addCase = st(['progressing', 'progressing'], 15, false);
  eq(P.adjustVolume(addCase.index, addCase.state, {}).muscles.chest.to, 16, 'progressing cleanly with the aim met adds a set step');
  const remCase = st(['regressing', 'regressing'], 15, false);
  eq(P.adjustVolume(remCase.index, remCase.state, {}).muscles.chest.to, 12, 'two regressing lifts remove a set step');
  const dropCase = st(['stalled'], 15, true);
  eq(P.adjustVolume(dropCase.index, dropCase.state, {}).muscles.chest.action, 'REMOVE', 'repeated rep loss removes a set step');
  const holdCase = st(['progressing'], 8, false);
  eq(P.adjustVolume(holdCase.index, holdCase.state, {}).muscles.chest.action, 'HOLD', 'aim not reached -> hold');

  // Calendar linking.
  const rdl = P.linkCandidates('Barbell RDL — FIRST, free bar', CAT);
  ok(rdl.length && rdl[0].id === 'romanian-deadlift', 'calendar "Barbell RDL — notes" links to Romanian deadlift', rdl);
  const pec = P.linkCandidates('Pec deck', CAT);
  ok(pec[0] && pec[0].id === 'machine-chest-fly' && pec[0].score === 100, 'alias match scores 100', pec);
  const inc = P.linkCandidates('Incline DB press', CAT);
  ok(inc[0] && inc[0].id === 'incline-dumbbell-press', 'abbreviations expand (DB -> dumbbell)', inc);
  ok(P.linkCandidates('Zercher carry', CAT).length === 0, 'unrelated name offers nothing');
  const lp = P.linkCandidates('Cable pulldown', CAT);
  ok(lp.length >= 2 && lp[0].score >= lp[1].score, 'candidates are ranked', lp);

  // Nudge log.
  const days = [add(T, -3), add(T, -2), add(T, -1)];
  const recs = days.map(d => {
    const o = today(h.filter(s => s.date < d), d);
    return P.nudgeRecord(o.readiness, o.session);
  });
  recs[1].advised.answer = 'rest';
  const sessions = h.concat([sess(add(T, -2), A)]);
  const sc = P.scoreNudges(recs, sessions, CAT);
  const r2 = sc.rows.find(r => r.date === add(T, -2));
  ok(r2.answerFollowed === false && r2.followed === false, 'advised rest but trained -> not followed', r2);
  const r1row = sc.rows.find(r => r.date === add(T, -1));
  ok(r1row.answerFollowed === null, 'non-rest advice on a rest day is not judged', r1row);
  ok(typeof sc.followed.days === 'number' && typeof sc.notFollowed.days === 'number', 'groups report sample sizes');
  ok(recs.every(r => r.date && r.advised && Array.isArray(r.advised.lifts)), 'nudge records have the documented shape');
}

console.log(`planner tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
