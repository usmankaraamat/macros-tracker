// Tests for supabase/functions/_shared/liftplan.js. Run: node scripts/test-liftplan.mjs
// The fixture copies the SHAPE of Google Calendar's iCal export (folded lines, escaped
// text, TZID and UTC times, weekly RRULEs, EXDATE, moved and cancelled occurrences) with
// made-up content. The repo is public, so no real calendar text belongs here.
import { liftPlan, exercisesFrom, unfoldIcs, todayIn, addDays } from '../supabase/functions/_shared/liftplan.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) passed++; else { failed++; console.log('FAIL', name, detail === undefined ? '' : '— ' + detail); }
}

const ics = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-TIMEZONE:Asia/Karachi',
  // Weekly Monday push day, starting Mon 13 Oct 2026 18:30 Karachi, with a long folded description.
  'BEGIN:VEVENT', 'UID:push@google.com',
  'DTSTART;TZID=Asia/Karachi:20261012T183000', 'DTEND;TZID=Asia/Karachi:20261012T203000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Asia/Karachi:20261026T183000',
  'SUMMARY:Push A — Squat + Upper Chest',
  'DESCRIPTION:21 sets\\n\\n[--] Quad set | 2x10\\, 5s holds\\n[C] Squat (Smith or free bar) — FIRST | 3x6-8\\n[I] DB Lat',
  ' eral Raises | 5x10-15\\n\\nNOTES\\n- Rest 2-3 min',
  'END:VEVENT',
  // Weekly Tuesday pull day, stored in UTC (13:30Z = 18:30 Karachi), with a moved occurrence.
  'BEGIN:VEVENT', 'UID:pull@google.com',
  'DTSTART:20261013T133000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z',
  'SUMMARY:Pull A — Lat Width', 'DESCRIPTION:[C] Chin-ups | 3x6-12\\n[I] Bicep Curl | 3x8-12',
  'END:VEVENT',
  // The Tue 20 Oct pull session moved to Wed 21 Oct 07:00.
  'BEGIN:VEVENT', 'UID:pull@google.com',
  'RECURRENCE-ID:20261020T133000Z', 'DTSTART;TZID=Asia/Karachi:20261021T070000',
  'SUMMARY:Pull A — Lat Width (moved)', 'DESCRIPTION:[C] Chin-ups | 3x6-12',
  'END:VEVENT',
  // Thursday every two weeks, with one occurrence cancelled.
  'BEGIN:VEVENT', 'UID:legs@google.com',
  'DTSTART;TZID=Asia/Karachi:20261015T183000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH',
  'SUMMARY:Legs', 'DESCRIPTION:[C] Leg Press | 3x10-15',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:legs@google.com', 'RECURRENCE-ID;TZID=Asia/Karachi:20261029T183000',
  'DTSTART;TZID=Asia/Karachi:20261029T183000', 'STATUS:CANCELLED', 'SUMMARY:Legs', 'DESCRIPTION:[C] Leg Press | 3x10-15',
  'END:VEVENT',
  // Not a lift: no exercise lines. Must never appear in the output.
  'BEGIN:VEVENT', 'UID:work@google.com', 'DTSTART;TZID=Asia/Karachi:20261017T170000',
  'RRULE:FREQ=WEEKLY;BYDAY=SA,SU', 'SUMMARY:Deep work', 'DESCRIPTION:Protected block',
  'END:VEVENT',
  // A one-off lift on Sat 24 Oct.
  'BEGIN:VEVENT', 'UID:oneoff@google.com', 'DTSTART;TZID=Asia/Karachi:20261024T100000',
  'SUMMARY:Arms extra', 'DESCRIPTION:[I] Hammer Curl | 3x10', 'END:VEVENT',
  // A monthly rule is outside what the parser supports: reported, not guessed.
  'BEGIN:VEVENT', 'UID:monthly@google.com', 'DTSTART;TZID=Asia/Karachi:20261001T090000',
  'RRULE:FREQ=MONTHLY;BYMONTHDAY=1', 'SUMMARY:Test day', 'DESCRIPTION:[C] Deadlift | 1x3', 'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

const TZ = 'Asia/Karachi';
const { sessions, skipped } = liftPlan(ics, '2026-10-19', 14, TZ);   // Mon 19 Oct → Sun 1 Nov
const on = d => sessions.filter(s => s.date === d).map(s => s.title);

check('folded lines are joined', unfoldIcs('A:ab\r\n cd').join('|') === 'A:abcd');
check('Monday push on 19 Oct', on('2026-10-19').includes('Push A — Squat + Upper Chest'), JSON.stringify(on('2026-10-19')));
check('EXDATE removes 26 Oct', on('2026-10-26').length === 0, JSON.stringify(on('2026-10-26')));
check('UTC start lands on the Karachi date and time', sessions.find(s => s.date === '2026-10-27')?.time === '18:30');
check('moved occurrence leaves its old day', on('2026-10-20').length === 0, JSON.stringify(on('2026-10-20')));
check('moved occurrence appears on its new day', on('2026-10-21').includes('Pull A — Lat Width (moved)'));
check('INTERVAL=2: 15 Oct series has no session on 22 Oct', on('2026-10-22').length === 0);
check('cancelled occurrence on 29 Oct is dropped', on('2026-10-29').length === 0, JSON.stringify(on('2026-10-29')));
check('one-off lift included', on('2026-10-24').includes('Arms extra'));
check('non-lift events never returned', !sessions.some(s => s.title === 'Deep work'));
check('unsupported rule reported in skipped', skipped.includes('Test day'), JSON.stringify(skipped));
check('sorted by date', sessions.every((s, i) => !i || sessions[i - 1].date <= s.date));

const push = sessions.find(s => s.date === '2026-10-19');
check('exercise lines parsed, including a folded one',
  push.exercises.map(e => e.name).join('|') === 'Quad set|Squat (Smith or free bar) — FIRST|DB Lateral Raises',
  push.exercises.map(e => e.name).join('|'));
check('escaped comma kept in target', push.exercises[0].target === '2x10, 5s holds', push.exercises[0].target);
check('kinds kept', push.exercises.map(e => e.kind).join('') === '--CI');
check('notes exclude exercise lines', push.notes.includes('Rest 2-3 min') && !push.notes.includes('[C]'), push.notes);
check('exercisesFrom ignores prose', exercisesFrom('Rest | 2 min\n[C] Row | 3x8').length === 1);
check('todayIn uses the zone', todayIn(TZ, new Date('2026-10-18T20:30:00Z')) === '2026-10-19');
check('addDays crosses months', addDays('2026-10-31', 1) === '2026-11-01');

console.log(`liftplan: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
