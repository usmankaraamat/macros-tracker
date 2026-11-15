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

// ---- 13. Available weekdays -------------------------------------------------------------
// He trains Monday to Friday only: nothing may land on a weekend, a weekend day answers
// "rest" even in lighter mode, and five weekdays do not fit a two-in-a-row limit.
{
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  ok(!P.validateConfig({ availableWeekdays: ['Funday'] }).ok, 'unknown weekday rejected');
  ok(!P.validateConfig({ availableWeekdays: [] }).ok, 'empty weekday list rejected');
  ok(P.validateConfig({ availableWeekdays: WD }).ok, 'Monday to Friday validates');
  const h = history(T, { until: add(T, -2) });          // last session on the Saturday before
  const c = { availableWeekdays: WD };
  [3, 4].forEach(n => {
    const w = plan(h, T, n, c);
    const tr = w.days.filter(d => d.train);
    ok(tr.length === n, `weekdays only: ${n} training days`, tr.length);
    ok(tr.every(d => WD.indexOf(d.weekday) >= 0), `weekdays only: ${n}-day week has no weekend session`, tr.map(d => d.weekday));
  });
  const five = plan(h, T, 5, c);
  ok(five.days.filter(d => d.train).every(d => WD.indexOf(d.weekday) >= 0), '5 asked, weekdays only: still no weekend session');
  ok(five.daysPerWeek === 4 && five.warnings.some(x => x.code === 'DAYS_REDUCED'),
     '5 weekdays with a 2-in-a-row limit is reduced to 4, with a warning', { n: five.daysPerWeek, w: five.warnings });
  const allFive = plan(h, T, 5, { availableWeekdays: WD, maxConsecutiveDays: 5 });
  ok(allFive.daysPerWeek === 5, 'raising the in-a-row limit allows all five weekdays', allFive.daysPerWeek);
  const sat = add(T, 5);
  const wk = plan(h, sat, 4, c);
  ok(wk.days[0].train === false && wk.days[1].train === false, 'planning from a Saturday: Saturday and Sunday stay empty',
     wk.days.slice(0, 2).map(d => d.weekday + ':' + d.train));
  ok(wk.days.filter(d => d.train).every(d => WD.indexOf(d.weekday) >= 0), 'planning from a Saturday: sessions fall on weekdays');
  const today = P.planToday({ sessions: h, catalogue: CAT, today: sat, config: { availableWeekdays: WD, restMode: 'lighter' } });
  ok(today.readiness.answer === 'rest' && today.readiness.reasons.some(r => r.code === 'NOT_A_TRAINING_DAY'),
     'a day off answers rest even in lighter mode', today.readiness.answer);
  ok(today.session.rest === true && today.session.items.length === 0, 'a day off has no session');
  ok(today.readiness.headline === 'Not a training day' && /Saturday/.test(today.readiness.sentence), 'the card names the day off',
     { h: today.readiness.headline, s: today.readiness.sentence });
  const all = plan(h, T, 4, {});
  ok(all.days.filter(d => d.train).length === 4, 'default (all seven days) still plans four days');
}

// ---- App glue: settings form, days-since rows, swap ------------------------------------
{
  const d = P.appSettings(null);
  ok(d.ok, 'app settings: nothing stored is valid', d.errors);
  eq(d.settings.priorities, ['chest', 'lats', 'sideDelts'], 'app settings: default priorities');
  eq(d.settings.availableWeekdays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], 'app settings: default weekdays Mon to Fri');
  ok(d.config.restMode === 'lighter' && d.config.sessionMinutes === 75 && d.config.daysPerWeek.preferred === 4,
     'app settings: lighter, 75 min, 4 days', d.config);
  eq(d.config.availableWeekdays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], 'app settings: engine config gets the weekdays');
  const order = P.appSettings({ availableWeekdays: ['Fri', 'Mon'] });
  eq(order.settings.availableWeekdays, ['Mon', 'Fri'], 'app settings: weekdays are put in week order');
  const bad = (s, re, name) => { const r = P.appSettings(s); ok(!r.ok && r.errors.some(x => re.test(x)), name, r.errors); };
  bad({ priorities: ['chest', 'chest'] }, /once/, 'app settings: a duplicate priority is refused');
  bad({ priorities: ['quads'] }, /cannot be a priority/, 'app settings: a leg muscle is refused as a priority');
  bad({ priorities: [] }, /at least one/, 'app settings: no priority is refused');
  bad({ priorities: ['chest', 'lats', 'sideDelts', 'biceps'] }, /at most three/, 'app settings: four priorities are refused');
  bad({ daysPerWeek: 6 }, /3, 4 or 5/, 'app settings: 6 days a week is refused');
  bad({ availableWeekdays: [] }, /at least one weekday/, 'app settings: no weekdays is refused');
  bad({ availableWeekdays: ['Mon', 'Tue'] }, /at least 3/, 'app settings: two weekdays for 3+ days is refused');
  bad({ sessionMinutes: 10 }, /20 to 240/, 'app settings: a 10-minute session is refused');
  bad({ restMode: 'nap' }, /rest day is due/, 'app settings: an unknown rest mode is refused');
  ok(P.appSettings({ priorities: ['lats', '', null] }).settings.priorities.length === 1, 'app settings: blank priority slots are dropped');

  const h = history(T);
  const t = P.planToday({ sessions: h, catalogue: CAT, today: T, config: d.config });
  const rows = P.daysSinceRows(t.state, d.config);
  eq(rows.slice(0, 4).map(r => r.label), ['Chest', 'Lats', 'Side delts', 'Legs'], 'days since: priorities in order, then legs');
  ok(rows.every(r => ['bad', 'warn', 'ok', 'info'].indexOf(r.tone) >= 0 && r.width > 0 && r.width <= 1), 'days since: tones and widths are in range', rows);
  const chest = t.state.muscles.chest;
  ok(rows[0].days === chest.daysSince, 'days since: chest row reads the week state', { row: rows[0], state: chest.daysSince });
  const legsRow = rows[3];
  const legMax = Math.max(t.state.muscles.quads.daysSince, t.state.muscles.hamstrings.daysSince);
  ok(legsRow.days === legMax, 'days since: legs is the later of quads and hamstrings', { row: legsRow, legMax });
  ok(rows.slice(4).every(r => r.behind >= 1), 'days since: extra rows are muscles behind their aim', rows.slice(4));
  const empty = P.planToday({ sessions: [], catalogue: CAT, today: T, config: d.config });
  const er = P.daysSinceRows(empty.state, d.config);
  ok(er[0].days === null && er[0].tone === 'info' && er[0].width === 1, 'days since: never trained reads as overdue', er[0]);

  // The first weekday after T whose session has an upper-body lift (T itself is legs only).
  let item = null;
  for (let i = 0; i < 5 && !item; i++) {
    const tt = P.planToday({ sessions: h, catalogue: CAT, today: add(T, i), config: d.config });
    item = tt.session.items.filter(x => x.block !== 'legs')[0] || null;
    if (item) Object.assign(t, tt);
  }
  ok(!!item, 'swap: there is an upper-body item to swap');
  if (item) {
    const alts = P.alternatives(item.id, { index: t.index, state: t.state, readiness: t.readiness, config: d.config, model: t.model }, 3);
    ok(alts.length > 0, 'swap: the item has alternatives', alts);
    const s = P.swapItem(item, alts[0].id, { state: t.state, config: d.config });
    ok(s.id === alts[0].id && s.sets === item.sets && s.prescription.rirCap === item.prescription.rirCap && s.muscle === item.muscle,
       'swap: same sets, cap and muscle, new lift', s);
    ok(s.swappedFrom.id === item.id && /swapped in for/.test(s.reasonText), 'swap: remembers what it replaced', s.reasonText);
    ok(item.id !== s.id, 'swap: the original item is not mutated');
    ok(P.swapItem(item, 'no-such-lift', { state: t.state, config: d.config }) === null, 'swap: an unknown lift returns null');
  }
}

// ---- Calendar link: alias saved on the chosen lift -------------------------------------
{
  const name = 'Barbell RDL — FIRST, free bar';
  ok(C.matchExercise('Barbell RDL', CAT) === null, 'link: the calendar name does not match before linking');
  const top = P.linkCandidates(name, CAT)[0];
  const cat2 = P.linkAlias(CAT, top.id, name);
  ok(cat2 && cat2 !== CAT, 'link: a new catalogue comes back');
  const rec = cat2.find(c => c.id === top.id);
  ok(rec.aliases.indexOf('Barbell RDL') >= 0, 'link: the bare calendar name is the alias, notes dropped', rec.aliases);
  ok(CAT.find(c => c.id === top.id).aliases.indexOf('Barbell RDL') < 0, 'link: the input catalogue is untouched');
  const m = C.matchExercise('Barbell RDL', cat2);
  ok(m && m.exercise.id === top.id, 'link: after linking, the calendar name matches that lift', m && m.exercise.id);
  const again = P.linkAlias(cat2, top.id, 'barbell rdl');
  ok(again.find(c => c.id === top.id).aliases.length === rec.aliases.length, 'link: linking the same wording twice adds nothing');
  ok(P.linkAlias(CAT, 'no-such-id', name) === null && P.linkAlias(CAT, top.id, '  ') === null, 'link: unknown id or empty name returns null');
}

// ---- Calendar-week counting (weekStart) and short-day top-up ----------------------------
{
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  ok(!P.validateConfig({ weekStart: 'Xyz' }).ok && P.validateConfig({ weekStart: 'Mon' }).ok, 'weekStart: validated');
  // A heavy chest end to the previous week (Thu and Fri before Monday T).
  const h = history(T).filter(s => s.date < add(T, -4)).concat([
    sess(add(T, -4), ['bench-press', 'incline-dumbbell-press', 'machine-chest-fly', 'lat-pulldown'], { reps: [10, 9, 8, 8] }),
    sess(add(T, -3), ['machine-chest-fly', 'never-done-press', 'cable-lateral-raise'])]);
  const cfgOf = (ws, min) => P.resolveConfig({ availableWeekdays: WD, restMode: 'lighter', weekStart: ws, sessionMinutes: min || 75 });
  const stateOn = (day, ws) => { const ix = P.buildIndex(h, CAT, day, {}); return P.weekState(ix, cfgOf(ws), null); };
  const monCal = stateOn(T, 'Mon'), monRoll = stateOn(T, null);
  ok(monRoll.muscles.chest.done >= 10, 'weekStart null: Monday counts last week\'s chest sets', monRoll.muscles.chest.done);
  ok(Object.keys(monCal.muscles).every(g => monCal.muscles[g].done === 0), 'weekStart Mon: nothing is done yet on Monday');
  ok(monCal.muscles.chest.deficit === 14, 'weekStart Mon: Monday chest deficit is the whole aim', monCal.muscles.chest.deficit);
  ok(monCal.muscles.chest.daysSince === monRoll.muscles.chest.daysSince, 'weekStart Mon: days since a muscle still looks across the week boundary');
  const wedCal = stateOn(add(T, 2), 'Mon');
  ok(wedCal.range.from === T && wedCal.range.to === add(T, 1), 'weekStart Mon: Wednesday counts Monday and Tuesday only', wedCal.range);
  const plan = (ws, min) => P.planWeek({ sessions: h, catalogue: CAT, today: T, config: cfgOf(ws, min), daysPerWeek: 4 });
  const roll = plan(null), cal = plan('Mon'), cal90 = plan('Mon', 90);
  const chestOf = w => (w.summary.chest || { planned: 0 }).planned;
  ok(chestOf(cal) >= chestOf(roll) + 3, 'weekStart Mon: a week after a heavy chest week plans clearly more chest', { roll: chestOf(roll), cal: chestOf(cal) });
  ok(chestOf(cal90) >= 12, 'weekStart Mon: with time for it, chest reaches its minimum of 12', chestOf(cal90));
  [roll, cal, cal90].forEach((w, k) => {
    ok(w.days.every(d => !d.train || WD.indexOf(d.weekday) >= 0), `weekStart plan ${k}: weekdays only`);
    // Lift window: no planned lift repeats inside its own earliest-repeat window.
    const last = {};
    h.forEach(s => s.exercises.forEach(x => { last[x.id] = s.date; }));
    let bad = null;
    w.days.filter(d => d.train).forEach(d => d.session.items.forEach(it => {
      const prev = last[it.id];
      const gap = prev ? (Date.parse(d.date) - Date.parse(prev)) / 864e5 : 99;
      if (gap < it.window.earliest) bad = bad || { id: it.id, date: d.date, gap, earliest: it.window.earliest };
      last[it.id] = d.date;
    }));
    ok(!bad, `weekStart plan ${k}: no lift repeats inside its window`, bad);
    let inARow = 0, worst = 0;
    w.days.forEach(d => { inARow = d.train ? inARow + 1 : 0; worst = Math.max(worst, inARow); });
    ok(worst <= 2, `weekStart plan ${k}: never more than 2 days in a row`, worst);
  });
  // Short day, built directly: every priority and leg muscle trained yesterday (not
  // recovered), every maintenance muscle recovered and already at its floor of 4.
  const t = P.planToday({ sessions: history(T), catalogue: CAT, today: T, config: { weekStart: 'Mon' } });
  const st = JSON.parse(JSON.stringify(t.state));
  Object.keys(st.muscles).forEach(g => {
    const m = st.muscles[g];
    if (m.kind === 'priority' || m.kind === 'legs') { m.daysSince = 0; }
    else if (m.kind === 'maintenance') { m.daysSince = 4; m.done = m.target.aim; m.deficit = 0; }
  });
  const c3 = P.resolveConfig({ weekStart: 'Mon' });
  const rd = { answer: 'train', modifiers: { rirExtra: 0, setsDelta: 0, avoid: {}, lighter: false } };
  const short = P.generateSession({ index: t.index, state: st, readiness: rd, config: c3, model: t.model });
  const tops = short.items.filter(it => it.reasons.some(r => r.code === 'SHORT_DAY_TOP_UP'));
  ok(tops.length > 0, 'short day: recovered maintenance muscles top it up', short.items.map(i => i.id + ':' + i.reasons[0].code));
  ok(short.items.every(it => st.muscles[it.muscle].kind === 'maintenance'), 'short day: nothing unrecovered is added', short.items.map(i => i.muscle));
  ok(Object.keys(short.muscles).every(g => st.muscles[g].kind !== 'maintenance' || st.muscles[g].done + short.muscles[g] <= st.muscles[g].target.max + 4),
     'short day: top-up stays near the band', short.muscles);
  const lighterShort = P.generateSession({ index: t.index, state: st, readiness: Object.assign({}, rd, { modifiers: Object.assign({}, rd.modifiers, { lighter: true }) }), config: c3, model: t.model });
  ok(!lighterShort.items.some(it => it.reasons.some(r => r.code === 'SHORT_DAY_TOP_UP')), 'short day: a lighter session is never topped up');
}

console.log(`planner tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
