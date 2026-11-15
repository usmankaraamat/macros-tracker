// planner-backtest.mjs — run the session planner over a real Eatify export.
//   node scripts/planner-backtest.mjs <path-to-export.json> [today=YYYY-MM-DD] [> out.txt]
// Prints aggregates, the engine's advice next to what was actually done, and the proposed
// week. It never prints raw entries, food names or notes, and writes nothing to disk.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../core.js');
const P = require('../planner.js');

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/planner-backtest.mjs <export.json> [today]'); process.exit(2); }
const TODAY = process.argv[3] || '2026-11-16';
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const sessions = P.normalizeSessions(d.workouts || {});
const catalogue = d.exercises || [];
const weights = d.weights || {};
// The app's own defaults: chest > side delts > lats > forearms, Monday to Friday, 90 min.
const app = P.appSettings(null);
const PRIOS = app.settings.priorities;
const config = P.resolveConfig(app.config);
const L = C.MUSCLE_LABEL;
const pct = x => x == null ? '  -' : String(Math.round(x * 100)).padStart(3) + '%';
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const line = (c = '-') => console.log(c.repeat(78));
const h = t => { console.log(''); line('='); console.log(t); line('='); };
const kcalOn = date => (d.days && Array.isArray(d.days[date])) ? d.days[date].reduce((s, e) => s + (+e.k || 0), 0) : 0;
const floor = d.targets && +d.targets.floor;

console.log(`Session planner backtest. Export: ${d.exported || '?'}. Planning date: ${TODAY}.`);
console.log('Aggregates only. Priorities: chest > lats > side delts.');

// ---- 0. What the log looks like ------------------------------------------------------
h('0. The log at a glance');
const dates = sessions.map(s => s.date);
const gaps = dates.slice(1).map((x, i) => (Date.parse(x) - Date.parse(dates[i])) / 864e5);
let rated = 0, rir0 = 0;
sessions.forEach(s => s.exercises.forEach(x => { if (x.rir != null) { rated++; if (+x.rir === 0) rir0++; } }));
const idxAll = P.buildIndex(sessions, catalogue, TODAY, { weights });
const legIds = id => P.LEG_MUSCLES.indexOf(idxAll.info[id].primary) >= 0;
const legSessions = sessions.filter(s => s.exercises.some(x => legIds(x.id)));
console.log(`Sessions with sets: ${sessions.length} (${dates[0]} to ${dates[dates.length - 1]}).`);
console.log(`Gaps between sessions: ${gaps.length}; one-day gaps: ${gaps.filter(g => g === 1).length}.`);
console.log(`Exercises with RIR logged: ${rated}; at RIR 0: ${rir0} (${pct(rir0 / rated).trim()}).`);
console.log(`Sessions marked deload: ${sessions.filter(s => s.deload).length}.`);
console.log(`Sessions with a leg exercise (quads/hamstrings primary): ${legSessions.length}; last: ${legSessions.length ? legSessions[legSessions.length - 1].date : 'none'}.`);
const last20 = sessions.slice(-20);
const v20 = C.weeklyVolumeByMuscle(last20, idxAll.catalogue, null);
const raw20 = {};
last20.forEach(s => s.exercises.forEach(x => { const p = idxAll.info[x.id].primary; raw20[p] = (raw20[p] || 0) + x.sets.length; }));
console.log('Last 20 sessions, sets by primary muscle (raw count) and involvement-weighted:');
['chest', 'sideDelts', 'lats', 'upperBack', 'quads', 'hamstrings'].forEach(g =>
  console.log(`  ${pad(L[g], 12)} raw ${lpad(raw20[g] || 0, 3)}   weighted ${lpad((v20[g] || 0).toFixed(1), 5)}`));

// ---- 1. PR by gap ------------------------------------------------------------------
h('1. PR rate by gap (a PR = a new best e1RM for that lift)');
const model = P.recoveryModel(idxAll, config);
const printTable = (title, rows) => {
  console.log(title);
  console.log('  gap (days)   lift-sessions   PRs   PR rate');
  rows.forEach(r => console.log(`  ${pad(r.label, 12)} ${lpad(r.n, 13)} ${lpad(r.prs, 5)}   ${pct(r.rate)}`));
};
console.log(`Lift-sessions with a previous best: ${model.events}; PRs: ${model.prs} (${pct(model.prs / model.events).trim()}).`);
printTable('By days since the same lift was last done:', model.tables.byLiftGap);
printTable('By days since the previous gym session of any kind:', model.tables.bySessionGap);
const altIdx = P.prEvents(idxAll, { mode: 'class' });
console.log(`Variant: judging high-rep lifts on capacity instead of e1RM gives ${altIdx.length} lift-sessions, ${altIdx.filter(e => e.pr).length} PRs.`);

h('2. Learned recovery windows (used only at medium confidence or better)');
const g0 = model.global;
console.log(`Same-lift floor, all lifts: default ${g0.defaultValue} d, learned ${g0.learned ?? '-'} d, n ${g0.n}, z ${g0.z ?? '-'}, confidence ${g0.confidence} -> using ${g0.value} d (${g0.source}).`);
if (g0.detail) console.log(`  gaps under ${g0.learned} d: PR rate ${pct(g0.detail.rateShort).trim()} (n ${g0.detail.nShort}); ${g0.learned}-13 d: ${pct(g0.detail.rateLong).trim()} (n ${g0.detail.nLong}).`);
console.log('Per muscle (by the lift\'s primary muscle):');
console.log('  muscle        n    same-lift floor          muscle-gap floor');
Object.keys(model.muscle).sort((a, b) => model.muscle[b].n - model.muscle[a].n).forEach(g => {
  const m = model.muscle[g], mg = model.muscleGap[g];
  console.log(`  ${pad(L[g], 12)} ${lpad(m.n, 4)}    ${pad(`${m.value} d (${m.confidence}${m.learned ? ', data ' + m.learned : ''})`, 24)} ${mg.value} d (${mg.confidence}${mg.learned ? ', data ' + mg.learned : ''})`);
});
const liftConf = {};
Object.keys(model.lift).forEach(id => { const c = model.lift[id].confidence; liftConf[c] = (liftConf[c] || 0) + 1; });
console.log(`Per lift: ${Object.keys(model.lift).length} lifts; confidence counts ${JSON.stringify(liftConf)}. Lifts at "none" use the muscle or global value.`);

// ---- 3. Weekly sets ----------------------------------------------------------------
h('3. Weekly sets per muscle, last 8 weeks (7-day blocks ending the day before planning)');
const blocks = [];
for (let i = 7; i >= 0; i--) blocks.push({ from: P.addDays(TODAY, -7 * (i + 1)), to: P.addDays(TODAY, -7 * i - 1) });
const show = ['chest', 'lats', 'sideDelts', 'upperBack', 'rearDelts', 'frontDelts', 'triceps', 'biceps', 'quads', 'hamstrings', 'glutes'];
console.log(pad('muscle', 12) + ' target ' + blocks.map(b => lpad(b.to.slice(5), 6)).join(''));
show.forEach(g => {
  const t = P.targetFor(g, config);
  const vals = blocks.map(b => C.weeklyVolumeByMuscle(sessions, idxAll.catalogue, b)[g] || 0);
  console.log(pad(L[g], 12) + lpad(t.kind === 'priority' ? `${t.min}-${t.max}` : `>=${t.aim}`, 7) + ' ' + vals.map(v => lpad(v.toFixed(0), 6)).join(''));
});
console.log('Sessions/wk ' + lpad('', 8) + blocks.map(b => lpad(sessions.filter(s => s.date >= b.from && s.date <= b.to).length, 6)).join(''));

// ---- 4. Last 4 weeks: advice vs what happened --------------------------------------
h('4. Last 4 weeks: what the engine would have said each morning, and what happened');
const records = [];
const start = P.addDays(TODAY, -28);
console.log('date        advice      why                               did      muscle overlap');
for (let i = 0; i < 28; i++) {
  const day = P.addDays(start, i);
  const y = P.addDays(day, -1);
  const out = P.planToday({ sessions, catalogue, weights, today: day, config, model,
    readinessInput: { intake: { kcal: kcalOn(y), floor } } });
  const rec = P.nudgeRecord(out.readiness, out.session);
  records.push({ rec, out });
}
const scored = P.scoreNudges(records.map(r => r.rec), sessions, catalogue, weights);
scored.rows.forEach((r, i) => {
  const out = records[i].out;
  const codes = r.advised.codes.filter(c => c !== 'CLEAR').slice(0, 2).join(',');
  const did = r.actual.trained ? 'trained' : 'rest';
  console.log(`${r.date}  ${pad(r.advised.answer, 10)}  ${pad(codes || '-', 32)}  ${pad(did, 7)}  ${r.actual.trained && r.advised.answer !== 'rest' ? (r.muscleOverlap == null ? '-' : pct(r.muscleOverlap)) : ''}`);
  if (r.advised.answer !== 'rest' && r.actual.trained) {
    console.log(`            advised: ${out.session.items.map(it => it.name).join(', ') || '(nothing)'}`);
    console.log(`            done:    ${r.actual.lifts.map(id => (idxAll.info[id] || { name: id }).name).join(', ')}`);
  }
});
const counts = {};
scored.rows.forEach(r => { counts[r.advised.answer] = (counts[r.advised.answer] || 0) + 1; });
const trainedRows = scored.rows.filter(r => r.actual.trained);
const restAdvTrained = scored.rows.filter(r => r.advised.answer === 'rest' && r.actual.trained).length;
const mo = trainedRows.filter(r => r.advised.answer !== 'rest' && r.muscleOverlap != null);
const lo = trainedRows.filter(r => r.advised.answer !== 'rest' && r.liftOverlap != null);
console.log('');
console.log(`Advice mix over 28 days: ${JSON.stringify(counts)}.`);
console.log(`Days advised rest: ${counts.rest || 0}; of those he rested on ${(counts.rest || 0) - restAdvTrained} and trained on ${restAdvTrained}.`);
console.log(`Days trained: ${trainedRows.length}; readiness said rest on ${restAdvTrained} of them (${pct(restAdvTrained / (trainedRows.length || 1)).trim()}).`);
console.log(`Answer agreement on judged days (rest advised, or he trained): ${pct(scored.answerAgreement).trim()} of ${scored.judgedDays}. Non-rest advice on a day he rested is not judged.`);
const shortDays = records.filter(r => !r.out.session.rest && (r.out.session.notes || []).some(n => n.code === 'AHEAD_OF_WEEK')).length;
console.log(`Days where the engine had little to add (AHEAD_OF_WEEK note): ${shortDays}.`);
console.log(`On trained days with a session advised: mean muscle overlap ${pct(mo.reduce((a, r) => a + r.muscleOverlap, 0) / (mo.length || 1)).trim()} (n ${mo.length}); mean lift overlap ${pct(lo.reduce((a, r) => a + r.liftOverlap, 0) / (lo.length || 1)).trim()}.`);
console.log(`"Followed" days among judged days (answer right, >=50% muscle overlap, RIR cap kept on pull-back days): ${pct(scored.followedShare).trim()}.`);
const fmtG = (n, g) => `${n}: ${g.days} days, ${g.liftSessions} lift-sessions, PR rate ${pct(g.prRate).trim()}, mean rep drop-off ${g.dropoffMean == null ? '-' : Math.round(g.dropoffMean * 100) + '%'} (n ${g.dropoffN})`;
console.log(fmtG('Followed    ', scored.followed));
console.log(fmtG('Not followed', scored.notFollowed));
console.log('These were not real nudges: he never saw this advice, so "followed" means "happened to match". Read as a check of the scoring code, not as evidence.');

// ---- 5. Proposed week --------------------------------------------------------------
h(`5. Proposed 7 days from ${TODAY}, chest > lats > side delts`);
const ky = kcalOn(P.addDays(TODAY, -1));
[3, 4, 5].forEach(n => {
  const w = P.planWeek({ sessions, catalogue, weights, today: TODAY, config, model, daysPerWeek: n,
    readinessInput: { intake: { kcal: ky, floor } } });
  line();
  console.log(`${n} days a week. Today's readiness: ${w.readinessToday.headline}. ${w.readinessToday.sentence}`);
  console.log(`  facts: ${w.readinessToday.facts.slice(0, 4).map(f => f.label).join(' · ')}`);
  w.warnings.forEach(x => console.log(`  warning: ${x.code} ${x.why || ''}`));
  w.days.forEach(day => {
    if (!day.train) { console.log(`${day.date} ${day.weekday}  rest`); return; }
    const s = day.session;
    console.log(`${day.date} ${day.weekday}  ${s.minutes} min, readiness ${day.readiness.answer} [${day.readiness.codes.join(',')}]${s.dropped.length ? `, dropped for time: ${s.dropped.map(x => x.name).join(', ')}` : ''}${(s.notes || []).length ? ' (' + s.notes.map(n => n.code).join(', ') + ')' : ''}`);
    s.items.forEach(it => console.log(`     ${it.block ? '[legs] ' : ''}${pad(it.name, 40)} ${it.prescription.text}`));
  });
  console.log('  muscle       planned  aim   days  lifts');
  ['chest', 'sideDelts', 'lats', 'forearms', 'upperBack', 'rearDelts', 'triceps', 'biceps', 'quads', 'hamstrings'].forEach(g => {
    const x = w.summary[g]; if (!x) return;
    console.log(`  ${pad(L[g], 12)} ${lpad(x.planned.toFixed(1), 7)} ${lpad(x.aim, 4)} ${lpad(x.days, 6)} ${lpad(x.lifts, 6)}`);
  });
  console.log(`  leg blocks: ${w.legBlocks}`);
});
const today = P.planToday({ sessions, catalogue, weights, today: TODAY, config, model, readinessInput: { intake: { kcal: ky, floor } } });
h('6. Today in detail: reasons and swap options');
today.session.items.forEach(it => {
  console.log(`${it.name}: ${it.prescription.text} [${it.prescription.rule}]`);
  console.log(`   why: ${it.reasonText}`);
  const alts = P.alternatives(it.id, { state: today.state, index: today.index, config, model, readiness: today.readiness }, 3);
  console.log(`   swap for: ${alts.filter(a => a.available).map(a => a.name).join(', ') || '(none available)'}`);
});
const adj = P.adjustVolume(today.index, today.state, config);
console.log('');
console.log('Volume adjustment for next week (priority and leg muscles):');
['chest', 'lats', 'sideDelts', 'quads', 'hamstrings'].forEach(g => {
  const a = adj.muscles[g];
  console.log(`  ${pad(L[g], 12)} ${pad(a.action, 6)} ${a.from} -> ${a.to}  (${a.reasons.map(r => r.code).join(', ')}; ${a.lifts} lifts, ${a.progressing} progressing, ${a.regressing} regressing, ${a.highDropoff}/${a.sessions} sessions high drop-off)`);
});
