// liftplan.js -- Read the lift sessions out of a Google Calendar iCal feed.
// Pure functions, no Deno or browser APIs, so the same file runs in the lift-plan Edge
// Function and in `node scripts/test-liftplan.mjs`.
//
// A lift session is any event whose description has at least one exercise line:
//   [C] Barbell RDL — FIRST, free bar | 3x6-8      (C = compound, I = isolation, -- = drill)
// Everything else on the calendar is ignored and never leaves the function.
//
// Recurrence support is deliberately narrow: FREQ=WEEKLY and FREQ=DAILY with INTERVAL,
// BYDAY, UNTIL and COUNT, plus EXDATE and moved/cancelled single occurrences
// (RECURRENCE-ID). That covers Google's weekly repeating events. An event with any other
// rule is reported in `skipped` rather than guessed at.

const DAY_MS = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// iCal folds long lines: a line starting with a space or tab continues the previous one.
export function unfoldIcs(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescapeText(v) {
  return String(v || '')
    .replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

// "DTSTART;TZID=Asia/Karachi:20261013T183000" → {name:'DTSTART', params:{TZID:...}, value:'2026...'}
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(';');
  const params = {};
  head.slice(1).forEach(p => { const i = p.indexOf('='); if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1); });
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

// Calendar date and time in `tz` for an iCal date-time. Floating and TZID times are
// already wall-clock; a UTC time (trailing Z) is converted into `tz`.
function localDateTime(value, params, tz) {
  const v = String(value || '').trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, , z] = m;
  if (!hh) return { date: `${y}-${mo}-${d}`, time: '' };          // all-day (VALUE=DATE)
  if (!z) return { date: `${y}-${mo}-${d}`, time: `${hh}:${mm}` };
  const utc = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(utc).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const toUtc = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromUtc = ms => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso, n) => fromUtc(toUtc(iso) + n * DAY_MS);

function parseRrule(v) {
  const r = {};
  String(v || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) r[p.slice(0, i).toUpperCase()] = p.slice(i + 1); });
  return r;
}

export function parseEvents(text, tz) {
  const events = [];
  let cur = null;
  for (const raw of unfoldIcs(text)) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') { cur = { exdates: new Set() }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const l = parseLine(line);
    if (!l) continue;
    if (l.name === 'UID') cur.uid = l.value;
    else if (l.name === 'SUMMARY') cur.summary = unescapeText(l.value);
    else if (l.name === 'DESCRIPTION') cur.description = unescapeText(l.value);
    else if (l.name === 'STATUS') cur.status = l.value.toUpperCase();
    else if (l.name === 'DTSTART') cur.start = localDateTime(l.value, l.params, tz);
    else if (l.name === 'RRULE') cur.rrule = parseRrule(l.value);
    else if (l.name === 'RECURRENCE-ID') { const r = localDateTime(l.value, l.params, tz); if (r) cur.recurrenceId = r.date; }
    else if (l.name === 'EXDATE') l.value.split(',').forEach(x => { const r = localDateTime(x, l.params, tz); if (r) cur.exdates.add(r.date); });
  }
  return events;
}

// Exercise lines from an event description, in order.
export function exercisesFrom(description) {
  const out = [];
  String(description || '').split('\n').forEach(line => {
    const m = line.match(/^\s*\[(C|I|--)\]\s*(.+?)\s*\|\s*(.+?)\s*$/);
    if (m) out.push({ kind: m[1], name: m[2], target: m[3] });
  });
  return out;
}
// Everything in the description that is not an exercise line, blank runs collapsed.
function notesFrom(description) {
  return String(description || '').split('\n')
    .filter(l => !/^\s*\[(C|I|--)\]/.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Occurrence dates of a recurring master event within [from, to] (inclusive ISO dates).
// Returns null when the rule is outside what this file supports.
function occurrences(ev, from, to, tz) {
  const start = ev.start.date;
  if (!ev.rrule) return start >= from && start <= to ? [start] : [];
  const r = ev.rrule;
  const freq = (r.FREQ || '').toUpperCase();
  if (freq !== 'WEEKLY' && freq !== 'DAILY') return null;
  if (r.BYMONTH || r.BYMONTHDAY || r.BYSETPOS || r.BYYEARDAY || r.BYWEEKNO) return null;
  const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
  const until = r.UNTIL ? (localDateTime(r.UNTIL, {}, tz) || {}).date : null;
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const out = [];
  let n = 0;
  const startMs = toUtc(start);
  if (freq === 'DAILY') {
    for (let ms = startMs; ; ms += interval * DAY_MS) {
      const d = fromUtc(ms);
      if ((until && d > until) || n >= count || d > to) break;
      n++;
      if (d >= from) out.push(d);
    }
    return out;
  }
  // WEEKLY: weeks start on Monday (iCal's default WKST); BYDAY defaults to DTSTART's day.
  const days = (r.BYDAY ? r.BYDAY.split(',') : [WEEKDAYS[new Date(startMs).getUTCDay()]])
    .map(x => WEEKDAYS.indexOf(x.replace(/^[+-]?\d+/, '').toUpperCase())).filter(i => i >= 0)
    .map(i => (i + 6) % 7).sort((a, b) => a - b);                       // Monday = 0
  if (!days.length) return null;
  const weekStart0 = startMs - ((new Date(startMs).getUTCDay() + 6) % 7) * DAY_MS;
  for (let w = weekStart0; ; w += interval * 7 * DAY_MS) {
    let past = false;
    for (const off of days) {
      const ms = w + off * DAY_MS;
      if (ms < startMs) continue;
      const d = fromUtc(ms);
      if ((until && d > until) || n >= count || d > to) { past = true; break; }
      n++;
      if (d >= from) out.push(d);
    }
    if (past) break;
  }
  return out;
}

// Lift sessions dated from `from` for `days` days, in `tz`, sorted by date and time.
export function liftPlan(text, from, days, tz) {
  const to = addDays(from, Math.max(1, days) - 1);
  const events = parseEvents(text, tz).filter(e => e.start);
  const overrides = {};                                   // uid → Set of original dates replaced
  events.filter(e => e.recurrenceId).forEach(e => {
    (overrides[e.uid] = overrides[e.uid] || new Set()).add(e.recurrenceId);
  });
  const sessions = [], skipped = [];
  const push = (ev, date) => {
    const exercises = exercisesFrom(ev.description);
    if (!exercises.length || ev.status === 'CANCELLED') return;
    sessions.push({ date, time: ev.start.time, title: ev.summary || 'Lift', exercises, notes: notesFrom(ev.description) });
  };
  events.forEach(ev => {
    if (ev.recurrenceId) {                                // a moved or edited single occurrence
      if (ev.start.date >= from && ev.start.date <= to) push(ev, ev.start.date);
      return;
    }
    const dates = occurrences(ev, from, to, tz);
    if (dates === null) { if (exercisesFrom(ev.description).length) skipped.push(ev.summary || ev.uid); return; }
    const moved = overrides[ev.uid] || new Set();
    dates.filter(d => !ev.exdates.has(d) && !moved.has(d)).forEach(d => push(ev, d));
  });
  sessions.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { sessions, skipped };
}

// Today's date in `tz` as YYYY-MM-DD.
export function todayIn(tz, now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now || new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
}
