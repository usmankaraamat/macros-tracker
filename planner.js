// planner.js — the session planner's decision engine.
// Pure: no DOM, no storage, no network, no clock. "Today" is always an argument, and the same
// inputs give the same output. Loads as a plain <script> after core.js (exposes
// window.LedgerPlanner) and is require()-able under Node, like core.js.
//
// It reuses LedgerCore for every piece of training math that already exists there:
// e1RM / sessionMetrics / exerciseTrend (progression verdicts), fatigueIndex (rep drop-off),
// exerciseMeta / normalizeName / matchExercise (catalogue), weeklyVolumeByMuscle and
// muscleFrequency (involvement-weighted sets and days since a muscle was hit).
//
// Sections (the design note points at these by number):
//   1. Config: defaults and validation
//   2. Lift descriptions: primary muscle, movement, equipment
//   3. History index and per-lift state
//   4. PR events and the personal recovery model
//   5. State of the week
//   6. Readiness
//   7. Session generator
//   8. Week planner
//   9. Alternatives
//  10. Volume adjustment between weeks
//  11. Calendar name linking
//  12. Nudge log
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const core = isNode ? require('./core.js') : root.LedgerCore;
  const api = factory(core);
  if (isNode) module.exports = api;
  root.LedgerPlanner = api;
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  if (!C || !C.exerciseTrend) throw new Error('planner.js needs core.js (LedgerCore) loaded first');

  const DAY_MS = 86400000;
  const dnum = iso => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY_MS);
  const diso = n => new Date(n * DAY_MS).toISOString().slice(0, 10);
  const addDays = (iso, n) => diso(dnum(iso) + n);
  const r1 = x => Math.round(x * 10) / 10;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekday = iso => WEEKDAY[((dnum(iso) + 3) % 7 + 7) % 7];
  const MUSCLES = C.MUSCLE_GROUPS;
  const LABEL = C.MUSCLE_LABEL;
  const LEG_MUSCLES = ['quads', 'hamstrings'];
  const clone = x => JSON.parse(JSON.stringify(x));

  // =====================================================================================
  // 1. Config: defaults and validation
  // Every number is documented with its source in specs/08b-session-planner.md.
  // =====================================================================================
  const DEFAULT_CONFIG = {
    // Ordered, highest first. Plain strings get weights 3, 2.5, 2, 1.75, 1.5 by position.
    priorities: ['chest', 'lats', 'sideDelts'],
    daysPerWeek: { min: 3, max: 5, preferred: 4 },
    weeklySets: {
      priority: { min: 12, aim: 14, max: 20 },     // hard sets per week, involvement-weighted
      maintenance: { min: 4, aim: 4, max: 10 },
      legsFloor: { quads: 6, hamstrings: 6 }
    },
    // Muscles that get a maintenance floor. The rest (forearms, abs, calves, traps, lower
    // back) are counted and shown but never scheduled for their own sake.
    maintenanceMuscles: ['chest', 'frontDelts', 'sideDelts', 'rearDelts', 'triceps', 'biceps',
      'lats', 'upperBack', 'quads', 'hamstrings', 'glutes'],
    maintenanceWeight: 1,
    legWeight: 1.5,
    perSessionMuscleCap: 8,                         // fractional hard sets for one muscle in one session
    liftWindow: { earliest: 3, idealMin: 4, idealMax: 8 },   // days between two sessions of the same lift
    muscleMinGapDays: 2,                            // days between two sessions that hit a muscle hard
    legBlockGapDays: 3,                             // days between two leg blocks
    rirCap: { compound: 2, isolation: 1, legs: 2 },
    pullBackRirExtra: 1,
    maxConsecutiveDays: 2,
    sessionMinutes: 75,
    repRange: { compound: [6, 10], isolation: [10, 15], legs: [8, 12] },
    setsPerLift: { min: 2, max: 4, legBlock: [2, 3] },
    maxLiftsPerSession: 7,
    loadStep: { barbell: 2.5, smith: 2.5, machine: 2.5, cable: 2.5, dumbbell: 2, bodyweight: 0, other: 2.5 },
    timing: { warmupMin: 8, workSec: 45, restSec: { compound: 150, isolation: 90 }, changeoverSec: 60 },
    availableWeekdays: WEEKDAY.slice(),             // weekdays he can train on, e.g. ['Mon','Tue','Wed','Thu','Fri']
    restMode: 'rest',                               // 'rest' or 'lighter' (never says "rest")
    // How "sets done this week" is counted. null: the 7 days before today (rolling). A weekday
    // ('Mon'): sets since the most recent such day, so each calendar week starts at zero and a
    // heavy end to last week does not count against this week's aim. Recovery is still guarded
    // by the lift and muscle windows, which look back across the week boundary.
    weekStart: null,
    readiness: {
      recentDays: 7,            // window for the share of exercises taken to failure
      failureShareHigh: 0.6,    // this share of rated exercises at RIR 0 = a fatigue signal
      failureMinRated: 4,       // fewer rated exercises than this = no failure signal
      dropoffHigh: 0.30,        // core.fatigueIndex 'high' flag: >30% raw rep drop at one load
      dropoffHighCount: 2,      // lifts in the last session over the drop-off line
      regressingCount: 2,       // regressing lifts (done in the last 14 days) = a fatigue signal
      restRegressingCount: 3,   // ...this many plus a drop-off signal = rest
      lowIntakeRatio: 0.85      // yesterday's kcal below 85% of the corridor floor = low intake
    },
    learning: { minPerSide: 15, minTotal: 30, mediumZ: 1.5, highZ: 2.5, highTotal: 80, hardFloorDays: 2 },
    volumeStep: 2,              // weekly sets added or removed by the between-week adjustment
    volumeAims: {},             // muscle -> weekly aim, written by adjustVolume()
    stallRotateDays: 21,        // no new best for this long (and 3+ sessions) = rotate the lift out
    stapleWindowDays: 56        // "recent" for how familiar a lift is
  };
  const PRIORITY_WEIGHTS = [3, 2.5, 2, 1.75, 1.5, 1.25];

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function deepMerge(base, over) {
    if (!isObj(over)) return clone(base);
    const out = clone(base);
    Object.keys(over).forEach(k => {
      if (isObj(out[k]) && isObj(over[k]) && k !== 'volumeAims') out[k] = deepMerge(out[k], over[k]);
      else out[k] = clone(over[k]);
    });
    return out;
  }
  function normPriorities(list) {
    return (list || []).map((p, i) => typeof p === 'string'
      ? { muscle: p, weight: PRIORITY_WEIGHTS[Math.min(i, PRIORITY_WEIGHTS.length - 1)] }
      : { muscle: p && p.muscle, weight: p && +p.weight });
  }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  // Returns {ok, errors:[...], config}. config is the merged, normalised config (only
  // trustworthy when ok is true).
  function validateConfig(user) {
    const c = deepMerge(DEFAULT_CONFIG, user || {});
    const e = [];
    c.priorities = normPriorities(c.priorities);
    const seen = {};
    c.priorities.forEach(p => {
      if (MUSCLES.indexOf(p.muscle) < 0) e.push(`unknown priority muscle "${p.muscle}"`);
      else if (seen[p.muscle]) e.push(`priority "${p.muscle}" listed twice`);
      seen[p.muscle] = 1;
      if (!(p.weight > 0) || p.weight > 10) e.push(`priority weight for ${p.muscle} must be in (0, 10]`);
    });
    const d = c.daysPerWeek;
    if (!isNum(d.min) || !isNum(d.max) || d.min < 1 || d.max > 7 || d.min > d.max) e.push('daysPerWeek needs 1 <= min <= max <= 7');
    if (!isNum(d.preferred) || d.preferred < d.min || d.preferred > d.max) e.push('daysPerWeek.preferred must sit between min and max');
    ['priority', 'maintenance'].forEach(k => {
      const b = c.weeklySets[k];
      if (!b || !isNum(b.min) || !isNum(b.max) || !isNum(b.aim) || b.min < 0 || b.min > b.aim || b.aim > b.max || b.max > 40)
        e.push(`weeklySets.${k} needs 0 <= min <= aim <= max <= 40`);
    });
    Object.keys(c.weeklySets.legsFloor || {}).forEach(g => {
      if (MUSCLES.indexOf(g) < 0) e.push(`unknown leg muscle "${g}"`);
      const v = c.weeklySets.legsFloor[g];
      if (!isNum(v) || v < 0 || v > 30) e.push(`weeklySets.legsFloor.${g} must be 0..30`);
    });
    (c.maintenanceMuscles || []).forEach(g => { if (MUSCLES.indexOf(g) < 0) e.push(`unknown maintenance muscle "${g}"`); });
    Object.keys(c.volumeAims || {}).forEach(g => {
      if (MUSCLES.indexOf(g) < 0) e.push(`unknown muscle in volumeAims "${g}"`);
      else if (!isNum(c.volumeAims[g]) || c.volumeAims[g] < 0 || c.volumeAims[g] > 40) e.push(`volumeAims.${g} must be 0..40`);
    });
    if (!isNum(c.perSessionMuscleCap) || c.perSessionMuscleCap < 2 || c.perSessionMuscleCap > 15) e.push('perSessionMuscleCap must be 2..15');
    const w = c.liftWindow;
    if (!isNum(w.earliest) || w.earliest < 1 || !(w.earliest <= w.idealMin) || !(w.idealMin <= w.idealMax) || w.idealMax > 28)
      e.push('liftWindow needs 1 <= earliest <= idealMin <= idealMax <= 28');
    if (!isNum(c.muscleMinGapDays) || c.muscleMinGapDays < 1 || c.muscleMinGapDays > 7) e.push('muscleMinGapDays must be 1..7');
    if (!isNum(c.legBlockGapDays) || c.legBlockGapDays < 1 || c.legBlockGapDays > 7) e.push('legBlockGapDays must be 1..7');
    ['compound', 'isolation', 'legs'].forEach(k => {
      const v = c.rirCap[k];
      if (!isNum(v) || v < 0 || v > 5) e.push(`rirCap.${k} must be 0..5`);
      const r = c.repRange[k];
      if (!Array.isArray(r) || r.length !== 2 || !(r[0] >= 1) || !(r[0] < r[1]) || r[1] > 30) e.push(`repRange.${k} must be [low, high] with 1 <= low < high <= 30`);
    });
    if (!isNum(c.maxConsecutiveDays) || c.maxConsecutiveDays < 1 || c.maxConsecutiveDays > 7) e.push('maxConsecutiveDays must be 1..7');
    if (!isNum(c.sessionMinutes) || c.sessionMinutes < 20 || c.sessionMinutes > 240) e.push('sessionMinutes must be 20..240');
    if (!Array.isArray(c.availableWeekdays) || !c.availableWeekdays.length || c.availableWeekdays.some(d => WEEKDAY.indexOf(d) < 0))
      e.push('availableWeekdays must be a non-empty list of ' + WEEKDAY.join(', '));
    if (['rest', 'lighter'].indexOf(c.restMode) < 0) e.push('restMode must be "rest" or "lighter"');
    if (c.weekStart != null && WEEKDAY.indexOf(c.weekStart) < 0) e.push('weekStart must be null or one of ' + WEEKDAY.join(', '));
    const s = c.setsPerLift;
    if (!(s.min >= 1) || !(s.min <= s.max) || s.max > 8) e.push('setsPerLift needs 1 <= min <= max <= 8');
    if (!(c.maxLiftsPerSession >= 1 && c.maxLiftsPerSession <= 12)) e.push('maxLiftsPerSession must be 1..12');
    if (!(c.volumeStep >= 0 && c.volumeStep <= 6)) e.push('volumeStep must be 0..6');
    return { ok: e.length === 0, errors: e, config: c };
  }
  function resolveConfig(user) {
    if (user && user.__resolved) return user;
    const v = validateConfig(user);
    if (!v.ok) throw new Error('Invalid planner config: ' + v.errors.join('; '));
    Object.defineProperty(v.config, '__resolved', { value: true });
    return v.config;
  }

  // =====================================================================================
  // 2. Lift descriptions: primary muscle, movement, equipment
  // core.exerciseMeta gives the muscle map and compound/isolation. The planner also needs
  // the equipment (most catalogue records lack it, so it is read from the name) and a finer
  // movement pattern, so "a lift that trains the same muscle with the same pattern" is a rule
  // and not a guess.
  // =====================================================================================
  function inferEquipment(name, meta, bw) {
    const n = ' ' + C.normalizeName(name) + ' ';
    if (/ smith /.test(n)) return 'smith';
    if (bw || (/ bodyweight | pull up | chin up | push up | dip /.test(n) && !/ machine /.test(n))) return 'bodyweight';
    if (/ machine | pec deck | leg press | leg curl | leg extension | hack | adduction | abduction | calf raise /.test(n)) return 'machine';
    if (/ cable | rope | pulldown | pushdown | face pull | crossover /.test(n)) return 'cable';
    if (/ dumbbell /.test(n)) return 'dumbbell';
    if (/ barbell | ez bar | bench press | deadlift | squat | overhead press | skull crusher /.test(n)) return 'barbell';
    return (meta && meta.equipment) || 'other';
  }
  function movementOf(primary, name, pattern) {
    const n = ' ' + C.normalizeName(name) + ' ';
    switch (primary) {
      case 'chest':
        if (/ fly | flye | pec deck | crossover /.test(n)) return 'fly';
        if (/ dip /.test(n)) return 'press-dip';
        return / incline /.test(n) ? 'press-incline' : / decline /.test(n) ? 'press-decline' : 'press-flat';
      case 'frontDelts': return 'press-vertical';
      case 'sideDelts': return / press /.test(n) ? 'press-vertical' : 'raise-lateral';
      case 'rearDelts': return 'fly-rear';
      case 'lats': return / straight arm | pullover /.test(n) ? 'pullover' : / row /.test(n) ? 'row' : 'pull-vertical';
      case 'upperBack': return / shrug /.test(n) ? 'shrug' : 'row';
      case 'traps': return 'shrug';
      case 'triceps': return / press | dip /.test(n) ? 'press-close' : 'extension';
      case 'biceps': return 'curl';
      case 'forearms': return 'curl-forearm';
      case 'quads': return / extension /.test(n) ? 'extension-knee' : 'squat';
      case 'hamstrings': return / curl /.test(n) ? 'curl-knee' : 'hinge';
      case 'glutes': return / abduction | adduction /.test(n) ? 'hip-ab-ad' : 'hip';
      case 'lowerBack': return 'hinge-back';
      case 'calves': return 'calf';
      case 'abs': return 'core';
      default: return pattern || 'other';
    }
  }
  const family = mv => String(mv || '').split('-')[0];
  // One catalogue record (or a logged exercise with no record) -> what the planner needs.
  function describeLift(entry) {
    const e = entry || {};
    const meta = C.exerciseMeta(e);
    const muscles = meta.muscles || {};
    let primary = null;
    MUSCLES.forEach(g => { if (muscles[g] > 0 && (primary == null || muscles[g] > muscles[primary])) primary = g; });
    const pattern = meta.pattern || (Object.keys(muscles).length >= 2 ? 'compound' : 'isolation');
    const movement = movementOf(primary, e.name || e.id, pattern);
    return {
      id: e.id, name: e.name || e.id, muscles: muscles, primary: primary, pattern: pattern,
      movement: movement, family: family(movement),
      equipment: inferEquipment(e.name || e.id, meta, e.bw),
      isLeg: LEG_MUSCLES.indexOf(primary) >= 0, tagged: meta.tagged
    };
  }

  // =====================================================================================
  // 3. History index and per-lift state
  // =====================================================================================
  // Accepts the app's {date: workout} map or an array. Keeps sessions with at least one
  // working set, sorted by date. Exercises are keyed by catalogue id (an equipment tag on a
  // session is kept but does not split a lift here, see the design note).
  function normalizeSessions(workouts) {
    const list = Array.isArray(workouts) ? workouts : Object.keys(workouts || {}).map(k => workouts[k]);
    return list.filter(w => w && w.date && Array.isArray(w.exercises)).map(w => ({
      date: w.date, deload: !!w.deload, planned: !!w.planned,
      exercises: w.exercises.filter(x => x && x.id && C.workingSetCount(x) > 0).map(x => ({
        id: x.id, name: x.name || x.id, rir: x.rir, equipment: x.equipment || null,
        sets: (x.sets || []).filter(s => s && !s.warmup && +s.reps > 0)
      }))
    })).filter(w => w.exercises.length).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  }
  function weightSeries(weights) {
    if (Array.isArray(weights)) return weights.filter(w => w && w.date && +w.kg > 0);
    return Object.keys(weights || {}).filter(d => +weights[d] > 0).sort().map(d => ({ date: d, kg: +weights[d] }));
  }

  // Everything the planner reads about the past, as of the START of `today`. Sessions on
  // or after today are ignored, so a backtest can ask "what would it have said that morning".
  function buildIndex(sessions, catalogue, today, opts) {
    const o = opts || {};
    // Sorted by date (then planned after real), so the caller's order never matters.
    const all = (sessions || []).filter(s => s && s.date < today).slice()
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.planned ? 1 : 0) - (b.planned ? 1 : 0));
    const cat = (catalogue && catalogue.length ? catalogue : C.SEED_EXERCISES);
    const byId = {}, info = {}, byLift = {}, lastDate = {}, firstDate = {};
    cat.forEach(c => { if (c && c.id) { byId[c.id] = c; info[c.id] = describeLift(c); } });
    all.forEach(s => s.exercises.forEach(x => {
      if (!info[x.id]) info[x.id] = describeLift({ id: x.id, name: x.name });
      (byLift[x.id] = byLift[x.id] || []).push({ date: s.date, sets: x.sets, rir: x.rir, deload: s.deload, planned: s.planned, name: x.name });
      lastDate[x.id] = s.date;
      if (!firstDate[x.id]) firstDate[x.id] = s.date;
    }));
    const catalogueForCore = Object.keys(info).map(id => byId[id] || { id: id, name: info[id].name });
    // Equipment "implied by his catalogue": what he has actually logged on. Empty history
    // means nothing is known yet, so nothing is excluded.
    const equipment = {};
    Object.keys(byLift).forEach(id => { if (byLift[id].some(h => !h.planned)) equipment[info[id].equipment] = true; });
    return { today: today, sessions: all, byId: byId, info: info, byLift: byLift, lastDate: lastDate,
             firstDate: firstDate, catalogue: catalogueForCore, equipment: equipment,
             weights: weightSeries(o.weights) };
  }

  function topSetOf(sets, bwKg) {
    let top = null, topLoad = -1;
    (sets || []).forEach(s => { const l = C.setLoad(s, bwKg); if (l != null && l > topLoad) { topLoad = l; top = s; } });
    return top;
  }
  function metricOf(sess, cls, W) {
    const m = C.sessionMetrics(sess.sets, { bodyweightKg: C.weightAt(W, sess.date), rir: sess.rir });
    return cls === 'volume' ? m.bestCapacity : m.bestE1RM;
  }

  // What the planner knows about one lift on `today`.
  function liftState(index, id, config) {
    const cfg = config;
    const today = index.today;
    const all = index.byLift[id] || [];
    const real = all.filter(h => !h.planned);
    const info = index.info[id] || describeLift({ id: id });
    const t = C.exerciseTrend(real, { name: info.name, weights: index.weights });
    const last = all.length ? all[all.length - 1] : null;
    const lastReal = real.length ? real[real.length - 1] : null;
    const daysSince = last ? dnum(today) - dnum(last.date) : null;
    const recentFrom = addDays(today, -cfg.stapleWindowDays);
    const recent = real.filter(h => h.date >= recentFrom).length;
    let dropoff = null, lastTop = null, lastRir = null;
    if (lastReal) {
      dropoff = C.fatigueIndex(lastReal.sets, { rir: lastReal.rir });
      const bw = C.weightAt(index.weights, lastReal.date);
      const top = topSetOf(lastReal.sets, bw);
      if (top) lastTop = { kg: +top.kg || 0, reps: +top.reps, bw: !!top.bw, date: lastReal.date };
      lastRir = lastReal.rir != null && isFinite(+lastReal.rir) ? +lastReal.rir : null;
    }
    // How long since the lift last set a new best (its own metric class). A lift that is not
    // progressing and has gone stallRotateDays without a best, over 3+ sessions, is stalled.
    let bestDate = null, best = -Infinity, sinceBest = 0;
    const cls = t.cls;
    real.forEach(h => {
      const v = metricOf(h, cls, index.weights);
      if (v != null && v > best) { best = v; bestDate = h.date; sinceBest = 0; } else sinceBest++;
    });
    const daysSinceBest = bestDate ? dnum(today) - dnum(bestDate) : null;
    const stalled = t.verdict !== 'progressing' && t.verdict !== 'thin' && daysSinceBest != null
      && daysSinceBest >= cfg.stallRotateDays && sinceBest >= 3;
    return { id: id, name: info.name, info: info, sessions: real.length, recent: recent,
             daysSince: daysSince, lastDate: last ? last.date : null, verdict: t.verdict,
             confidence: t.confidence, pctPerMonth: t.pctPerMonth, lastTop: lastTop, lastRir: lastRir,
             lastSets: lastReal ? lastReal.sets : [], dropoff: dropoff,
             daysSinceBest: daysSinceBest, sessionsSinceBest: sinceBest, stalled: stalled };
  }

  // =====================================================================================
  // 4. PR events and the personal recovery model
  // A PR = a new best for that lift on its own metric (e1RM, or capacity for high-rep lifts
  // in 'class' mode). Each lift-session that had a previous best is one observation, tagged
  // with three gaps: days since the same lift, since any session, since its primary muscle.
  // =====================================================================================
  function prEvents(index, opts) {
    const o = opts || {};
    const mode = o.mode || 'e1rm';
    const sessions = index.sessions.filter(s => !s.planned);
    const sessDates = sessions.map(s => s.date);
    const hits = {};                                  // muscle -> sorted dates hit (>=0.25 set)
    sessions.forEach(s => {
      const today = {};
      s.exercises.forEach(x => {
        const m = (index.info[x.id] || {}).muscles || {};
        Object.keys(m).forEach(g => { if (m[g] >= 0.25) today[g] = 1; });
      });
      Object.keys(today).forEach(g => (hits[g] = hits[g] || []).push(s.date));
    });
    const prevIn = (dates, d) => { let p = null; for (let i = 0; i < dates.length && dates[i] < d; i++) p = dates[i]; return p; };
    const out = [];
    Object.keys(index.byLift).forEach(id => {
      const hist = index.byLift[id].filter(h => !h.planned);
      if (hist.length < 2) return;
      const cls = mode === 'class' ? C.classifyExercise(hist) : 'strength';
      let best = null, prevDate = null;
      const info = index.info[id];
      hist.forEach(h => {
        const v = metricOf(h, cls, index.weights);
        if (v == null || !(v > 0)) { prevDate = h.date; return; }
        if (best != null) {
          const ps = prevIn(sessDates, h.date), pm = info.primary ? prevIn(hits[info.primary] || [], h.date) : null;
          out.push({ date: h.date, id: id, primary: info.primary, pr: v > best + 1e-9,
                     gapLift: prevDate ? dnum(h.date) - dnum(prevDate) : null,
                     gapSession: ps ? dnum(h.date) - dnum(ps) : null,
                     gapMuscle: pm ? dnum(h.date) - dnum(pm) : null });
        }
        if (best == null || v > best) best = v;
        prevDate = h.date;
      });
    });
    return out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1);
  }
  function rateTable(events, key, bins) {
    return bins.map(b => {
      const ev = events.filter(e => e[key] != null && e[key] >= b[0] && e[key] <= b[1]);
      const prs = ev.filter(e => e.pr).length, n = ev.length;
      return { label: b[0] === b[1] ? String(b[0]) : b[1] >= 999 ? b[0] + '+' : b[0] + '-' + b[1],
               lo: b[0], hi: b[1], n: n, prs: prs, rate: n ? prs / n : null };
    });
  }
  const LIFT_BINS = [[1, 3], [4, 5], [6, 8], [9, 13], [14, 999]];
  const SESSION_BINS = [[1, 1], [2, 2], [3, 4], [5, 999]];
  const MUSCLE_BINS = [[1, 1], [2, 2], [3, 4], [5, 7], [8, 999]];

  // Is a short gap clearly worse than a normal one? For each candidate floor f, compare PR
  // rates for gaps < f against gaps f..13 (14+ days is detraining or a returning lift, a
  // different question). Two-proportion z = (rateLong - rateShort) / SE. The floor with the
  // largest z wins, if both sides have enough observations. Confidence:
  //   none   - not enough data on either side: the default is used.
  //   low    - a difference, but under mediumZ: reported, default kept.
  //   medium - z >= mediumZ: the learned floor replaces the default.
  //   high   - z >= highZ and highTotal observations.
  function learnFloor(events, key, candidates, defaultValue, L) {
    const usable = events.filter(e => e[key] != null && e[key] <= 13);
    let bestF = null;
    candidates.forEach(f => {
      const a = usable.filter(e => e[key] < f), b = usable.filter(e => e[key] >= f);
      if (a.length < L.minPerSide || b.length < L.minPerSide) return;
      const pa = a.filter(e => e.pr).length / a.length, pb = b.filter(e => e.pr).length / b.length;
      const se = Math.sqrt(pa * (1 - pa) / a.length + pb * (1 - pb) / b.length) || 1e-9;
      const z = (pb - pa) / se;
      if (!bestF || z > bestF.z) bestF = { f: f, z: z, nShort: a.length, nLong: b.length, rateShort: pa, rateLong: pb };
    });
    const n = usable.length;
    let confidence = 'none';
    if (bestF && n >= L.minTotal) confidence = bestF.z >= L.highZ && n >= L.highTotal ? 'high' : bestF.z >= L.mediumZ ? 'medium' : 'low';
    const adopted = confidence === 'medium' || confidence === 'high';
    const value = adopted ? Math.max(L.hardFloorDays, bestF.f) : defaultValue;
    return { value: value, defaultValue: defaultValue, source: adopted ? 'learned' : 'default',
             learned: bestF ? bestF.f : null, z: bestF ? r1(bestF.z) : null, n: n, confidence: confidence,
             detail: bestF ? { nShort: bestF.nShort, nLong: bestF.nLong, rateShort: bestF.rateShort, rateLong: bestF.rateLong } : null,
             note: adopted ? `learned from ${n} lift-sessions (z ${r1(bestF.z)})`
               : bestF ? `data suggests ${bestF.f} days but only at z ${r1(bestF.z)}; default kept`
                 : `fewer than ${L.minPerSide} observations on a side; default kept` };
  }

  function recoveryModel(index, config, opts) {
    const cfg = resolveConfig(config);
    const L = cfg.learning;
    const events = prEvents(index, opts);
    const liftCands = [2, 3, 4, 5].filter(f => f <= cfg.liftWindow.idealMax);
    const global = learnFloor(events, 'gapLift', liftCands, cfg.liftWindow.earliest, L);
    const muscle = {}, lift = {}, muscleGap = {};
    MUSCLES.forEach(g => {
      const ev = events.filter(e => e.primary === g);
      if (!ev.length) return;
      muscle[g] = Object.assign(learnFloor(ev, 'gapLift', liftCands, cfg.liftWindow.earliest, L), { table: rateTable(ev, 'gapLift', LIFT_BINS) });
      muscleGap[g] = Object.assign(learnFloor(ev, 'gapMuscle', [2, 3, 4], cfg.muscleMinGapDays, L), { table: rateTable(ev, 'gapMuscle', MUSCLE_BINS) });
    });
    Object.keys(index.byLift).forEach(id => {
      const ev = events.filter(e => e.id === id);
      if (ev.length) lift[id] = learnFloor(ev, 'gapLift', liftCands, cfg.liftWindow.earliest, L);
    });
    return { events: events.length, prs: events.filter(e => e.pr).length,
             tables: { byLiftGap: rateTable(events, 'gapLift', LIFT_BINS),
                       bySessionGap: rateTable(events, 'gapSession', SESSION_BINS) },
             global: global, muscle: muscle, muscleGap: muscleGap, lift: lift };
  }
  const adopted = r => r && (r.confidence === 'medium' || r.confidence === 'high');
  // The window used for one lift: its own learned floor, else its muscle's, else the global
  // one, else the config default. A learned value never goes below learning.hardFloorDays.
  function effectiveWindow(model, cfg, id, primary) {
    const w = cfg.liftWindow;
    let pick = null, source = 'default';
    if (model) {
      if (adopted(model.lift[id])) { pick = model.lift[id]; source = 'lift'; }
      else if (primary && adopted(model.muscle[primary])) { pick = model.muscle[primary]; source = 'muscle'; }
      else if (adopted(model.global)) { pick = model.global; source = 'global'; }
    }
    const earliest = pick ? pick.value : w.earliest;
    return { earliest: earliest, idealMin: Math.max(w.idealMin, earliest), idealMax: Math.max(w.idealMax, earliest),
             source: source, n: pick ? pick.n : 0, confidence: pick ? pick.confidence : 'none' };
  }
  function effectiveMuscleGap(model, cfg, g) {
    const r = model && model.muscleGap[g];
    return adopted(r) ? r.value : cfg.muscleMinGapDays;
  }

  // =====================================================================================
  // 5. State of the week
  // =====================================================================================
  function targetFor(g, cfg) {
    const pr = cfg.priorities.filter(p => p.muscle === g)[0];
    const ws = cfg.weeklySets;
    let t;
    if (pr) t = { kind: 'priority', min: ws.priority.min, aim: ws.priority.aim, max: ws.priority.max, weight: pr.weight };
    else if (ws.legsFloor[g] != null) t = { kind: 'legs', min: ws.legsFloor[g], aim: ws.legsFloor[g], max: Math.max(ws.legsFloor[g], ws.maintenance.max), weight: cfg.legWeight };
    else if (cfg.maintenanceMuscles.indexOf(g) >= 0) t = { kind: 'maintenance', min: ws.maintenance.min, aim: ws.maintenance.aim, max: ws.maintenance.max, weight: cfg.maintenanceWeight };
    else t = { kind: 'none', min: 0, aim: 0, max: 0, weight: 0 };
    if (cfg.volumeAims[g] != null && t.kind !== 'none') t.aim = clamp(cfg.volumeAims[g], t.min, t.max);
    return t;
  }

  function trainedDates(index) {
    const s = {};
    index.sessions.forEach(x => { s[x.date] = 1; });
    return s;
  }
  function weekState(index, config, model) {
    const cfg = resolveConfig(config);
    const today = index.today;
    let range = { from: addDays(today, -7), to: addDays(today, -1) };
    if (cfg.weekStart) {
      const back = ((WEEKDAY.indexOf(weekday(today)) - WEEKDAY.indexOf(cfg.weekStart)) % 7 + 7) % 7;
      range = { from: addDays(today, -back), to: addDays(today, -1) };
    }
    // Monday with a Monday week start: nothing done yet this week.
    const done = range.from > range.to ? {} : C.weeklyVolumeByMuscle(index.sessions, index.catalogue, range);
    const freq = C.muscleFrequency(index.sessions, index.catalogue);
    const muscles = {};
    MUSCLES.forEach(g => {
      const t = targetFor(g, cfg);
      const dates = freq[g] ? freq[g].dates : [];
      const last = dates.length ? dates[dates.length - 1] : null;
      const d = r1(done[g] || 0);
      muscles[g] = { muscle: g, label: LABEL[g], kind: t.kind, weight: t.weight,
                     target: { min: t.min, aim: t.aim, max: t.max }, done: d,
                     deficit: r1(Math.max(0, t.aim - d)),
                     daysSince: last ? dnum(today) - dnum(last) : null, lastDate: last,
                     minGap: effectiveMuscleGap(model, cfg, g) };
    });
    const lifts = {};
    Object.keys(index.info).forEach(id => { lifts[id] = liftState(index, id, cfg); });
    const tr = trainedDates(index);
    let consecutive = 0;
    for (let d = addDays(today, -1); tr[d]; d = addDays(d, -1)) consecutive++;
    const lastSession = index.sessions.length ? index.sessions[index.sessions.length - 1] : null;
    return { today: today, range: range, muscles: muscles, lifts: lifts, untaggedSets: r1(done.__untagged || 0),
             consecutive: consecutive, lastSessionDate: lastSession ? lastSession.date : null,
             daysSinceLast: lastSession ? dnum(today) - dnum(lastSession.date) : null,
             sessionsLast7: index.sessions.filter(s => s.date >= addDays(today, -7)).length };
  }

  // =====================================================================================
  // 6. Readiness
  // One of exactly four answers: train / pull_back / swap / rest. Rules run in that order of
  // precedence (rest beats swap beats pull_back beats train); every rule that fired is kept
  // as a reason code so the card can say why.
  // input: { feel: 'low'|'ok'|'good', intake: { kcal, floor }, planned: [liftIds] }
  // =====================================================================================
  function fatigueSignals(index, state, cfg) {
    const R = cfg.readiness;
    const from = addDays(index.today, -R.recentDays);
    let rated = 0, failed = 0;
    index.sessions.filter(s => s.date >= from && !s.planned).forEach(s => s.exercises.forEach(x => {
      if (x.rir != null && isFinite(+x.rir)) { rated++; if (+x.rir <= 0) failed++; }
    }));
    const last = index.sessions.filter(s => !s.planned).slice(-1)[0];
    const drops = [];
    if (last && last.date >= addDays(index.today, -3)) last.exercises.forEach(x => {
      const f = C.fatigueIndex(x.sets, { rir: x.rir });
      if (f.applicable && f.rawDropoff > R.dropoffHigh) {
        const reps = x.sets.map(s => +s.reps);
        drops.push({ id: x.id, name: x.name, from: reps[0], to: reps[reps.length - 1], dropoff: f.rawDropoff });
      }
    });
    drops.sort((a, b) => b.dropoff - a.dropoff || (a.id < b.id ? -1 : 1));
    const regressing = Object.keys(state.lifts).map(id => state.lifts[id])
      .filter(l => l.verdict === 'regressing' && l.daysSince != null && l.daysSince <= 14)
      .sort((a, b) => a.id < b.id ? -1 : 1);
    return { rated: rated, failed: failed, failureShare: rated ? failed / rated : null,
             failureHigh: rated >= R.failureMinRated && failed / rated >= R.failureShareHigh,
             drops: drops, dropoffHigh: drops.length >= R.dropoffHighCount,
             regressing: regressing, lastDate: last ? last.date : null };
  }
  function topPriority(state, cfg) {
    let best = null, bestScore = -1;
    cfg.priorities.forEach(p => {
      const m = state.muscles[p.muscle];
      const score = p.weight * (m.target.aim > 0 ? m.deficit / m.target.aim : 0);
      if (score > bestScore) { bestScore = score; best = m; }
    });
    return best;
  }
  const DAY_NAME = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function readiness(index, state, config, input, model) {
    const cfg = resolveConfig(config);
    const R = cfg.readiness;
    const inp = input || {};
    const sig = fatigueSignals(index, state, cfg);
    const reasons = [];
    const add = (code, answer, data) => reasons.push({ code: code, answer: answer, data: data || {} });
    const wouldBe = state.consecutive + 1;
    const lowIntake = !!(inp.intake && inp.intake.kcal > 0 && inp.intake.floor > 0 && inp.intake.kcal < inp.intake.floor * R.lowIntakeRatio);
    const feelLow = inp.feel === 'low';
    const nSignals = [sig.failureHigh, sig.dropoffHigh, sig.regressing.length >= R.regressingCount, lowIntake].filter(Boolean).length;

    // A weekday he does not train on is never a session, whatever restMode says.
    const dayOff = cfg.availableWeekdays.indexOf(weekday(index.today)) < 0;
    if (dayOff) add('NOT_A_TRAINING_DAY', 'rest', { weekday: weekday(index.today) });

    // Rest rules
    if (state.consecutive >= cfg.maxConsecutiveDays) add('CONSECUTIVE_LIMIT', 'rest', { inARow: wouldBe, max: cfg.maxConsecutiveDays });
    if (feelLow && nSignals >= 2) add('LOW_FEEL_AND_FATIGUE', 'rest', { signals: nSignals });
    if (sig.regressing.length >= R.restRegressingCount && sig.dropoffHigh) add('REGRESSING_AND_DROPOFF', 'rest', { regressing: sig.regressing.length, drops: sig.drops.length });

    // Swap rules
    const top = topPriority(state, cfg);
    const inWindow = (inp.planned || []).filter(id => {
      const l = state.lifts[id]; if (!l || l.daysSince == null) return false;
      return l.daysSince < effectiveWindow(model, cfg, id, l.info.primary).earliest;
    });
    if (inWindow.length) add('PLANNED_IN_WINDOW', 'swap', { lifts: inWindow.map(id => ({ id: id, name: state.lifts[id].name, daysSince: state.lifts[id].daysSince })) });
    if (top && top.daysSince != null && top.daysSince < top.minGap)
      add('PRIORITY_NOT_RECOVERED', 'swap', { muscle: top.muscle, daysSince: top.daysSince, minGap: top.minGap });

    // Pull-back rules
    if (wouldBe === cfg.maxConsecutiveDays && cfg.maxConsecutiveDays > 1) add('SECOND_DAY_IN_A_ROW', 'pull_back', { inARow: wouldBe });
    if (sig.failureHigh) add('FAILURE_SHARE_HIGH', 'pull_back', { failed: sig.failed, rated: sig.rated });
    if (sig.dropoffHigh) add('REP_DROPOFF', 'pull_back', { lifts: sig.drops.slice(0, 3) });
    if (sig.regressing.length >= R.regressingCount) add('LIFTS_REGRESSING', 'pull_back', { lifts: sig.regressing.map(l => ({ id: l.id, name: l.name })) });
    if (feelLow) add('FEEL_LOW', 'pull_back', {});
    if (lowIntake) add('LOW_INTAKE_YESTERDAY', 'pull_back', { kcal: Math.round(inp.intake.kcal), floor: Math.round(inp.intake.floor) });

    const has = a => reasons.some(r => r.answer === a);
    let answer = has('rest') ? 'rest' : has('swap') ? 'swap' : has('pull_back') ? 'pull_back' : 'train';
    let lighter = false;
    if (answer === 'rest' && cfg.restMode === 'lighter' && !dayOff) {
      answer = 'pull_back'; lighter = true;
      add('LIGHTER_INSTEAD_OF_REST', 'pull_back', {});
    }
    if (answer === 'train') add('CLEAR', 'train', {});
    // Modifiers the session generator applies. Pull-back signals tighten effort even when the
    // headline answer is swap, because both can be true at once.
    const pullBack = has('pull_back') || lighter;
    const avoid = {};
    sig.regressing.forEach(l => { avoid[l.id] = 'REGRESSING'; });
    if (pullBack) sig.drops.forEach(d => { avoid[d.id] = avoid[d.id] || 'DROPOFF'; });
    inWindow.forEach(id => { avoid[id] = 'IN_WINDOW'; });
    const modifiers = { rirExtra: pullBack ? cfg.pullBackRirExtra + (lighter ? 1 : 0) : 0,
                        lighter: lighter, setsDelta: lighter ? -1 : 0, avoid: avoid };

    // Facts, most relevant first. The card shows four; the rest are there for the full view.
    const facts = [];
    const fact = (code, value, label) => { if (!facts.some(f => f.code === code)) facts.push({ code: code, value: value, label: label }); };
    const legDays = Math.min.apply(null, LEG_MUSCLES.map(g => state.muscles[g].daysSince == null ? 999 : state.muscles[g].daysSince));
    reasons.forEach(r => {
      if (r.code === 'CONSECUTIVE_LIMIT' || r.code === 'SECOND_DAY_IN_A_ROW') fact('IN_A_ROW', wouldBe, `would be day ${wouldBe} in a row`);
      if (r.code === 'REP_DROPOFF' || r.code === 'REGRESSING_AND_DROPOFF') { const d = sig.drops[0]; if (d) fact('WORST_DROPOFF', d, `${d.from} → ${d.to} reps, ${d.name}`); }
      if (r.code === 'FAILURE_SHARE_HIGH') fact('TO_FAILURE', { failed: sig.failed, rated: sig.rated }, `${sig.failed} of ${sig.rated} lifts to failure`);
      if (r.code === 'PRIORITY_NOT_RECOVERED') fact('DAYS_SINCE_PRIORITY', top.daysSince, `${plural(top.daysSince, 'day')} since ${LABEL[top.muscle].toLowerCase()}`);
      if (r.code === 'PLANNED_IN_WINDOW') { const l = r.data.lifts[0]; fact('DAYS_SINCE_PLANNED_LIFT', l.daysSince, `${plural(l.daysSince, 'day')} since ${l.name}`); }
      if (r.code === 'LIFTS_REGRESSING' || r.code === 'REGRESSING_AND_DROPOFF') fact('REGRESSING', sig.regressing.length, `${plural(sig.regressing.length, 'lift')} regressing`);
      if (r.code === 'LOW_INTAKE_YESTERDAY') fact('LOW_INTAKE', r.data, `ate ${r.data.kcal} kcal yesterday, floor ${r.data.floor}`);
      if (r.code === 'FEEL_LOW') fact('FEEL', 'low', 'you said you feel low');
    });
    if (state.daysSinceLast != null) fact('DAYS_SINCE_LAST', state.daysSinceLast, `${plural(state.daysSinceLast, 'day')} since last session`);
    if (top && top.daysSince != null) fact('DAYS_SINCE_PRIORITY', top.daysSince, `${plural(top.daysSince, 'day')} since ${LABEL[top.muscle].toLowerCase()}`);
    fact('DAYS_SINCE_LEGS', legDays === 999 ? null : legDays, legDays === 999 ? 'no leg work logged' : `${plural(legDays, 'day')} since legs`);
    if (sig.rated) fact('TO_FAILURE', { failed: sig.failed, rated: sig.rated }, `${sig.failed} of ${sig.rated} lifts to failure`);
    fact('IN_A_ROW', wouldBe, wouldBe === 1 ? 'first day after a rest day' : `would be day ${wouldBe} in a row`);

    const first = reasons.filter(r => r.answer === answer || (lighter && r.answer === 'rest'))[0] || reasons[0];
    return { date: index.today, answer: answer, lighter: lighter,
             headline: dayOff ? 'Not a training day' : { train: 'Train as planned', pull_back: lighter ? 'Lighter session today' : 'Train, but pull back', swap: 'Swap today’s focus', rest: 'Rest today' }[answer],
             sentence: readinessSentence(answer, first, reasons, state, sig, cfg, lighter),
             reasons: reasons, facts: facts, modifiers: modifiers,
             signals: { consecutive: state.consecutive, daysSinceLast: state.daysSinceLast,
                        failureShare: sig.failureShare == null ? null : r1(sig.failureShare * 100) / 100,
                        failed: sig.failed, rated: sig.rated, dropoffs: sig.drops,
                        regressing: sig.regressing.map(l => l.id), feel: inp.feel || null, lowIntake: lowIntake,
                        topPriority: top ? top.muscle : null } };
  }
  function readinessSentence(answer, r, reasons, state, sig, cfg, lighter) {
    const capC = cfg.rirCap.compound + cfg.pullBackRirExtra;
    const code = r && r.code;
    if (answer === 'rest') {
      if (code === 'NOT_A_TRAINING_DAY') return `${DAY_NAME[r.data.weekday]} is not one of your training days.`;
      if (code === 'CONSECUTIVE_LIMIT') return `This would be day ${r.data.inARow} in a row. Take today off.`;
      if (code === 'LOW_FEEL_AND_FATIGUE') return 'You feel low and your last sessions show fatigue. Take today off.';
      return `${plural(sig.regressing.length, 'lift')} regressing and reps fell off set to set. Take today off.`;
    }
    if (lighter) return 'A rest day is due. Do a short session: fewer sets, further from failure.';
    if (answer === 'swap') {
      if (code === 'PLANNED_IN_WINDOW') { const l = r.data.lifts[0]; return `${l.name} was done ${plural(l.daysSince, 'day')} ago. Train something else today.`; }
      return `${LABEL[r.data.muscle]} was trained ${plural(r.data.daysSince, 'day')} ago. Train other muscles today.`;
    }
    if (answer === 'pull_back') {
      const why = {
        SECOND_DAY_IN_A_ROW: 'Second day in a row.',
        FAILURE_SHARE_HIGH: `${sig.failed} of your last ${sig.rated} lifts went to failure.`,
        REP_DROPOFF: sig.drops[0] ? `${sig.drops[0].name} fell from ${sig.drops[0].from} to ${sig.drops[0].to} reps.` : 'Reps fell off set to set.',
        LIFTS_REGRESSING: `${plural(sig.regressing.length, 'lift')} regressing.`,
        FEEL_LOW: 'You feel low.',
        LOW_INTAKE_YESTERDAY: 'You ate well under your floor yesterday.'
      }[code] || '';
      return `${why} Stop compounds with ${capC} reps left.`.trim();
    }
    return state.daysSinceLast == null ? 'No history yet. Train and log it.' : `${plural(state.daysSinceLast, 'day')} since your last session and no fatigue signals.`;
  }

  // =====================================================================================
  // 7. Session generator
  // =====================================================================================
  // How a lift scores as the pick for a muscle. Higher is better; ties break on id so the
  // output never depends on object key order.
  function liftScore(l, win, cfg) {
    const reasons = [];
    let s = 0;
    // Familiarity: staples beat lifts done once or twice. A never-logged lift is a last resort.
    const fam = l.recent >= 4 ? 3 : l.recent >= 2 ? 2 : l.recent === 1 ? 1 : l.sessions > 0 ? 0.5 : -2;
    s += fam;
    if (l.recent >= 4) reasons.push('STAPLE'); else if (l.sessions === 0) reasons.push('NEVER_LOGGED');
    const tv = { progressing: 2, thin: 0, 'effort-drift': 0, grinding: -0.5, stalled: -1, regressing: -1.5 }[l.verdict] || 0;
    s += tv;
    reasons.push(l.verdict.toUpperCase().replace('-', '_'));
    if (l.stalled) { s -= 3; reasons.push('STALLED_ROTATE'); }
    if (l.daysSince != null) {
      if (l.daysSince > win.idealMax) { s += 1.5; reasons.push('OVERDUE'); }
      else if (l.daysSince >= win.idealMin) { s += 1; reasons.push('IN_IDEAL_WINDOW'); }
    }
    return { score: s, reasons: reasons };
  }
  function candidatesFor(g, state, index, cfg, model, opts) {
    const o = opts || {};
    const ids = Object.keys(state.lifts).sort();
    let pool = ids.filter(id => state.lifts[id].info.primary === g);
    if (!pool.length) pool = ids.filter(id => (state.lifts[id].info.muscles[g] || 0) >= 0.7);
    const eq = index.equipment, anyEq = Object.keys(eq).length > 0;
    // A lift done fewer than 3 times and not in the recent window is "rarely done". When the
    // muscle has any familiar lift at all, rarely done lifts are not offered: waiting a day
    // for a staple beats a lift with no history to progress from.
    const familiar = l => l.sessions >= 3 || l.recent >= 1;
    const anyFamiliar = pool.some(id => familiar(state.lifts[id]));
    return pool.map(id => {
      const l = state.lifts[id];
      const win = effectiveWindow(model, cfg, id, l.info.primary);
      const sc = liftScore(l, win, cfg);
      let blocked = null;
      if (l.daysSince != null && l.daysSince < win.earliest) blocked = 'IN_WINDOW';
      else if (anyEq && !eq[l.info.equipment] && l.sessions === 0) blocked = 'EQUIPMENT_UNKNOWN';
      else if (anyFamiliar && !familiar(l)) blocked = 'RARELY_DONE';
      else if (o.avoid && o.avoid[id]) blocked = o.avoid[id];
      else if (o.chosen && o.chosen[id]) blocked = 'ALREADY_TODAY';
      return { id: id, lift: l, win: win, score: sc.score, reasons: sc.reasons, blocked: blocked };
    });
  }
  function pickLift(g, state, index, cfg, model, opts) {
    const o = opts || {};
    const cands = candidatesFor(g, state, index, cfg, model, o).filter(c => !c.blocked);
    cands.forEach(c => {
      if (o.preferCompound && c.lift.info.pattern === 'compound') c.score += 1;
      if (o.preferIsolation && c.lift.info.pattern === 'isolation') c.score += 0.5;
      if (o.avoidMovement && o.avoidMovement.indexOf(c.lift.info.movement) >= 0) c.score -= 2;
    });
    cands.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return cands[0] || null;
  }

  // Double progression from the last real session: same load for more reps until the top
  // of the range, then more load and back to the bottom. Reps are converted to the new RIR
  // cap: reps you can do stopping `cap` short ≈ last reps + last RIR - cap.
  function prescribe(l, cfg, rirCap, sets, isLegBlock) {
    const info = l.info;
    const range = isLegBlock ? cfg.repRange.legs : cfg.repRange[info.pattern === 'compound' ? 'compound' : 'isolation'];
    const lo = range[0], hi = range[1];
    const step = cfg.loadStep[info.equipment] != null ? cfg.loadStep[info.equipment] : cfg.loadStep.other;
    const base = { sets: sets, rirCap: rirCap, repLow: lo, repHigh: hi };
    if (!l.lastTop) return Object.assign(base, { kg: null, bw: false, reps: lo, rule: 'NEW', text: `find a load for ${lo} reps, stop ${rirCap} short` });
    const top = l.lastTop;
    const atTop = l.lastSets.filter(s => (+s.kg || 0) === top.kg && !!s.bw === top.bw).map(s => +s.reps);
    const minAtTop = atTop.length ? Math.min.apply(null, atTop) : top.reps;
    const firstAtTop = atTop.length ? atTop[0] : top.reps;
    const lastRir = l.lastRir != null ? l.lastRir : 0;
    const repsAtCap = firstAtTop + lastRir - rirCap;
    let kg = top.kg, reps, rule;
    if (minAtTop >= hi && lastRir >= Math.min(rirCap, 1) - 1 && step > 0) { kg = top.kg + step; reps = lo; rule = 'ADD_LOAD'; }
    else if (repsAtCap < lo && step > 0 && top.kg - step > 0) { kg = top.kg - step; reps = lo; rule = 'LIGHTEN'; }
    else {
      // Moving to a higher RIR than last time is the progression this week; otherwise +1 rep.
      reps = clamp(rirCap > lastRir ? repsAtCap : repsAtCap + 1, lo, hi);
      rule = reps > firstAtTop ? 'ADD_REPS' : 'HOLD';
    }
    kg = Math.round(kg * 100) / 100;
    const load = top.bw ? (kg > 0 ? `bw+${kg}kg` : 'bw') : `${kg}kg`;
    return Object.assign(base, { kg: kg, bw: top.bw, reps: reps, rule: rule,
      last: { kg: top.kg, reps: atTop.length ? atTop : [top.reps], rir: l.lastRir, date: top.date },
      text: `${sets} × ${reps} at ${load}, stop ${rirCap} short` });
  }
  function itemMinutes(it, cfg) {
    const T = cfg.timing;
    const rest = T.restSec[it.pattern === 'compound' ? 'compound' : 'isolation'];
    return (it.sets * (T.workSec + rest) + T.changeoverSec) / 60;
  }
  function liftReasonText(l, g, deficit) {
    const bits = [];
    if (deficit != null) bits.push(`${LABEL[g].toLowerCase()} is ${r1(deficit)} sets behind`);
    bits.push(l.daysSince == null ? 'not logged before' : `last done ${plural(l.daysSince, 'day')} ago`);
    if (l.verdict !== 'thin') bits.push(l.stalled ? `no new best in ${l.daysSinceBest} days` : l.verdict);
    return bits.join(', ');
  }

  // ctx: { index, state, readiness, config, model }
  function generateSession(ctx) {
    const cfg = resolveConfig(ctx.config);
    const state = ctx.state, index = ctx.index, model = ctx.model;
    const rd = ctx.readiness || { answer: 'train', modifiers: { rirExtra: 0, setsDelta: 0, avoid: {}, lighter: false } };
    const mod = rd.modifiers || { rirExtra: 0, setsDelta: 0, avoid: {} };
    if (rd.answer === 'rest') return { date: index.today, rest: true, items: [], minutes: 0, dropped: [],
                                       reasons: [{ code: 'READINESS_REST' }], muscles: {} };
    const lighter = !!mod.lighter;
    const credit = {}, sessionCredit = {};
    MUSCLES.forEach(g => { credit[g] = state.muscles[g].done; sessionCredit[g] = 0; });
    const items = [], chosen = {};
    const movementsFor = {};
    const deficitNow = g => Math.max(0, state.muscles[g].target.aim - credit[g]);
    const recovered = g => state.muscles[g].daysSince == null || state.muscles[g].daysSince >= state.muscles[g].minGap;
    const addItem = (pick, g, sets, block, why) => {
      const l = pick.lift;
      const isLeg = block === 'legs';
      const capBase = isLeg ? cfg.rirCap.legs : l.info.pattern === 'compound' ? cfg.rirCap.compound : cfg.rirCap.isolation;
      const rirCap = Math.min(5, capBase + (mod.rirExtra || 0));
      const s = Math.max(cfg.setsPerLift.min, sets + (mod.setsDelta || 0));
      const rx = prescribe(l, cfg, rirCap, s, isLeg);
      const item = { id: l.id, name: l.name, muscle: g, block: block || null, pattern: l.info.pattern,
                     movement: l.info.movement, equipment: l.info.equipment, sets: s,
                     prescription: rx, value: why.value,
                     reasons: [{ code: why.code, muscle: g, deficit: why.deficit }].concat(pick.reasons.map(c => ({ code: c }))),
                     reasonText: liftReasonText(l, g, why.deficit), window: pick.win };
      items.push(item);
      chosen[l.id] = true;
      (movementsFor[g] = movementsFor[g] || []).push(l.info.movement);
      Object.keys(l.info.muscles).forEach(m => { credit[m] = (credit[m] || 0) + s * l.info.muscles[m]; sessionCredit[m] = (sessionCredit[m] || 0) + s * l.info.muscles[m]; });
      return item;
    };

    // (a) Leg block first, when a leg muscle is under its floor, recovered, and the last leg
    // work was at least legBlockGapDays ago. Each block aims at half the weekly floor, so two
    // blocks a week cover it. Quads get a compound; hamstrings then get an isolation, so the
    // block is never two heavy hinge/squat patterns back to back.
    const legDays = Math.min.apply(null, LEG_MUSCLES.map(g => state.muscles[g].daysSince == null ? 999 : state.muscles[g].daysSince));
    if (!lighter && legDays >= cfg.legBlockGapDays) {
      LEG_MUSCLES.forEach(g => {
        const m = state.muscles[g];
        if (!(m.target.aim > 0) || deficitNow(g) < 1 || !recovered(g)) return;
        const afterCompound = items.some(it => it.block === 'legs' && it.pattern === 'compound');
        const pick = pickLift(g, state, index, cfg, model, { chosen: chosen, avoid: mod.avoid,
          preferCompound: !afterCompound, preferIsolation: afterCompound });
        if (!pick) return;
        const lb = cfg.setsPerLift.legBlock;
        const inv = pick.lift.info.muscles[g] || 1;
        const sets = clamp(Math.ceil(Math.min(deficitNow(g), m.target.aim / 2) / inv), lb[0], lb[1]);
        addItem(pick, g, sets, 'legs', { code: 'LEGS_BELOW_FLOOR', deficit: deficitNow(g), value: m.weight * (deficitNow(g) / m.target.aim) + 0.5 });
      });
    }

    // (b) Upper-body muscles by value: priority weight x share of weekly aim still missing x
    // recovery, times the quality of the best lift available for it today. A muscle whose
    // staples are all inside their window and whose best option is a rarely done lift is
    // worth less today than another muscle with a staple ready.
    const maxLifts = lighter ? Math.min(4, cfg.maxLiftsPerSession) : cfg.maxLiftsPerSession;
    const quality = p => p.lift.recent >= 2 ? 1 : p.lift.sessions >= 3 ? 0.8 : 0.5;
    const fill = (ceilingOf, code) => {
      for (let guard = 0; guard < 30 && items.length < maxLifts; guard++) {
        const need = g => Math.max(0, ceilingOf(g) - credit[g]);
        const options = MUSCLES.filter(g => LEG_MUSCLES.indexOf(g) < 0 && state.muscles[g].target.aim > 0 && recovered(g))
          .filter(g => need(g) >= 1.5 && sessionCredit[g] < cfg.perSessionMuscleCap - 1)
          .filter(g => !(lighter && state.muscles[g].kind !== 'priority'))
          .map(g => {
            const m = state.muscles[g], nth = (movementsFor[g] || []).length;
            const pick = pickLift(g, state, index, cfg, model, { chosen: chosen, avoid: mod.avoid,
              preferCompound: nth === 0 && m.kind === 'priority', preferIsolation: nth > 0, avoidMovement: movementsFor[g] || [] });
            const rec = m.daysSince == null ? 1 : Math.min(1, m.daysSince / (m.minGap + 1));
            const v = pick ? m.weight * (need(g) / m.target.aim) * rec * quality(pick) : 0;
            return { g: g, m: m, nth: nth, pick: pick, v: v };
          })
          // Maintenance never justifies a lift he has barely done: indirect work covers it.
          .filter(x => x.pick && x.v > 0 && !(x.m.kind !== 'priority' && x.pick.lift.sessions < 3 && x.pick.lift.recent < 1))
          .sort((a, b) => b.v - a.v || (MUSCLES.indexOf(a.g) - MUSCLES.indexOf(b.g)));
        if (!options.length) break;
        const { g, m, nth, pick, v } = options[0];
        const perSession = m.kind === 'priority' ? Math.ceil(m.target.aim / 2) : m.target.aim;
        const want = Math.min(cfg.perSessionMuscleCap - sessionCredit[g], need(g), perSession);
        const inv = pick.lift.info.muscles[g] || 1;
        let sets = Math.round(want / inv);
        // A priority muscle wanting 5+ sets gets two lifts: split it rather than 6 sets of one.
        if (m.kind === 'priority' && nth === 0 && sets >= 5) sets = Math.ceil(sets / 2);
        sets = clamp(sets, cfg.setsPerLift.min, cfg.setsPerLift.max);
        addItem(pick, g, sets, null, { code: code || (m.kind === 'priority' ? 'PRIORITY_DEFICIT' : 'MAINTENANCE_DEFICIT'), deficit: need(g), value: v });
      }
    };
    fill(g => state.muscles[g].target.aim);
    // (b2) A short day: if the session is under 60% of the time budget, priority muscles that
    // are recovered may be filled past their aim by up to two volume steps (never past max).
    const minutesNow = () => cfg.timing.warmupMin + items.reduce((s, it) => s + itemMinutes(it, cfg), 0);
    if (!lighter && minutesNow() < 0.6 * cfg.sessionMinutes)
      fill(g => state.muscles[g].kind === 'priority' ? Math.min(state.muscles[g].target.max, state.muscles[g].target.aim + 2 * cfg.volumeStep) : state.muscles[g].target.aim, 'PRIORITY_TOP_UP');
    // (b3) Still short (the priority muscles were trained yesterday, say): recovered
    // maintenance muscles may go up to two volume steps past their floor (never past max),
    // with lifts he already knows. A short day then trains what is ready instead of ending.
    if (!lighter && minutesNow() < 0.6 * cfg.sessionMinutes)
      fill(g => state.muscles[g].kind === 'maintenance' ? Math.min(state.muscles[g].target.max, state.muscles[g].target.aim + 2 * cfg.volumeStep) : 0, 'SHORT_DAY_TOP_UP');

    // (c) Order: leg block, then compounds, then isolations; inside each, by value.
    const rank = it => it.block === 'legs' ? 0 : it.pattern === 'compound' ? 1 : 2;
    items.sort((a, b) => rank(a) - rank(b) || b.value - a.value || (a.id < b.id ? -1 : 1));

    // (d) Time budget: drop the lowest-value item until the estimate fits.
    const dropped = [];
    const total = () => cfg.timing.warmupMin + items.reduce((s, it) => s + itemMinutes(it, cfg), 0);
    while (items.length > 1 && total() > cfg.sessionMinutes) {
      let worst = 0;
      items.forEach((it, i) => { if (it.value < items[worst].value || (it.value === items[worst].value && it.id > items[worst].id)) worst = i; });
      const it = items.splice(worst, 1)[0];
      dropped.push({ id: it.id, name: it.name, muscle: it.muscle, sets: it.sets, value: it.value, code: 'TIME_BUDGET' });
    }
    items.forEach(it => { it.minutes = r1(itemMinutes(it, cfg)); });
    // Nearly nothing left to do: the week's aims are already met for every recovered muscle.
    const notes = [];
    if (!lighter && (items.length < 3 || total() < 0.4 * cfg.sessionMinutes)) notes.push({ code: 'AHEAD_OF_WEEK', text: 'The week’s aims are mostly met already; a rest day costs nothing.' });
    const muscles = {};
    items.forEach(it => Object.keys(state.lifts[it.id].info.muscles).forEach(g => {
      muscles[g] = r1((muscles[g] || 0) + it.sets * state.lifts[it.id].info.muscles[g]);
    }));
    return { date: index.today, rest: false, lighter: lighter, items: items, minutes: Math.round(total()),
             budget: cfg.sessionMinutes, dropped: dropped, muscles: muscles, notes: notes,
             legBlock: items.some(it => it.block === 'legs') };
  }

  // Plan changes the card lists: compare a planned list (calendar) with the generated one.
  function planChanges(plannedIds, session, readinessOut) {
    const gen = (session.items || []).map(i => i.id);
    const out = [];
    (plannedIds || []).forEach(id => { if (gen.indexOf(id) < 0) out.push({ kind: 'skip', id: id, why: (readinessOut && readinessOut.modifiers.avoid[id]) || 'NOT_SELECTED' }); });
    (session.items || []).forEach(it => { if ((plannedIds || []).indexOf(it.id) < 0) out.push({ kind: 'add', id: it.id, name: it.name, text: it.prescription.text, block: it.block }); });
    if (readinessOut && readinessOut.modifiers.rirExtra > 0) out.push({ kind: 'cap', text: 'compounds at ' + (session.items.filter(i => i.pattern === 'compound')[0] || { prescription: { rirCap: '?' } }).prescription.rirCap + ' reps in reserve' });
    return out;
  }

  // One call for "today": index, state, readiness, session.
  function planToday(input) {
    const cfg = resolveConfig(input.config);
    const sessions = input.sessions || normalizeSessions(input.workouts);
    const index = buildIndex(sessions, input.catalogue, input.today, { weights: input.weights });
    const model = input.model || recoveryModel(index, cfg);
    const state = weekState(index, cfg, model);
    const rd = readiness(index, state, cfg, input.readinessInput, model);
    const session = generateSession({ index: index, state: state, readiness: rd, config: cfg, model: model });
    return { index: index, model: model, state: state, readiness: rd, session: session,
             changes: input.readinessInput && input.readinessInput.planned ? planChanges(input.readinessInput.planned, session, rd) : [] };
  }

  // =====================================================================================
  // 8. Week planner
  // The plan is the session generator run forward over a simulated history: each planned
  // session is added to the history before the next day is planned, so volume, recovery
  // windows and leg floors carry from day to day. It is recomputed from what actually
  // happened every time it is asked, so a missed or extra day re-plans by itself.
  // =====================================================================================
  // All feasible day patterns for n sessions in the next 7 days, cheapest spacing first.
  // Feasible = never more than maxRun days in a row, counting the run already going into today.
  // Spacing cost = squared deviation of each gap from the even spacing 7/n (the first gap
  // counted from the last real session), plus a charge for each back-to-back pair.
  function chooseTrainingDays(n, consecutiveBefore, daysSinceLast, maxRun, todayAllowed, allowedMask) {
    const allowed = allowedMask == null ? 127 : allowedMask;
    const out = [];
    for (let mask = 0; mask < 128; mask++) {
      let bits = 0; for (let i = 0; i < 7; i++) if (mask >> i & 1) bits++;
      if (bits !== n) continue;
      if (!todayAllowed && (mask & 1)) continue;
      if (mask & ~allowed) continue;                 // a day he does not train on
      let run = consecutiveBefore, ok = true, pairs = 0;
      for (let i = 0; i < 7; i++) {
        if (mask >> i & 1) { run++; if (run > maxRun) { ok = false; break; } if (run >= 2) pairs++; } else run = 0;
      }
      if (!ok) continue;
      const days = []; for (let i = 0; i < 7; i++) if (mask >> i & 1) days.push(i);
      const ideal = 7 / n;
      let prev = daysSinceLast == null ? days[0] - ideal : -daysSinceLast, cost = 0;
      days.forEach(d => { cost += Math.pow(d - prev - ideal, 2); prev = d; });
      cost += 0.5 * pairs + 0.01 * days[0];
      out.push({ mask: mask, cost: cost, days: days });
    }
    return out.sort((a, b) => a.cost - b.cost || a.mask - b.mask);
  }

  // input: { sessions|workouts, catalogue, weights, today, config, daysPerWeek, readinessInput, model }
  function planWeek(input) {
    const cfg = resolveConfig(input.config);
    const real = input.sessions || normalizeSessions(input.workouts);
    const today = input.today;
    const index0 = buildIndex(real, input.catalogue, today, { weights: input.weights });
    const model = input.model || recoveryModel(index0, cfg);
    const state0 = weekState(index0, cfg, model);
    const rd0 = readiness(index0, state0, cfg, input.readinessInput, model);
    const warnings = [];
    let n = clamp(input.daysPerWeek || cfg.daysPerWeek.preferred, cfg.daysPerWeek.min, cfg.daysPerWeek.max);
    if (input.daysPerWeek && input.daysPerWeek !== n) warnings.push({ code: 'DAYS_CLAMPED', asked: input.daysPerWeek, used: n });
    const todayAllowed = rd0.answer !== 'rest';
    let allowedMask = 0;
    for (let i = 0; i < 7; i++) if (cfg.availableWeekdays.indexOf(weekday(addDays(today, i))) >= 0) allowedMask |= 1 << i;
    let options = [];
    for (let k = n; k >= 1 && !options.length; k--) {
      options = chooseTrainingDays(k, state0.consecutive, state0.daysSinceLast, cfg.maxConsecutiveDays, todayAllowed, allowedMask);
      if (options.length && k < n) warnings.push({ code: 'DAYS_REDUCED', asked: n, used: k, why: `${n} days do not fit your training days without more than ${cfg.maxConsecutiveDays} in a row` });
    }
    // The owner can fix the days himself (offsets from today, 0..6); the rest still applies.
    if (Array.isArray(input.trainDays)) {
      const m = input.trainDays.reduce((a, i) => i >= 0 && i < 7 ? a | (1 << i) : a, 0);
      options = [{ mask: m, cost: 0, days: input.trainDays.slice().sort() }];
    }
    // Simulate the best-spaced patterns and keep the one that covers the weekly aims best:
    // a day pattern that leaves a priority muscle with one session is worse than one that
    // spaces the same lifts so each gets its window.
    const simulate = mask => {
      const sim = real.filter(s => s.date < today).slice();
      const days = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(today, i);
        if (!(mask >> i & 1)) { days.push({ date: date, weekday: weekday(date), train: false, session: null }); continue; }
        const index = buildIndex(sim, input.catalogue, date, { weights: input.weights });
        const state = weekState(index, cfg, model);
        const rd = i === 0 ? rd0 : readiness(index, state, cfg, {}, model);
        const session = generateSession({ index: index, state: state, readiness: rd.answer === 'rest' ? Object.assign({}, rd, { answer: 'pull_back' }) : rd, config: cfg, model: model });
        days.push({ date: date, weekday: weekday(date), train: true, readiness: { answer: rd.answer, codes: rd.reasons.map(r => r.code) }, session: session });
        sim.push({ date: date, planned: true, deload: false, exercises: session.items.map(it => ({
          id: it.id, name: it.name, rir: it.prescription.rirCap,
          sets: Array.from({ length: it.sets }, () => ({ kg: it.prescription.kg || 0, reps: it.prescription.reps, bw: !!it.prescription.bw }))
        })) });
      }
      const planned = {}, hits = {}, liftsBy = {};
      days.filter(d => d.train).forEach(d => d.session.items.forEach(it => {
        const info = index0.info[it.id];
        Object.keys(info.muscles).forEach(g => { planned[g] = (planned[g] || 0) + it.sets * info.muscles[g]; });
        (hits[it.muscle] = hits[it.muscle] || {})[d.date] = 1;
        (liftsBy[it.muscle] = liftsBy[it.muscle] || {})[it.id] = 1;
      }));
      const summary = {};
      let score = 0;
      MUSCLES.forEach(g => {
        const m0 = state0.muscles[g], t = m0.target;
        if (!(t.aim > 0) && !planned[g]) return;
        const x = { planned: r1(planned[g] || 0), aim: t.aim, min: t.min, kind: m0.kind,
                    days: Object.keys(hits[g] || {}).length, lifts: Object.keys(liftsBy[g] || {}).length };
        summary[g] = x;
        if (t.aim > 0) score += m0.weight * Math.min(1, x.planned / t.aim);
        if (m0.kind === 'priority') score += m0.weight * (x.days >= 2 && x.lifts >= 2 ? 1 : 0);
      });
      return { days: days, summary: summary, score: score };
    };
    let best = null;
    options.slice(0, 12).forEach(opt => {
      const r = simulate(opt.mask);
      const total = r.score - 0.3 * opt.cost;
      if (!best || total > best.total + 1e-9) best = { total: total, opt: opt, r: r };
    });
    const days = best ? best.r.days : [], summary = best ? best.r.summary : {};
    const pick = best ? best.opt : null;
    return { from: today, daysPerWeek: pick ? pick.days.length : 0, days: days, summary: summary,
             coverageScore: best ? r1(best.r.score * 100) / 100 : null, spacingCost: pick ? r1(pick.cost * 100) / 100 : null,
             legBlocks: days.filter(d => d.train && d.session.legBlock).length,
             readinessToday: rd0, warnings: warnings, model: model };
  }

  // =====================================================================================
  // 9. Alternatives: the next best lifts for the same muscle, same movement family first.
  // =====================================================================================
  function alternatives(liftId, ctx, n) {
    const cfg = resolveConfig(ctx.config);
    const state = ctx.state, l = state.lifts[liftId];
    if (!l || !l.info.primary) return [];
    const cands = candidatesFor(l.info.primary, state, ctx.index, cfg, ctx.model, { avoid: (ctx.readiness && ctx.readiness.modifiers.avoid) || {} })
      .filter(c => c.id !== liftId);
    cands.forEach(c => {
      c.sameFamily = c.lift.info.family === l.info.family;
      c.sameMovement = c.lift.info.movement === l.info.movement;
      c.rank = c.score + (c.sameFamily ? 3 : 0) + (c.sameMovement ? 1 : 0) - (c.blocked ? 100 : 0);
    });
    cands.sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1));
    return cands.slice(0, n || 3).map(c => ({ id: c.id, name: c.lift.name, movement: c.lift.info.movement,
      sameMovement: c.sameMovement, sameFamily: c.sameFamily, available: !c.blocked, blocked: c.blocked,
      verdict: c.lift.verdict, daysSince: c.lift.daysSince, score: r1(c.rank), reasons: c.reasons }));
  }

  // =====================================================================================
  // 10. Volume adjustment between weeks
  // Per muscle, look at its primary lifts over the last `days` (default 21):
  //   REMOVE (-volumeStep) when 2+ of them are regressing, or half or more of their recent
  //          sessions (at least 3) lost reps set to set (fatigueIndex 'high');
  //   ADD    (+volumeStep) when at least one is progressing, none regressing, drop-off is rare
  //          (under a quarter of sessions) and last week's sets actually reached the aim;
  //   HOLD   otherwise. Always inside the muscle's [min, max] band.
  // =====================================================================================
  function adjustVolume(index, state, config, opts) {
    const cfg = resolveConfig(config);
    const days = (opts && opts.days) || 21;
    const from = addDays(index.today, -days);
    const out = {}, aims = Object.assign({}, cfg.volumeAims);
    MUSCLES.forEach(g => {
      const m = state.muscles[g];
      if (!(m.target.aim > 0)) return;
      const lifts = Object.keys(state.lifts).map(id => state.lifts[id])
        .filter(l => l.info.primary === g && l.lastDate && l.lastDate >= from);
      let sess = 0, highDrop = 0;
      lifts.forEach(l => (index.byLift[l.id] || []).filter(h => !h.planned && h.date >= from).forEach(h => {
        const f = C.fatigueIndex(h.sets, { rir: h.rir });
        if (!f.applicable) return;
        sess++; if (f.flag === 'high') highDrop++;
      }));
      const reg = lifts.filter(l => l.verdict === 'regressing').length;
      const prog = lifts.filter(l => l.verdict === 'progressing').length;
      const reasons = [];
      let action = 'HOLD', aim = m.target.aim;
      if (reg >= 2) reasons.push({ code: 'LIFTS_REGRESSING', n: reg });
      if (sess >= 3 && highDrop / sess >= 0.5) reasons.push({ code: 'REP_LOSS', sessions: sess, high: highDrop });
      if (reasons.length) { action = 'REMOVE'; aim = Math.max(m.target.min, aim - cfg.volumeStep); }
      else if (prog >= 1 && reg === 0 && (sess === 0 || highDrop / sess < 0.25) && m.done >= m.target.aim) {
        action = 'ADD'; aim = Math.min(m.target.max, aim + cfg.volumeStep);
        reasons.push({ code: 'PROGRESSING_CLEAN', progressing: prog, sessions: sess });
      } else reasons.push({ code: lifts.length ? 'MIXED_OR_THIN' : 'NO_RECENT_LIFTS' });
      if (aim === m.target.aim && action !== 'HOLD') reasons.push({ code: 'AT_BAND_EDGE' });
      out[g] = { muscle: g, action: aim === m.target.aim ? 'HOLD' : action, from: m.target.aim, to: aim,
                 band: [m.target.min, m.target.max], lifts: lifts.length, progressing: prog, regressing: reg,
                 sessions: sess, highDropoff: highDrop, reasons: reasons };
      if (aim !== m.target.aim) aims[g] = aim;
    });
    return { muscles: out, volumeAims: aims };
  }

  // =====================================================================================
  // 11. Calendar name linking
  // Ranked catalogue candidates for a calendar exercise name, so the UI can offer "link to…"
  // and save the choice as an alias. Scores: 100 exact, core.matchExercise's all-words rule
  // (90 minus 5 per spare word), else word overlap (Dice coefficient x 80) with a bonus when
  // the equipment word agrees. Nothing under minScore is offered.
  // =====================================================================================
  function linkCandidates(calendarName, catalogue, opts) {
    const o = opts || {};
    const bare = String(calendarName || '').replace(/\s*[—(].*$/, '').trim() || String(calendarName || '').trim();
    const q = C.normalizeName(bare);
    if (!q) return [];
    const qt = q.split(' ');
    const eqWords = ['barbell', 'dumbbell', 'cable', 'machine', 'smith', 'bodyweight'];
    const out = [];
    (catalogue || []).forEach(ex => {
      if (!ex || !ex.id) return;
      let best = 0, via = null;
      [ex.name].concat(ex.aliases || []).forEach(c => {
        const nc = C.normalizeName(c);
        if (!nc) return;
        const ct = nc.split(' ');
        let sc;
        if (nc === q) sc = 100;
        else if (qt.every(t => ct.indexOf(t) >= 0)) sc = 90 - Math.min(25, (ct.length - qt.length) * 5);
        else {
          const common = qt.filter(t => ct.indexOf(t) >= 0).length;
          sc = Math.round(2 * common / (qt.length + ct.length) * 80);
          const qe = eqWords.filter(w => qt.indexOf(w) >= 0), ce = eqWords.filter(w => ct.indexOf(w) >= 0);
          if (common && qe.length && ce.length) sc += qe.some(w => ce.indexOf(w) >= 0) ? 5 : -10;
        }
        if (sc > best) { best = sc; via = c; }
      });
      if (best >= (o.minScore || 30)) out.push({ id: ex.id, name: ex.name, score: best, via: via,
        rule: best === 100 ? 'exact' : best >= 65 && qt.every(t => C.normalizeName(via).split(' ').indexOf(t) >= 0) ? 'all-words' : 'overlap' });
    });
    out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return out.slice(0, o.limit || 5);
  }

  // The calendar's wording saved as an alias on the chosen catalogue lift, so the next
  // matchExercise finds it. Returns a new catalogue; the input is untouched. Notes after "—"
  // or "(" are dropped, as linkCandidates does. Unknown id or empty name: null.
  function linkAlias(catalogue, id, calendarName) {
    const bare = String(calendarName || '').replace(/\s*[—(].*$/, '').trim() || String(calendarName || '').trim();
    if (!bare || !(catalogue || []).some(c => c && c.id === id)) return null;
    const q = C.normalizeName(bare);
    return catalogue.map(c => {
      if (!c || c.id !== id) return c;
      const aliases = (c.aliases || []).slice();
      if (C.normalizeName(c.name) !== q && !aliases.some(a => C.normalizeName(a) === q)) aliases.push(bare);
      return Object.assign({}, c, { aliases: aliases });
    });
  }

  // =====================================================================================
  // 12. Nudge log
  // A record per day: what was advised, then what was done. Plain data, safe to export.
  // =====================================================================================
  function nudgeRecord(readinessOut, session) {
    return {
      date: readinessOut.date,
      advised: {
        answer: readinessOut.answer, lighter: !!readinessOut.lighter,
        codes: readinessOut.reasons.map(r => r.code),
        lifts: (session && session.items || []).map(it => ({ id: it.id, muscle: it.muscle, sets: it.sets,
                 kg: it.prescription.kg, reps: it.prescription.reps, rirCap: it.prescription.rirCap })),
        muscles: session ? Object.keys(session.muscles || {}).filter(g => session.muscles[g] >= 1).sort() : []
      },
      actual: null   // filled by scoreNudges from the workout log
    };
  }
  // records: nudgeRecord[]; sessions: normalised sessions; returns per-record adherence and
  // a followed-vs-not comparison of PR rate and rep drop-off, each with its sample size.
  function scoreNudges(records, sessions, catalogue, weights) {
    const byDate = {};
    sessions.forEach(s => { byDate[s.date] = s; });
    const index = buildIndex(sessions, catalogue, '9999-12-31', { weights: weights });
    const prByDate = {};
    prEvents(index).forEach(e => { const d = prByDate[e.date] = prByDate[e.date] || { n: 0, pr: 0 }; d.n++; if (e.pr) d.pr++; });
    const rows = (records || []).map(rec => {
      const s = byDate[rec.date];
      const trained = !!s;
      const ids = s ? s.exercises.map(x => x.id) : [];
      const adv = rec.advised.lifts.map(l => l.id);
      const inter = ids.filter(id => adv.indexOf(id) >= 0).length;
      const union = ids.length + adv.length - inter;
      const muscles = {};
      if (s) s.exercises.forEach(x => {
        const m = (index.info[x.id] || {}).muscles || {};
        Object.keys(m).forEach(g => { muscles[g] = (muscles[g] || 0) + x.sets.length * m[g]; });
      });
      const actMus = Object.keys(muscles).filter(g => muscles[g] >= 1).sort();
      const am = rec.advised.muscles;
      const mi = actMus.filter(g => am.indexOf(g) >= 0).length;
      const mu = actMus.length + am.length - mi;
      const rated = s ? s.exercises.filter(x => x.rir != null) : [];
      const capOk = rated.length ? rated.filter(x => +x.rir >= 1).length / rated.length : null;
      // Advice other than rest is "how to train if you train", so a rest day under it is not
      // a disagreement: those days are left out of the adherence numbers (null).
      const answerFollowed = rec.advised.answer === 'rest' ? !trained : trained ? true : null;
      const liftOverlap = union ? inter / union : null;
      const muscleOverlap = mu ? mi / mu : null;
      const followed = rec.advised.answer === 'rest' ? !trained
        : !trained ? null
          : (muscleOverlap != null && muscleOverlap >= 0.5) && (rec.advised.answer !== 'pull_back' || (capOk != null && capOk >= 0.5));
      const drops = s ? s.exercises.map(x => C.fatigueIndex(x.sets, { rir: x.rir })).filter(f => f.applicable).map(f => f.rawDropoff) : [];
      const pr = prByDate[rec.date] || { n: 0, pr: 0 };
      return Object.assign({}, rec, { actual: { trained: trained, lifts: ids, muscles: actMus, rirAtLeast1Share: capOk },
        answerFollowed: answerFollowed, liftOverlap: liftOverlap, muscleOverlap: muscleOverlap, followed: followed,
        outcome: { prN: pr.n, prs: pr.pr, dropoffMean: drops.length ? drops.reduce((a, b) => a + b, 0) / drops.length : null, dropoffN: drops.length } });
    });
    const group = f => {
      const g = rows.filter(r => r.actual.trained && r.followed === f);
      const prN = g.reduce((a, r) => a + r.outcome.prN, 0), prs = g.reduce((a, r) => a + r.outcome.prs, 0);
      const dn = g.reduce((a, r) => a + r.outcome.dropoffN, 0);
      const ds = g.reduce((a, r) => a + (r.outcome.dropoffMean || 0) * r.outcome.dropoffN, 0);
      return { days: g.length, liftSessions: prN, prRate: prN ? prs / prN : null, dropoffMean: dn ? ds / dn : null, dropoffN: dn };
    };
    const judged = rows.filter(r => r.answerFollowed != null), judgedF = rows.filter(r => r.followed != null);
    return { rows: rows, days: rows.length, judgedDays: judged.length,
             answerAgreement: judged.length ? judged.filter(r => r.answerFollowed).length / judged.length : null,
             followedShare: judgedF.length ? judgedF.filter(r => r.followed).length / judgedF.length : null,
             followed: group(true), notFollowed: group(false),
             note: 'Outcomes on trained days only. Small groups: read as a direction, not a finding.' };
  }

  // =====================================================================================
  // 13. App glue (pure): the Settings form's values, the card's "days since" rows, a swap
  // =====================================================================================
  // What the app stores in targets.planner. The engine's own defaults differ on purpose
  // (restMode 'rest', all seven weekdays); the app passes these explicitly.
  const APP_DEFAULTS = { priorities: ['chest', 'lats', 'sideDelts'], daysPerWeek: 4,
    availableWeekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], restMode: 'lighter', sessionMinutes: 75 };
  // Muscles the Settings form offers as priorities. Leg muscles are not offered in this pass.
  const PRIORITY_CHOICES = ['chest', 'lats', 'upperBack', 'frontDelts', 'sideDelts', 'rearDelts', 'triceps', 'biceps'];
  // stored: the targets.planner object (or nothing). Returns {ok, errors, settings, config}:
  // settings = the friendly values with app defaults filled in; config = the engine config
  // after validateConfig. A bad value is reported, never silently replaced.
  function appSettings(stored) {
    const s = Object.assign({}, APP_DEFAULTS, isObj(stored) ? stored : {});
    s.priorities = Array.isArray(s.priorities) ? s.priorities.filter(p => p != null && p !== '') : [];
    s.availableWeekdays = Array.isArray(s.availableWeekdays) ? WEEKDAY.filter(d => s.availableWeekdays.indexOf(d) >= 0) : [];
    s.daysPerWeek = +s.daysPerWeek;
    s.sessionMinutes = +s.sessionMinutes;
    const e = [];
    if (!s.priorities.length) e.push('Pick at least one priority muscle.');
    if (s.priorities.length > 3) e.push('Pick at most three priority muscles.');
    s.priorities.forEach(p => { if (PRIORITY_CHOICES.indexOf(p) < 0) e.push(`${LABEL[p] || p} cannot be a priority here.`); });
    if (new Set(s.priorities).size !== s.priorities.length) e.push('Each priority muscle can be picked once.');
    if (!(Number.isInteger(s.daysPerWeek) && s.daysPerWeek >= 3 && s.daysPerWeek <= 5)) e.push('Days per week must be 3, 4 or 5.');
    if (!s.availableWeekdays.length) e.push('Tick at least one weekday you can train on.');
    else if (Number.isInteger(s.daysPerWeek) && s.availableWeekdays.length < Math.min(3, s.daysPerWeek)) e.push(`Tick at least ${Math.min(3, s.daysPerWeek)} weekdays.`);
    // His weeks run Monday to Friday, so the weekly aim is counted per calendar week.
    const v = validateConfig({ priorities: s.priorities, daysPerWeek: { min: 3, max: 5, preferred: s.daysPerWeek },
      availableWeekdays: s.availableWeekdays, restMode: s.restMode, sessionMinutes: s.sessionMinutes, weekStart: 'Mon' });
    // The engine's own checks still run; its messages are reworded where the form has a field.
    const own = e.length;
    v.errors.forEach(x => {
      if (/^sessionMinutes/.test(x)) e.push('Session length must be 20 to 240 minutes.');
      else if (/^restMode/.test(x)) e.push('Choose what to do when a rest day is due.');
      else if (!own || !/priorit|daysPerWeek|availableWeekdays/.test(x)) e.push(x);
    });
    return { ok: e.length === 0, errors: e, settings: s, config: v.config };
  }
  // The card's "days since trained" list: the priority muscles in order, legs (the later of
  // quads and hamstrings), then any other scheduled muscle behind its aim. tone: 'bad' not yet
  // recovered, 'warn' recovered but recent, 'ok' 4 to 10 days, 'info' longer (overdue).
  // width is the bar length, 21+ days = full.
  function daysSinceRows(state, config) {
    const cfg = resolveConfig(config);
    const rows = [], seen = {};
    const row = (label, days, minGap, behind) => {
      const tone = days == null ? 'info' : days < minGap ? 'bad' : days < 4 ? 'warn' : days <= 10 ? 'ok' : 'info';
      rows.push({ label: label, days: days, tone: tone, width: days == null ? 1 : Math.max(0.04, Math.min(1, days / 21)), behind: behind });
    };
    cfg.priorities.forEach(p => {
      const m = state.muscles[p.muscle]; if (!m) return;
      seen[p.muscle] = 1;
      row(m.label, m.daysSince, m.minGap, m.deficit);
    });
    const legs = LEG_MUSCLES.map(g => state.muscles[g]);
    const legDays = legs.some(m => m.daysSince == null) ? null : Math.max.apply(null, legs.map(m => m.daysSince));
    LEG_MUSCLES.forEach(g => { seen[g] = 1; });
    row('Legs', legDays, cfg.legBlockGapDays, r1(legs.reduce((a, m) => a + m.deficit, 0)));
    MUSCLES.forEach(g => {
      const m = state.muscles[g];
      if (seen[g] || m.kind === 'none' || !(m.deficit >= 1)) return;
      row(m.label, m.daysSince, m.minGap, m.deficit);
    });
    return rows;
  }
  // Replace one item of a generated session with another lift for the same day: same sets,
  // same block and same effort cap, the load and reps prescribed for the new lift.
  function swapItem(item, altId, ctx) {
    const cfg = resolveConfig(ctx.config);
    const l = ctx.state.lifts[altId];
    if (!l) return null;
    const rx = prescribe(l, cfg, item.prescription.rirCap, item.sets, item.block === 'legs');
    return Object.assign({}, item, { id: l.id, name: l.name, pattern: l.info.pattern, movement: l.info.movement,
      equipment: l.info.equipment, prescription: rx, swappedFrom: { id: item.id, name: item.name },
      reasonText: `swapped in for ${item.name}; ` + liftReasonText(l, item.muscle, null) });
  }

  return {
    APP_DEFAULTS: APP_DEFAULTS, PRIORITY_CHOICES: PRIORITY_CHOICES, appSettings: appSettings,
    daysSinceRows: daysSinceRows, swapItem: swapItem, weekday: weekday,
    DEFAULT_CONFIG: DEFAULT_CONFIG, validateConfig: validateConfig, resolveConfig: resolveConfig,
    describeLift: describeLift, inferEquipment: inferEquipment, movementOf: movementOf,
    normalizeSessions: normalizeSessions, weightSeries: weightSeries, buildIndex: buildIndex, liftState: liftState,
    prEvents: prEvents, rateTable: rateTable, learnFloor: learnFloor, recoveryModel: recoveryModel,
    effectiveWindow: effectiveWindow, LIFT_BINS: LIFT_BINS, SESSION_BINS: SESSION_BINS, MUSCLE_BINS: MUSCLE_BINS,
    targetFor: targetFor, weekState: weekState, readiness: readiness, generateSession: generateSession,
    prescribe: prescribe, planChanges: planChanges, planToday: planToday,
    chooseTrainingDays: chooseTrainingDays, planWeek: planWeek, alternatives: alternatives,
    adjustVolume: adjustVolume, linkCandidates: linkCandidates, linkAlias: linkAlias, nudgeRecord: nudgeRecord, scoreNudges: scoreNudges,
    addDays: addDays, LEG_MUSCLES: LEG_MUSCLES
  };
});
