// state.js -- Protocol defaults, live targets, the built-in food DB, API-key
// storage, and the logical-day machinery (view/active date, close day).

// ---- CONSTANTS (protocol) ----
// PROTOCOL holds the authoritative defaults; live targets are user-overridable
// via Settings and persisted separately, so the protocol itself never mutates.
const PROTOCOL = { floor:1700, ceil:1900, p:120, penK:10, penP:10 };
// FLOOR/CEIL are the EFFECTIVE corridor the whole app reads. FLOOR_M/CEIL_M are the manual
// base the user set in Settings — kept separate so the adaptive goal can drive FLOOR/CEIL
// each day without ever overwriting (or persisting over) the hand-entered numbers.
let FLOOR = PROTOCOL.floor, CEIL = PROTOCOL.ceil;
let FLOOR_M = PROTOCOL.floor, CEIL_M = PROTOCOL.ceil;
// Goal drives the corridor off the adaptive TDEE. mode 'off' = manual corridor; otherwise
// corridor = TDEE + offset ± band. Presets set offset; 'custom' uses the stored offset.
let GOAL = { mode:'off', offset:0, band:100 };
const GOAL_OFFSET = { cut:-500, maintain:0, bulk:300 };   // 'custom' uses GOAL.offset
const GOAL_LABEL  = { cut:'cut', maintain:'maintain', bulk:'lean bulk', custom:'custom' };
function goalOffset(){ return GOAL.mode==='custom' ? (+GOAL.offset||0) : (GOAL_OFFSET[GOAL.mode]||0); }
// Suggested protein by goal (g per kg bodyweight): bulk leans lower, cut higher to spare muscle.
const GOAL_PROTEIN_PER_KG = { cut:2.2, maintain:1.8, bulk:1.6, custom:1.8, off:1.8 };
// Meal plan for bracketed intake pacing: the pace marker ramps around each meal time and
// sits flat between. Budgets are relative — they're scaled to the corridor centre — so the
// numbers just set the shape and timing. Empty = plain linear pacing. Synced with targets.
let MEAL_PLAN = [
  { t:'07:30', kcal:800, name:'Breakfast' },
  { t:'11:00', kcal:200, name:'Brunch' },
  { t:'14:00', kcal:800, name:'Lunch' },
  { t:'16:30', kcal:300, name:'Supper' },
  { t:'21:00', kcal:500, name:'Dinner' }
];
// Training schedule. split is Mon-first (index 0=Mon … 6=Sun); '' or 'Rest' = rest day.
// start/end are the workout window (editable in Settings). cycle drives the corridor to a
// bigger surplus on training days and a smaller one on rest days. autoLift opens the app
// on the Lift tab during that window instead of Today. Synced with targets.
let TRAIN = {
  split: ['Pull','Push','Legs','Upper · pull','Upper · push','Rest','Rest'],
  start:'18:00', end:'20:00', cycle:false, trainOffset:400, restOffset:0, autoLift:true
};
// Is the workout window open right now? Same PKT-shifted clock as the rest of the app, so
// "18:00" means the same 18:00 the coach line and the ledger day already use.
function inWorkoutWindow(){
  const now = new Date(Date.now() + TZ_OFFSET_MIN*60000);
  const wd = (now.getUTCDay()+6)%7;                       // Mon-first, matching TRAIN.split
  return LedgerCore.liftWindowOpen(TRAIN, wd, now.getUTCHours()*60 + now.getUTCMinutes());
}
const WEEKDAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function weekdayMon(ds){ const p=ds.split('-').map(Number); return (new Date(Date.UTC(p[0],p[1]-1,p[2])).getUTCDay()+6)%7; }
function splitForDate(ds){ return TRAIN.split[weekdayMon(ds)] || 'Rest'; }
function isTrainingDay(ds){ const s=splitForDate(ds); return !!s && s.trim().toLowerCase()!=='rest'; }
// Today's corridor offset: cycled by day type when enabled, else the flat goal offset.
function effectiveOffset(){
  if (TRAIN.cycle && GOAL.mode!=='off') return isTrainingDay(ACTIVE_DATE) ? (+TRAIN.trainOffset||0) : (+TRAIN.restOffset||0);
  return goalOffset();
}
// Protein floor, like the caps, can be a fixed gram value or a % of the calorie
// floor (at 4 kcal/g). P_TARGET is the resolved grams used everywhere downstream.
let P_CFG = {mode:'g', val:PROTOCOL.p};
let P_TARGET = PROTOCOL.p;
function computePTarget(){ P_TARGET = LedgerCore.resolvePTarget(P_CFG, FLOOR); }
// Optional caps: {mode:'g'|'pct', val}; val 0 = off. 'pct' = % of the calorie
// floor (the day is engineered to land there), converted at 4 kcal/g carb, 9 fat.
let C_CAP = {mode:'g', val:0}, F_CAP = {mode:'g', val:0};
function capGrams(cap, kcalPerG){ return LedgerCore.capGrams(cap, kcalPerG, FLOOR); }
// Maintenance calorie band (kcal/day) for the fat-change estimate. 0 = unset. Rides
// with the targets bundle so it persists and syncs across devices like the other goals.
let MAINT = {min:0, max:0};
// Body profile for the Mifflin-St Jeor BMR → TDEE. Also synced via the targets bundle.
let PROFILE = {sex:'male', age:0, height:0, activity:'moderate'};
// Weigh-ins before this date are ignored by the TDEE calibration. Switching between a
// deficit and a surplus moves 1-2kg of glycogen and water in the first week or two, and
// energy balance reads that as fat: a real +0.6 kg/wk of mostly water makes maintenance
// look ~600 kcal lower than it is, which then drags the adaptive corridor down with it.
// No estimator can spot that from the numbers alone, because the transition is a fact
// about your diet, not about the series. So it is declared, not inferred. '' = use all.
let TREND_START = '';
const ACTIVITY_MULT = {sedentary:1.2, light:1.375, moderate:1.55, active:1.725, athlete:1.9};
let INFLATE = 1 + PROTOCOL.penK/100, DEDUCT = 1 - PROTOCOL.penP/100;  // unweighed adjustments

function loadTargets(){
  try {
    const t = JSON.parse(localStorage.getItem('ledger_targets')||'null');
    if (t){ FLOOR=+t.floor||FLOOR; CEIL=+t.ceil||CEIL; FLOOR_M=FLOOR; CEIL_M=CEIL;
            if (t.pCfg) P_CFG={mode:t.pCfg.mode==='pct'?'pct':'g', val:+t.pCfg.val||PROTOCOL.p};
            else if (+t.p) P_CFG={mode:'g', val:+t.p};              // legacy grams-only
            if (t.cCap) C_CAP={mode:t.cCap.mode==='pct'?'pct':'g', val:+t.cCap.val||0};
            else if (+t.cMax) C_CAP={mode:'g', val:+t.cMax};        // legacy grams-only
            if (t.fCap) F_CAP={mode:t.fCap.mode==='pct'?'pct':'g', val:+t.fCap.val||0};
            else if (+t.fMax) F_CAP={mode:'g', val:+t.fMax};
            if (t.maint) MAINT={min:+t.maint.min||0, max:+t.maint.max||0};
            if (t.profile) PROFILE={sex:t.profile.sex==='female'?'female':'male', age:+t.profile.age||0,
                                    height:+t.profile.height||0, activity:ACTIVITY_MULT[t.profile.activity]?t.profile.activity:'moderate'};
            if (typeof t.trendStart === 'string') TREND_START = t.trendStart;
            if (t.goal) GOAL={mode:GOAL_LABEL[t.goal.mode]?t.goal.mode:'off', offset:+t.goal.offset||0, band:+t.goal.band>0?+t.goal.band:100};
            if (Array.isArray(t.mealPlan)) MEAL_PLAN = t.mealPlan.map(m=>({t:String(m.t||''), kcal:+m.kcal||0, name:String(m.name||'meal')}));
            if (t.train){ const tn=t.train;
              TRAIN = { split: Array.isArray(tn.split)&&tn.split.length===7 ? tn.split.map(s=>String(s||'Rest')) : TRAIN.split,
                        start:String(tn.start||'18:00'), end:String(tn.end||'20:00'),
                        cycle:!!tn.cycle, trainOffset:+tn.trainOffset||0, restOffset:+tn.restOffset||0,
                        // Absent in blobs written before auto-switch existed — default it ON
                        // rather than silently shipping the feature disabled.
                        autoLift: tn.autoLift !== false }; } }
    const pn = JSON.parse(localStorage.getItem('ledger_pen')||'null');
    // pn.oilK / pn.oilF may still be present from before the oil tax was dropped; ignored.
    if (pn){ INFLATE = 1 + (+pn.k||0)/100; DEDUCT = 1 - (+pn.p||0)/100; }
  } catch(e){}
}
function saveTargets(){
  try { localStorage.setItem('ledger_targets', JSON.stringify({floor:FLOOR_M,ceil:CEIL_M,pCfg:P_CFG,cCap:C_CAP,fCap:F_CAP,maint:MAINT,profile:PROFILE,trendStart:TREND_START,goal:GOAL,mealPlan:MEAL_PLAN,train:TRAIN})); } catch(e){}
  stampTargets(); scheduleSync();              // a genuine local edit — wins LWW until someone edits later
}
function savePens(){
  try { localStorage.setItem('ledger_pen', JSON.stringify({
    k: Math.round((INFLATE-1)*100), p: Math.round((1-DEDUCT)*100) })); } catch(e){}
  stampTargets(); scheduleSync();
}
function refreshTargetLabels(){
  const set=(id,v)=>{const el=document.getElementById(id); if(el) el.textContent=v;};
  set('solverTitle', Math.round(FLOOR));
}

// Which tab is on screen. render() only rebuilds this one — the old render()
// rebuilt all four on every keystroke, heatmap and ternary plot included.
let ACTIVE_TAB = 'today';

// ---- FOOD DB (per 100g): kcal, protein, fat, carb, calcium_mg, phosphorus_mg ----
// Values reconciled against USDA SR; egg/milk set verified vs the Jul 1 log.
const DB = {
  "Egg white, boiled":   {kcal:52,  p:10.9, f:0.17, c:0.73, ca:7,   ph:15},
  "Egg yolk, boiled":    {kcal:322, p:15.9, f:26.5, c:3.6,  ca:129, ph:390},
  "Skimmed milk":        {kcal:35,  p:3.4,  f:0.1,  c:5.0,  ca:122, ph:101},
  "Chicken breast, boiled":{kcal:165,p:31.0,f:3.6,  c:0,    ca:15,  ph:228},
  "White rice, boiled":  {kcal:130, p:2.7,  f:0.3,  c:28.2, ca:10,  ph:43},
  "Whole egg, boiled":   {kcal:155, p:12.6, f:10.6, c:1.1,  ca:50,  ph:172},
  "Potatoes, air-fried": {kcal:93,  p:2.5,  f:0.1,  c:21.0, ca:10,  ph:50},
};
// Solver reference foods
const RICE = DB["White rice, boiled"], CHK = DB["Chicken breast, boiled"];

// Resolved-nutrient registry: name -> per-100g base. Seeded with the built-in DB,
// extended at runtime by USDA lookups and AI parses. Keeps the deterministic core
// (DB) intact while allowing arbitrary foods.
const foodBase = Object.assign({}, DB);
const foodSource = {};                       // name -> 'USDA' | 'AI est' (DB entries omitted = built-in)
function getBase(name){ return foodBase[name] || DB[name]; }

let ledger = [];
let pending = [];                            // AI-parsed items awaiting review
let _prevLedgerLen = 0;                      // for flashing newly-added ledger rows

// ---- KEYS (localStorage; never exported) ----
const LS = { usda:'ledger_usda_key', gem:'ledger_gemini_key', model:'ledger_gemini_model',
             or:'ledger_openrouter_key',
             supaUrl:'ledger_supa_url', supaKey:'ledger_supa_key', pass:'ledger_sync_pass' };
// USDA food search needs a personal key — free, unbilled, per-key throttled (1,000
// req/hr). No shared default is embedded: data.gov deactivates any key committed to a
// public repo, so each user pastes their own in Settings (fdc.nal.usda.gov/api-key-signup).
// Built-in sync backend. The publishable key is public by design (anon role only);
// rows are unguessable 256-bit ids holding client-side-encrypted blobs, so the only
// per-user secret is the passphrase. Settings can override both for self-hosted forks.
const SUPA_DEFAULT_URL = 'https://rekcgerktrykotwzppkz.supabase.co';
const SUPA_DEFAULT_KEY = 'sb_publishable_adWOcEpQyprhtOBpjSLS7A_sYW58wkX';
function getKey(k){ try { return localStorage.getItem(k) || ''; } catch(e){ return ''; } }
function setKey(k,v){ try { v ? localStorage.setItem(k,v) : localStorage.removeItem(k); } catch(e){} }
function usdaKey(){ return getKey(LS.usda); }
function hasUSDA(){ return !!usdaKey(); }
function hasGemini(){ return !!getKey(LS.gem); }
function hasOR(){ return !!getKey(LS.or); }
function hasAI(){ return hasGemini() || hasOR(); }
function geminiModel(){ return getKey(LS.model) || 'gemini-3.5-flash-lite'; }

// Calendar date in Pakistan Standard Time (UTC+5, no DST) so the day rolls over at
// local midnight, not 05:00. Shift the epoch by the offset, then read the UTC date part.
const TZ_OFFSET_MIN = 5 * 60;
function dateStr(){ return new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0,10); }
// The LOGICAL ledger day is decoupled from the wall clock so eating that runs past
// midnight still lands on the day it belongs to. It only advances when the user closes
// the day — never automatically at 00:00. Defaults to today's calendar date on first run.
let ACTIVE_DATE = (()=>{ try{ return localStorage.getItem('ledger_active_date') || dateStr(); }catch(e){ return dateStr(); } })();
// VIEW_DATE is the day currently on screen and being edited. Normally it tracks
// ACTIVE_DATE (the live day); clicking a heatmap/history day retargets it so past
// days can be viewed and backfilled. Not persisted — a reload returns to the live day.
let VIEW_DATE = ACTIVE_DATE;
// UTC-based so it stays consistent with dateStr() (which is toISOString/UTC). Parsing
// "YYYY-MM-DDT00:00:00" as LOCAL time would shift the UTC date in +offset zones and,
// combined with +1 day, could return the SAME date — leaving the day unable to advance.
function nextDay(ds){ const [y,m,d]=ds.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate()+1); return dt.toISOString().slice(0,10); }
// Persistence: no-op-safe. In a real host these use localStorage; in-sandbox they may throw.
// Keyed on VIEW_DATE so edits land on whichever day is on screen (usually the live day).
function save(){
  try{ localStorage.setItem('ledger_'+VIEW_DATE, JSON.stringify(ledger)); }catch(e){}
  stampSyncMeta(VIEW_DATE); scheduleSync();    // mark this day edited now; sync (if configured) follows
}
function load(){ ledger=[]; try{ const r=localStorage.getItem('ledger_'+VIEW_DATE); if(r)ledger=JSON.parse(r);}catch(e){} }

// Retarget the screen to a different day (day arrows, heatmap, history) or back
// to the live day. Never past the live day — there is nothing to log in the future.
function viewDay(ds, keepTab){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) || ds === VIEW_DATE) return;
  if (ds > ACTIVE_DATE) return;
  VIEW_DATE = ds;
  load(); updateDayLabel();
  if (keepTab) render();
  else showTab('today');   // editing usually happens on the Today view (also renders)
}

// Close the running day and open the next one. The new day is whichever is later:
// the current calendar date, or the day after the one being closed (so closing early
// in the evening still opens tomorrow, and closing at 1am opens today).
async function closeDay(){
  if (VIEW_DATE !== ACTIVE_DATE) return;     // only the live day can be closed (button is hidden anyway)
  const t = totals();
  const open = ACTIVE_DATE;
  const nd = [dateStr(), nextDay(ACTIVE_DATE)].sort().pop();   // max of the two dates
  const ok = await confirmSheet({
    title: `Close ${open}?`,
    body: `${ledger.length} ${ledger.length === 1 ? 'item' : 'items'}, ${Math.round(t.kcal)} kcal logged. ` +
          `${nd} starts fresh and this day moves to history.`,
    confirmLabel: 'Close day'
  });
  if (!ok) return;
  save();                                    // seal the day being closed
  const digest = dayDigest(open, t);         // verdict computed BEFORE the ledger swaps out
  ACTIVE_DATE = VIEW_DATE = nd;
  try{ localStorage.setItem('ledger_active_date', ACTIVE_DATE); }catch(e){}
  load();                                    // load anything already stored for the new day (usually empty)
  updateDayLabel(); render();
  showDigest(digest);
}
// The end-of-day verdict: where the closed day landed, and the running streak.
// Closing the day is the ritual moment — reward it with a reading, not silence.
function dayDigest(date, t){
  const kcalV = t.kcal > CEIL ? `ceiling breach +${Math.round(t.kcal-CEIL)}`
              : t.kcal >= FLOOR ? 'landed in corridor'
              : `${Math.round(FLOOR-t.kcal)} kcal below floor`;
  const pShort = Math.max(0, P_TARGET - t.p);
  const pV = pShort <= 0.5 ? `protein ${t.p.toFixed(0)}g ✓` : `protein ${t.p.toFixed(0)}g — ${pShort.toFixed(0)}g short`;
  // Streak of ok days ending at the closed day (allDays already has it saved).
  const byDate = {}; allDays(true).forEach(d=>{ byDate[d.date] = totalsOf(d.ledger); });
  byDate[date] = t;
  let streak = 0;
  for (let d = date; byDate[d]; d = prevDayStr(d)){
    if (dayOk(byDate[d])) streak++; else break;
  }
  const ok = t.kcal >= FLOOR && t.kcal <= CEIL && pShort <= 0.5;
  return { date, ok, kcal: Math.round(t.kcal), kcalV, pV, streak };
}
function prevDayStr(ds){ const [y,m,d]=ds.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate()-1); return dt.toISOString().slice(0,10); }
function showDigest(g){
  const el = document.getElementById('digestCard');
  el.hidden = false;
  el.className = 'notice ' + (g.ok ? 'good' : 'warn');
  el.querySelector('.dg-main').innerHTML =
    `<b>${g.date} closed</b> — ${g.kcal} kcal, ${escapeHtml(g.kcalV)} · ${escapeHtml(g.pV)}` +
    (g.streak > 1 ? ` · <b>${g.streak}-day streak</b>` : g.ok ? ' · streak starts here' : '');
}
document.getElementById('digestClose').onclick = ()=>{ document.getElementById('digestCard').hidden = true; };

// ---- the day label, which is also the day control --------------------------
// Shows the day on screen. When the live day trails the wall clock it is still
// "open" from an earlier calendar date — flagged, so the state isn't a surprise.
// Viewing a PAST day raises a banner so edits don't silently land in history.
const DAY_FMT = { weekday:'short', day:'2-digit', month:'short' };
function prettyDate(iso){
  try {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, DAY_FMT);
  } catch(e){ return iso; }
}
function updateDayLabel(){
  const el = document.getElementById('dayLabel');
  const past = VIEW_DATE !== ACTIVE_DATE;
  const openEarly = !past && ACTIVE_DATE < dateStr();
  el.textContent = (VIEW_DATE === dateStr() ? 'Today' : prettyDate(VIEW_DATE)) + (openEarly ? ' · open' : '');
  el.classList.toggle('day-open', openEarly);
  el.title = VIEW_DATE;

  // You can always step back; stepping forward stops at the live day.
  document.getElementById('dayNext').disabled = VIEW_DATE >= ACTIVE_DATE;

  const ban = document.getElementById('pastBanner');
  ban.hidden = !past;
  if (past) document.getElementById('pastBannerDate').textContent = prettyDate(VIEW_DATE);
  // Only the live day can be closed; backup and reset still apply to a past day.
  document.getElementById('closeDayBtn').hidden = past;
}
