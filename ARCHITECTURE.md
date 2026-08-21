# Ledger — Macro Tracker: Architecture Overview

A single-user **Progressive Web App** for tracking food, bodyweight, strength
training, body measurements, and supplements against a hard calorie "corridor".
It is deliberately **deterministic**: the nutrition and training math is plain,
testable arithmetic, and any AI/network use is confined to *resolving* data
(looking a food up, reading messy text), never to computing the numbers the app
acts on.

This document is a high-level map for someone (or another model) who needs to
understand what the app does and how it's put together, without reading all
~7,400 lines.

---

## 1. Stack & delivery

- **Vanilla JavaScript, no framework, no build step.** Plain `<script>` tags in
  `index.html`, loaded in dependency order. No bundler, no transpiler, no npm
  runtime deps. You can open `index.html` and it runs.
- **PWA**: `manifest.json` + `sw.js` service worker. Installable, works offline.
  The service worker cache-firsts the app shell and stale-while-revalidates
  Google Fonts; it never caches API traffic.
- **Hosting**: static files served from GitHub Pages off the `main` branch under
  the `/macros-tracker/` path. "Deploy" = merge to `main`.
- **Cache versioning**: `sw.js` has a `const CACHE = 'ledger-vNN'`. **Every code
  change must bump this number** or installed clients keep serving old files.
  On version bump the SW drops old caches and re-fetches the shell with
  `cache: 'reload'` (this bypasses GitHub Pages' 10-min HTTP cache, which
  otherwise silently reinstalls stale bytes).
- **Storage**: browser `localStorage` only (no server DB). Optional end-to-end
  encrypted sync to Supabase for multi-device use.
- **Timezone**: hard-coded to Pakistan Standard Time (UTC+5, no DST) so the
  day rolls at local midnight. See `TZ_OFFSET_MIN` in `state.js`.

---

## 2. Module map

Scripts load in this order (later files depend on earlier ones); everything
shares one global scope — there are no ES modules.

| File | Role |
|------|------|
| **`core.js`** | The deterministic engine. **No DOM, no globals, no side effects** — every function takes inputs explicitly. Exposes `window.LedgerCore` and is `require()`-able under Node so the test suite exercises the exact code the app runs. All the real math lives here. |
| `js/state.js` | App-wide state & constants: the protocol defaults, live targets, the built-in food DB, API-key storage, and the **logical-day machinery** (view date / active date / close-day). |
| `js/compute.js` | Thin, DOM-free glue over `core.js`: per-entry math (`computeEntry`), day/history aggregates (`totals`, `allDays`, `closedDays`), the `solveFridge` solver, and `escapeHtml`. |
| `js/ui.js` | Shared UI primitives: status lines, spinners, toasts + undo, and the in-app bottom sheets that replace `alert`/`confirm`/`prompt`. Also `haptic()` and screen-reader `announce()`. |
| `js/food.js` | Food resolution: the picker registry, USDA lookup, the AI parsers (Gemini + OpenRouter fallback), the pending-review queue, and meal photos. |
| `js/today.js` | The **Today** view *and* the central `render()` dispatcher. The corridor instrument, pace steering, macro rows, micronutrients, the entry ledger, and one-tap repeats. |
| `js/plan.js` | The **Plan** view: supplement cycles + dose log, gap-closing meal combos, and the ternary "meal engineer" widget. |
| `js/trends.js` | The **Trends** view: history, rolling averages, compliance heatmap, weight/TDEE/goal, the fat-change estimate, and the weekly report card. |
| `js/lift.js` | The **Lift** view: workout logging (parse → confirm → commit), progression trends, the catalogue/alias map, the rest timer, and the "last time" preview. |
| `js/logs.js` | The **Logs** view: the day's manual entries — weigh-in, body measurements (+ U.S. Navy body-fat estimate), and the supplement dose strip. |
| `js/sync.js` | End-to-end-encrypted multi-device sync over Supabase + WebCrypto. Server only ever stores ciphertext. |
| `js/app.js` | Boot, wiring, tab control, Settings, import/export, service-worker registration. |

`tests.html` is a standalone in-browser test runner that locks `core.js`'s
deterministic functions.

---

## 3. Data model & storage

Everything is `localStorage`, keyed by day where it makes sense. The unifying
idea: **each day is its own record**, so two devices editing different days
merge cleanly (per-day last-write-wins), and one day's edit can never clobber
another.

Key families:

- `ledger_YYYY-MM-DD` — the food entries for that day (an array of entry objects).
- `ledger_workout_YYYY-MM-DD` — that day's training session `{date, split, exercises:[{id,name,sets:[{kg,reps,bw}],rir}]}`.
- `ledger_weights` / `ledger_measures` — weigh-ins and body measurements as `{date: value}` maps.
- `ledger_supp_log` — supplement doses taken, `{date: [ids]}`.
- `ledger_exercises` — the exercise catalogue + aliases (the map that keeps one lift on one trend line).
- `ledger_supps` — supplement protocol definitions.
- `ledger_targets` — the full settings bundle: corridor, protein/carb/fat targets, goal, meal plan, training schedule, body profile, maintenance band.
- `*_meta` / `*_updated` keys — per-record timestamps that drive last-write-wins during sync.
- `ledger_active_date` — which logical day is "live".
- API keys & sync passphrase (`ledger_usda_key`, `ledger_gemini_key`, `ledger_openrouter_key`, `ledger_sync_pass`, …) — **never exported, never synced.**

### The logical day (important, non-obvious)

The "day" the app is logging is **decoupled from the wall clock**:

- `ACTIVE_DATE` — the live logical day. It only advances when the user
  explicitly **closes the day**, never automatically at midnight. This lets
  eating that runs past midnight land on the day it belongs to.
- `VIEW_DATE` — the day currently on screen / being edited. Usually tracks
  `ACTIVE_DATE`, but clicking a past day in the heatmap/history retargets it so
  history can be viewed and backfilled. Not persisted (a reload returns to the
  live day).
- Closing a day seals it, computes an end-of-day "digest" verdict (corridor hit?
  protein hit? current streak), and opens the next day fresh.

---

## 4. The deterministic core (`core.js`)

This is the heart of the app and the reason it exists. It's a pure library
(returns one big object of functions) covering:

- **Nutrition**: `computeEntry` (per-entry macros with unweighed-food penalties
  applied), USDA nutrient extraction, macro completion, free-sugar estimation,
  micronutrient references.
- **The solver**: `solveFridge` — given a day's running totals, solve for grams
  of rice + chicken to *land at* the calorie floor with protein as a *floor*
  constraint (equality on kcal, inequality on protein — the distinction avoids
  false "impossible" flags). Plus `budgetCombos`, food ranking/scoring.
- **Energy balance**: Mifflin–St Jeor BMR, **adaptive TDEE calibration** from
  weight-change vs. intake, corridor derivation from TDEE, meal-pace budgeting.
- **Body composition**: U.S. Navy body-fat from measurements, weight/measure
  trend fitting.
- **Training**: `e1RM` (estimated 1-rep max), `sessionMetrics`, `exerciseTrend`
  (the progression verdict engine), `liftVsWeight` (the recomp cross-reference),
  exercise name normalization/matching, and `parseWorkout` (the free-text set
  grammar).
- **Sync**: `mergeSyncStates` (per-day LWW merge).
- **Ternary geometry**: barycentric math for the meal-engineer widget.
- Shared stats helpers: `linearTrend`, `median`, robust JSON repair for AI output.

Everything else in the app is UI and storage glue around these functions.

---

## 5. Rendering model

- One global `render()` (in `today.js`) is the single entry point. It resolves
  the adaptive corridor and protein target, refreshes cross-tab chrome, then
  **rebuilds only the active tab** (`ACTIVE_TAB`) — not all views.
- Rendering is old-school: build an HTML string, set `innerHTML`, re-bind event
  handlers. No virtual DOM, no reactivity. State changes call `render()`.
- **All user/AI/USDA/import text is passed through `escapeHtml` before it
  touches `innerHTML`** — food names are the one attacker-shapeable field and
  `localStorage` holds the sync passphrase + API keys, so an unescaped name
  would be a credential-theft XSS. This is a load-bearing invariant.
- Tabs live in a slide-out drawer (not a bottom bar — the bottom edge belongs to
  the meal composer). Tabs: **Today, Logs, Plan, Lift, Trends**, plus Settings.

---

## 6. The five tabs

**Today** — the primary instrument. A calorie "corridor" (a floor and a ceiling,
not a single target) rendered as a gauge; only out-of-tolerance states carry
colour. A pace marker steers intake across the day against a meal plan. Macro
rows (protein as a floor, optional carb/fat caps), micronutrients, the entry
ledger, and one-tap "repeat" chips mined from past *meals* (not ingredients).
The micronutrient panel has an averaging-window selector — Today / Week /
2 Wks / Month (weekly is the default) — so a nutrient that is *consistently*
short reads apart from a single off day. `LedgerCore.microAverages` divides each
nutrient's window total by the number of **logged** days (a day never logged is
not a zero-intake day), which is deliberately how a rarely-taken supplement
surfaces as a low average.

**Logs** — the day's manual, non-food inputs: weigh-in, body measurements (which
feed the Navy body-fat estimate), and the supplement dose strip. Writes to
`VIEW_DATE`, syncs per-day.

**Plan** — supplement protocols (alternate-day cycles + dose scheduling),
gap-closing meal combinations to hit the remaining budget, and a **ternary meal
engineer**: an interactive equilateral-triangle widget for balancing three foods
against a calorie target with a protein-floor "green zone" overlay.

**Lift** — free-text workout logging ("bench 60kg 8, 8, 6 rir 2"), parsed by a
grammar in `core.js` (with an AI fallback only for lines the grammar can't read).
Each lift is tracked on a **progression trend** with a verdict (progressing /
grinding / stalled / effort-drift / regressing) judged on estimated-1RM (or work
capacity for high-rep work), with confidence earned from the data. An exercise
catalogue with aliases keeps one lift on one trend line, and a **metadata seed**
(`EXERCISE_META`) gives each catalogue lift its muscles, movement pattern,
equipment and loading class. Also:
  - a live **"last time" preview** (previous session's top set as you type a name);
  - a **rest timer** whose duration is set by the movement's class (compound
    ~150 s, isolation ~90 s), persisted so it survives the app being backgrounded;
  - a non-blocking **load-jump guardrail** at review time (flags a big weekly load
    increase vs recent history, e.g. a machine jump over ~10 %/week);
  - a **fatigue readout** per exercise (within-set rep drop-off at a fixed load —
    a rest-adequacy signal);
  - **warm-up set** toggling (tap a set chip) so warm-ups leave volume, top set,
    e1RM and fatigue untouched;
  - a **deload** marker on the session, which keeps a deliberate light week out of
    every lift's trend fit so it doesn't read as regression;
  - **AI categorisation** — a one-tap pass in the Exercises catalogue that sends the
    still-untagged lift names to the AI and gets back muscles + movement pattern,
    validated against the app's fixed muscle vocabulary (`cleanCategory`) and shown
    for confirmation before applying. Like every AI use here it only *resolves*
    names to metadata; the volume math stays deterministic.
Trend identity is keyed by exercise **and** equipment, so the same movement under
different equipment does not share one line. The Exercises catalogue also lets each
lift's muscle/pattern be set or corrected by hand.

**Trends** — history and rolling averages, a compliance heatmap, the
weight/TDEE/goal picture, an adaptive fat-change estimate, and a **recomp card**
that cross-references strength against bodyweight (and waist, when available) —
the reading a pure lifting app can't produce because it doesn't know what you ate.
Plus two data-driven panels:
  - **Data quality** — intake coefficient-of-variation, the earned confidence tier
    of the adaptive TDEE, the disagreement between the weight-trend and formula
    estimates, and a per-signal "how much to trust the reads" checklist. Input
    quality is made visible rather than hidden behind a single number.
  - **Volume per muscle** — weekly fractional working-sets per muscle group (from
    the exercise metadata), with training frequency, the gaps between sessions
    that hit each muscle, optional per-muscle targets, and a prompt for any
    exercise still lacking a muscle tag (pooled, never silently dropped).

---

## 7. External integrations (all optional, all user-keyed)

The app is fully functional offline with its built-in food DB. These extend it,
and each requires the user to paste their own key in Settings:

- **USDA FoodData Central** — food nutrient lookup. Free personal key
  (data.gov deactivates any key committed to a public repo, so no shared default
  is embedded).
- **AI parsing (Gemini, with OpenRouter as fallback)** — used *only* to resolve
  things the deterministic path can't: reading a free-text meal into structured
  foods, reading a photo of a meal, or reading a workout line the grammar
  rejected. **The AI never computes calories or verdicts** — every number it
  returns is shown for confirmation before it's committed, and it's told to
  transcribe only, never to total or invent.
- **Supabase** — the sync backend (see below). A publishable anon key is built
  in; it's public by design.

---

## 8. Sync

Optional, end-to-end encrypted, off by default:

- Identity is **a passphrase**. PBKDF2 derives 512 bits: half becomes an
  unguessable row id, half an AES-GCM key. Same passphrase anywhere = same
  account. No login, no email.
- **The server only ever stores ciphertext.** The Supabase anon key and row ids
  give no access to plaintext; the passphrase is the only secret and never
  leaves the device.
- Every sync is **pull → merge → push**, using `mergeSyncStates` for per-day
  last-write-wins, so a push can never clobber a day it hasn't seen.
- All failures degrade gracefully to offline-only.

---

## 9. Key domain concepts (glossary)

- **Corridor** — intake target expressed as a floor + ceiling, not a point. The
  goal is to *land inside*, and being inside is shown in plain colour (an
  instrument doesn't light up when it's fine).
- **Adaptive TDEE / Goal** — when a goal (cut / maintain / lean bulk / custom) is
  active, the corridor is derived each day from a calibrated TDEE (learned from
  weight change vs. logged intake) plus an offset, rather than from hand-entered
  numbers. The manual base is preserved and never overwritten.
- **Penalties** — an unweighed (estimated-portion) food entry has its **energy
  inflated by `INFLATE` (default +10%) and its protein deducted by `DEDUCT`
  (default −10%)**, biasing against the optimistic error of eyeballed portions
  (`computeEntry` in `core.js`). Both coefficients are user-configurable in
  Settings (stored as `penK`/`penP`); a weighed entry is untouched. The applied
  adjustment is shown on the entry as a flag.
- **e1RM** — estimated one-rep max, the strength metric lift trends are judged on
  at low reps; past a rep cap the app switches to "work capacity" and says so.
- **RIR** — reps-in-reserve; only its *change* over time is read, so a consistent
  personal bias cancels out.
- **Recomp verdict** — strength × bodyweight (× waist) → building / spinning /
  retaining / shedding / recomping / holding.
- **Close day** — the explicit ritual that seals the live day, emits a verdict,
  and advances the logical day.

---

## 10. Conventions for changing the code

- Put real math in `core.js` (pure, tested); keep DOM and storage out of it.
- Escape every externally-sourced string before `innerHTML`.
- Anything per-day should carry a `*_meta`/`*_updated` timestamp so sync merges it.
- **Bump `CACHE` in `sw.js` on every shippable change**, or clients won't update.
- Deploy = merge to `main` (GitHub Pages). There is no CI/build.
