// core.js — Ledger's deterministic math, extracted so it can be locked by tests.
// No DOM, no globals, no side effects: every function takes its inputs explicitly.
// Loads as a plain <script> in the app (exposes window.LedgerCore) and is require()-able
// under Node, so the same code the app runs is the code the tests exercise.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LedgerCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- USDA energy pick ----------------------------------------------------
  // Per-100g nutrients keyed by USDA nutrient number: 208 kcal, 203 protein,
  // 204 fat, 205 carb, 301 calcium(mg), 305 phosphorus(mg), 957/958 Atwater, 268 kJ.
  function nutrientsFrom(food) {
    const m = {};
    (food.foodNutrients || []).forEach(n => {
      const num = n.nutrientNumber || (n.nutrient && n.nutrient.number);
      if (num != null) m[String(num)] = n.value != null ? n.value : (n.amount || 0);
    });
    const g = num => Number(m[num] || 0);
    const p = g('203'), f = g('204'), c = g('205');
    // Prefer Atwater factors (reliable on Foundation foods) over #208, which USDA
    // sometimes ships as a bogus low placeholder — e.g. "Potatoes, gold, raw" reports
    // #208 = 5 kcal while #957 = 73.5. Fall back to #208, then kJ. Finally, if the
    // chosen value is implausibly low versus the macro-derived estimate, trust macros.
    let kcal = g('957') || g('958') || g('208') || (g('268') ? g('268') / 4.184 : 0);
    const est = 4 * c + 4 * p + 9 * f;
    if (est > 0 && kcal < est * 0.5) kcal = est;
    // Micronutrients (per 100g), keyed by USDA nutrient number:
    //   291 fiber(g) · 269 sugars(g) · 307 sodium · 306 potassium · 301 calcium ·
    //   304 magnesium · 303 iron · 309 zinc (mg) · 401 vitamin C(mg) · 328 vitamin D(µg).
    return { kcal, p, f, c, ca: g('301'), ph: g('305'), fib: g('291'), sug: g('269'), na: g('307'),
             k: g('306'), mg: g('304'), fe: g('303'), zn: g('309'), vc: g('401'), vd: g('328') };
  }

  // ---- Target resolution ---------------------------------------------------
  // Protein floor and macro caps may be a fixed gram value or a % of the calorie
  // floor (carbs/protein at 4 kcal/g, fat at 9). These convert to grams.
  function resolvePTarget(pCfg, floor) {
    return pCfg.mode === 'pct' ? pCfg.val / 100 * floor / 4 : pCfg.val;
  }
  function capGrams(cap, kcalPerG, floor) {
    if (!cap.val) return 0;
    return cap.mode === 'pct' ? cap.val / 100 * floor / kcalPerG : cap.val;
  }

  // ---- Per-entry contribution with penalties -------------------------------
  // base = per-100g nutrients; pen = {inflate, deduct, oilK, oilF}. source tags
  // provenance so AI estimates read as provisional.
  function computeEntry(name, grams, weighed, isCurry, halfOil, base, source, pen) {
    const s = grams / 100;
    const e = {
      name, grams, weighed, isCurry, halfOil, base, source: source || 'DB',
      kcal: base.kcal * s, p: base.p * s, f: base.f * s,
      c: (base.c || 0) * s, ca: (base.ca || 0) * s, ph: (base.ph || 0) * s,
      fib: (base.fib || 0) * s, sug: (base.sug || 0) * s, na: (base.na || 0) * s,
      k: (base.k || 0) * s, mg: (base.mg || 0) * s, fe: (base.fe || 0) * s,
      zn: (base.zn || 0) * s, vc: (base.vc || 0) * s, vd: (base.vd || 0) * s, flags: []
    };
    if (!weighed) {
      e.kcal *= pen.inflate; e.p *= pen.deduct;
      e.flags.push(`+${Math.round((pen.inflate - 1) * 100)}% kcal / −${Math.round((1 - pen.deduct) * 100)}% P`);
    }
    if (isCurry && !weighed) {
      const mult = halfOil ? 0.5 : 1;
      e.kcal += pen.oilK * mult; e.f += pen.oilF * mult;
      e.flags.push(`+${mult} tbsp oil tax`);
    }
    if (e.source === 'AI est') e.flags.push('AI-estimated nutrition — provisional');
    return e;
  }

  // ---- Fridge solver: rice(r) + chicken(k) grams to LAND at floor kcal ------
  // kcal-to-floor is an equality (land at floor, don't overshoot toward ceiling);
  // protein-to-target is a FLOOR (>= fine). Returns numeric r/k/kOnly alongside msg
  // so tests can assert on the numbers, not the prose.
  function solveFridge(t, cfg) {
    const { floor, ceil, pTarget, rice, chk } = cfg;
    const kcalGap = floor - t.kcal;
    if (kcalGap <= 0) {
      return { status: 'done', kcalGap,
        msg: `Floor already met (${Math.round(t.kcal)} kcal). No fill needed — ${Math.round(ceil - t.kcal)} kcal ceiling headroom.` };
    }
    const rk = rice.kcal / 100, rp = rice.p / 100;
    const ck = chk.kcal / 100, cp = chk.p / 100;
    const pGap = Math.max(pTarget - t.p, 0);
    const det = rk * cp - ck * rp;

    const r = (kcalGap * cp - ck * pGap) / det;
    const k = (rk * pGap - kcalGap * rp) / det;
    if (r >= 0 && k >= 0) {
      const vp = t.p + rp * r + cp * k;
      return { status: 'ok', r, k, vp,
        msg: `<span class="ok">${Math.round(r)}g rice + ${Math.round(k)}g chicken</span> → lands ${floor} kcal exactly, protein ${vp.toFixed(0)}g.` };
    }
    const kOnly = kcalGap / ck;
    const pAfter = t.p + kOnly * cp;
    if (pAfter >= pTarget) {
      return { status: 'ok', r: 0, k: kOnly, vp: pAfter,
        msg: `<span class="ok">${Math.round(kOnly)}g chicken, no rice</span> → lands ${floor} kcal, protein ${pAfter.toFixed(0)}g (floor cleared).` };
    }
    const shortfall = pTarget - pAfter;
    return { status: 'conflict', kOnly, pAfter, shortfall,
      msg: `<span class="conflict">Protein floor unreachable via fridge.</span> ` +
        `${Math.round(kOnly)}g chicken closes kcal but leaves protein at ${pAfter.toFixed(0)}g — ` +
        `${shortfall.toFixed(0)}g short. The kcal ceiling binds first; take protein from a leaner source or accept the gap.` };
  }

  // ---- Budget combos: pairs of foods that close (remKcal, remP) -------------
  // foods = [[name, {kcal,p,...}], ...]. Returns combos sorted best-first (low score).
  // Score prefers balanced portions; a 0.5g tolerance stops exact protein solutions
  // being falsely penalized by float error.
  function budgetCombos(foods, remKcal, remP) {
    const combos = [];
    for (let i = 0; i < foods.length; i++) {
      for (let j = i + 1; j < foods.length; j++) {
        const [nameA, a] = foods[i], [nameB, b] = foods[j];
        const ak = a.kcal / 100, ap = a.p / 100;
        const bk = b.kcal / 100, bp = b.p / 100;
        const det = ak * bp - bk * ap;
        if (Math.abs(det) < 0.001) continue;            // linearly dependent
        const targetP = Math.max(remP, remKcal * 0.05); // ask for at least some protein
        const gA = (remKcal * bp - bk * targetP) / det;
        const gB = (ak * targetP - remKcal * ap) / det;
        if (gA < 20 || gB < 20) continue;               // both must be real servings
        if (gA > 1500 || gB > 1500) continue;           // nothing absurd
        const totalKcal = ak * gA + bk * gB;
        const totalP = ap * gA + bp * gB;
        combos.push({
          nameA, nameB, gA: Math.round(gA), gB: Math.round(gB),
          kcal: Math.round(totalKcal), p: Math.round(totalP),
          score: Math.abs(gA - gB) + (totalP < remP - 0.5 ? 500 : 0)
        });
      }
    }
    combos.sort((a, b) => a.score - b.score);
    return combos;
  }

  // ---- USDA candidate ranking ----------------------------------------------
  // USDA relevance often floats processed/composite entries to the top for a generic
  // query ("banana" → dehydrated powder; "white rice" → "Beans and white rice"). Down-rank
  // those so the default match is the plain food; the user can still override in the picker.
  const JUNK = ['dehydrated', 'powder', 'dried', ' juice', 'nectar', 'concentrate', 'baby', 'infant',
    'breaded', 'chips', 'paste', 'butter', ' oil', 'flour', 'lunchmeat', ' roll', 'pudding', 'split',
    'sauce', 'gravy', 'soup', 'flavored', 'salted', 'sweetened', 'smoked', ' and ', ' with '];
  function scoreFood(name, ql) {
    const d = ' ' + name.toLowerCase() + ' ';
    let s = 0;
    JUNK.forEach(tok => { if (d.includes(tok) && !ql.includes(tok.trim())) s -= 12; });
    if (/\braw\b/.test(d)) s += 6;
    if (/\bnfs\b/.test(d)) s += 4;                 // "not further specified" = the generic form
    s -= Math.max(0, name.split(/[ ,]+/).filter(Boolean).length - 3);  // prefer concise entries
    // Every query word present in the candidate name = a real match on what was asked
    // for, not a keyword cousin ("cooking oil" must beat "Oil, plantain").
    const words = ql.split(/[^a-z]+/).filter(w => w.length > 2);
    if (words.length && words.every(w => d.includes(w))) s += 8;
    return s;
  }
  // estKcal (optional) = a trusted per-100g calorie prior, e.g. the AI's estimate for the
  // ingredient. Candidates whose energy density is wildly off that prior get down-ranked
  // on a log scale: 100 vs 880 kcal is punished hard, 165 vs 200 barely at all.
  function rankFoods(foods, query, estKcal) {
    const ql = ' ' + (query || '').toLowerCase() + ' ';
    return foods.map((f, i) => {
      let s = scoreFood(f.name, ql);
      const k = f.base && f.base.kcal;
      if (estKcal > 0 && k > 0) s -= Math.min(24, 8 * Math.abs(Math.log(k / estKcal)));
      return { f, s, i };
    })
      .sort((a, b) => b.s - a.s || a.i - b.i)      // best score first; USDA relevance breaks ties
      .map(x => x.f);
  }
  // Given ranked candidates and a trusted AI per-100g calorie prior, decide the DEFAULT
  // pick. USDA sometimes returns the wrong food entirely — a generic "water" at 40 kcal,
  // a cousin ingredient — and ranking alone can still float it to the top. When the best
  // match's energy density is implausibly far from the prior, prefer the highest-ranked
  // candidate that DOES land near it; if none do, trust the AI estimate over a clearly
  // wrong match. Returns 'u<index>' for candidates[index], or 'est' for the AI estimate.
  const SEL_LN_TOL = Math.log(1.8);   // >1.8x or <0.55x off the prior = wrong food, not mere imprecision
  function defaultSelection(ranked, estKcal) {
    if (!ranked || !ranked.length) return 'est';
    if (!(estKcal > 0)) return 'u0';                    // no prior to judge against — keep top match
    const within = f => { const k = f.base && f.base.kcal; return k > 0 && Math.abs(Math.log(k / estKcal)) <= SEL_LN_TOL; };
    if (within(ranked[0])) return 'u0';                 // best match already plausible
    const i = ranked.findIndex(within);                 // else the best candidate that is plausible
    if (i >= 0) return 'u' + i;
    return 'est';                                       // nothing plausible — estimate beats a wrong match
  }

  // ---- Body-fat change estimate ----------------------------------------------
  // Energy-balance rule of thumb: ~7700 kcal ≈ 1 kg of body fat. Maintenance isn't a
  // single number (activity and metabolism vary), so the caller passes a band and the
  // result is a band too: the LOW maintenance bound produces the largest surplus (most
  // fat gained), the HIGH bound the least. intakes = per-day kcal for days actually
  // logged (untracked days are the caller's job to exclude). Positive kg = gained.
  const KCAL_PER_KG_FAT = 7700;
  function fatEstimate(intakes, maintLow, maintHigh) {
    const n = intakes.length;
    const sum = intakes.reduce((a, b) => a + (+b || 0), 0);
    const lo = Math.min(maintLow, maintHigh), hi = Math.max(maintLow, maintHigh);
    const kcalHigh = sum - lo * n;               // lower maintenance ⇒ bigger surplus
    const kcalLow = sum - hi * n;
    return { n, sum, kcalLow, kcalHigh, kgLow: kcalLow / KCAL_PER_KG_FAT, kgHigh: kcalHigh / KCAL_PER_KG_FAT };
  }

  // ---- TDEE: resting burn (Mifflin-St Jeor) + adaptive calibration -----------
  // Mifflin-St Jeor BMR (kcal/day), the modern standard. sex 'female' uses the −161
  // constant, anything else the male +5. Multiply by an activity factor for TDEE.
  function bmrMifflin(sex, kg, cm, age) {
    if (!(kg > 0) || !(cm > 0) || !(age > 0)) return 0;
    const s = sex === 'female' ? -161 : 5;
    return 10 * kg + 6.25 * cm - 5 * age + s;
  }
  // Blend the formula TDEE with what the logs actually reveal. Energy balance says a
  // steady weight change at a known average intake pins maintenance directly:
  //   dataTDEE = avgIntake − (weightChange in kcal). ratePerWeek(kg) × 7700 / 7 = kcal/day.
  // Confidence w ramps 0→1 as the sample grows from 7 to 28 days, so the number leans on
  // the formula early and on measured reality as the history accumulates — recalibrating
  // every day. Needs a real weight trend and some logged intake, else it's formula-only.
  function calibrateTDEE(formula, avgIntake, ratePerWeek, sampleDays) {
    const hasData = avgIntake > 0 && sampleDays >= 7 && ratePerWeek != null;
    const dataTDEE = hasData ? avgIntake - (ratePerWeek / 7) * KCAL_PER_KG_FAT : null;
    const w = hasData ? Math.max(0, Math.min(1, (sampleDays - 7) / 21)) : 0;
    const formulaN = formula > 0 ? formula : (dataTDEE || 0);
    const blended = dataTDEE != null ? Math.round(w * dataTDEE + (1 - w) * formulaN) : Math.round(formulaN);
    return { formula: Math.round(formulaN), dataTDEE: dataTDEE != null ? Math.round(dataTDEE) : null, blended, w };
  }
  // Derive a calorie corridor from a maintenance (TDEE) number and a goal offset:
  //   cut −500, maintain 0, lean bulk +300, etc. The band is the ± half-width around the
  //   target centre. Rounded to the nearest 25 so the daily targets read cleanly and small
  //   TDEE wobble doesn't reprint the numbers. floor/ceil are what the corridor shows.
  function corridorFromTDEE(tdee, offset, band) {
    const r = x => Math.round(x / 25) * 25;
    const center = tdee + offset;
    return { floor: r(center - band), ceil: r(center + band), center };
  }
  // Bracketed intake pace: expected calories consumed by a given hour-of-day given a meal
  // plan. Each meal ramps over a 1-hour window centred on its time, so the curve sits flat
  // between meals and steps up around each — matching a real eating rhythm instead of a
  // straight line. meals = [{h: hoursOfDay, kcal}]. Returns raw kcal (caller scales it).
  function mealPaceKcal(nowH, meals) {
    let s = 0;
    (meals || []).forEach(m => {
      s += (m.kcal || 0) * Math.max(0, Math.min(1, (nowH - (m.h - 0.5)) / 1));
    });
    return s;
  }
  // Flag a micronutrient total against its daily reference. Nutrients you want to REACH
  // (fiber, potassium…): 'ok' ≥100%, 'low' ≥60%, 'verylow' below. Nutrients that are a
  // LIMIT (sodium, sugar): 'over' >100%, 'near' ≥80%, else 'ok'.
  function microStatus(value, target, isLimit) {
    if (!(target > 0)) return 'na';
    const r = value / target;
    if (isLimit) return r > 1 ? 'over' : (r >= 0.8 ? 'near' : 'ok');
    return r >= 1 ? 'ok' : (r >= 0.6 ? 'low' : 'verylow');
  }

  // ---- Protein fix: cheapest way to close a protein gap ----------------------
  // foods = [[name, {kcal,p}], ...] per-100g. Returns single-food options that
  // deliver pGap grams of protein, sorted by calorie cost, filtered to what fits
  // the remaining kcal budget and a plausible single serving. The 9pm question:
  // "I still need 30g protein and only have 250 kcal of ceiling left — what works?"
  function proteinFix(foods, pGap, kcalBudget) {
    if (!(pGap > 0)) return [];
    return foods.map(([name, f]) => {
      if (!(f.p > 1)) return null;                        // not a protein source
      const grams = pGap / f.p * 100;
      const kcal = grams * f.kcal / 100;
      return { name, grams: Math.round(grams), kcal: Math.round(kcal),
               density: f.kcal > 0 ? f.p / f.kcal : Infinity };  // g protein per kcal
      })
      .filter(o => o && o.kcal <= kcalBudget + 0.5 && o.grams <= 700)
      .sort((a, b) => a.kcal - b.kcal);
  }

  // ---- Weight trend: kg/week from dated weigh-ins ----------------------------
  // entries = [{date:'YYYY-MM-DD', kg}] in ascending date order (gaps fine).
  // Least-squares slope over days ×7 → kg/week; the corridor's outcome check.
  // Null when there's nothing to fit (fewer than 2 points, or a single day).
  function weightTrend(entries) {
    if (!entries || entries.length < 2) return null;
    const t0 = Date.parse(entries[0].date + 'T00:00:00Z');
    const pts = entries.map(e => ({ x: (Date.parse(e.date + 'T00:00:00Z') - t0) / 86400000, y: e.kg }));
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n;
    const my = pts.reduce((s, p) => s + p.y, 0) / n;
    const den = pts.reduce((s, p) => s + (p.x - mx) * (p.x - mx), 0);
    if (den === 0) return null;
    const slope = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / den;
    return { ratePerWeek: slope * 7, latest: entries[n - 1].kg };
  }

  // ---- Salvage a truncated / unbalanced JSON reply --------------------------
  // Models do not always honour a strict-JSON response mode. Measured on this app's own
  // prompt: gemini-3.5-flash closes the items array but omits the outer brace, leaving
  //   {"items":[ {...} ]          ← no final }
  // with finishReason STOP — it is NOT length truncation, so raising maxOutputTokens does
  // not help. A first-brace-to-last-bracket regex can't fix it either: the slice ends at
  // ']' and is still invalid. So balance the brackets instead — walk the text tracking
  // string literals, then close whatever is still open. Also drops prose that trails a
  // complete object, and a dangling comma left by a cut-off item.
  // Returns the parsed value, or null when nothing salvageable is in there.
  function repairJson(s) {
    if (typeof s !== 'string') return null;
    const start = s.search(/[[{]/);
    if (start < 0) return null;
    const stack = [];
    let inStr = false, esc = false, end = -1;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (inStr && ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') { stack.pop(); if (!stack.length) { end = i; break; } }
    }
    let out;
    if (!stack.length && end >= 0) {
      out = s.slice(start, end + 1);                   // balanced already; trailing prose dropped
    } else {
      out = s.slice(start).replace(/[,\s]+$/, '');     // unbalanced: close what's still open
      if (inStr) out += '"';                           // reply cut mid-string
      while (stack.length) out += stack.pop();
    }
    try { return JSON.parse(out); } catch (e) { return null; }
  }

  // ---- Assistant digest: the facts an LLM is allowed to narrate --------------
  // The assistant must never do arithmetic — a language model asked "how was my week"
  // over raw ledger rows will confidently invent totals. So every number it can possibly
  // need is computed HERE, deterministically, and the model only gets the finished
  // figures. Raw entries ride along untouched for "what did I eat on the 14th" lookups,
  // never as something to add up.
  //
  // input = {
  //   today, open:{date,totals,entries}, days:[{date,totals,entries}] newest-first (closed),
  //   targets:{floor,ceil,protein,carbCap,fatCap,goalLabel,corridorAuto},
  //   weights:[{date,kg}] ascending, tdee:{...calibrateTDEE output}, supplements:[...],
  //   micros:[{name,value,target,unit,limit,status}], training:{split,isTraining} }
  // Everything is optional; missing inputs produce nulls the model is told to admit to.
  const DIGEST_WINDOWS = [7, 14, 30];
  function assistantDigest(input) {
    const inp = input || {};
    const t = inp.targets || {};
    const floor = +t.floor || 0, ceil = +t.ceil || 0, pTarget = +t.protein || 0;
    const days = (inp.days || []).slice().sort((a, b) => a.date < b.date ? 1 : -1);
    const tot = d => (d && d.totals) || { kcal: 0, p: 0, f: 0, c: 0 };
    const dayOk = d => {
      const x = tot(d);
      return x.kcal >= floor && (!ceil || x.kcal <= ceil) && x.p >= pTarget;
    };
    const avg = (arr, pick) => arr.length
      ? Math.round(arr.reduce((s, d) => s + (pick(tot(d)) || 0), 0) / arr.length * 10) / 10 : null;

    // Rolling windows over CLOSED days only — the open day is still being logged, so
    // folding it in would make every average drift as the user eats.
    const windows = {};
    DIGEST_WINDOWS.forEach(n => {
      const w = days.slice(0, n);
      const overCeil = w.filter(d => ceil && tot(d).kcal > ceil).map(d => d.date);
      const underFloor = w.filter(d => floor && tot(d).kcal < floor).map(d => d.date);
      const missedP = w.filter(d => pTarget && tot(d).p < pTarget).map(d => d.date);
      windows['d' + n] = {
        days: w.length,
        avgKcal: w.length ? Math.round(w.reduce((s, d) => s + tot(d).kcal, 0) / w.length) : null,
        avgProtein: avg(w, x => x.p), avgFat: avg(w, x => x.f), avgCarb: avg(w, x => x.c),
        inCorridor: w.filter(dayOk).length,
        overCeilDays: overCeil, underFloorDays: underFloor, missedProteinDays: missedP
      };
    });

    // Streak: consecutive compliant days back from the most recent CLOSED day.
    let streak = 0;
    for (let i = 0; i < days.length; i++) { if (dayOk(days[i])) streak++; else break; }

    // Most-logged foods over the last 30 closed days + the open one: what the diet
    // actually consists of, which is most of what "am I eating well" comes down to.
    const foodTally = {};
    const forFoods = days.slice(0, 30).concat(inp.open && inp.open.date ? [inp.open] : []);
    forFoods.forEach(d => (d.entries || []).forEach(e => {
      const k = String(e.name || '').trim();
      if (!k) return;
      const f = foodTally[k] || (foodTally[k] = { name: k, times: 0, dates: {}, kcal: 0, grams: 0 });
      f.times++; f.dates[d.date] = true; f.kcal += +e.kcal || 0; f.grams += +e.grams || 0;
    }));
    const topFoods = Object.keys(foodTally).map(k => {
      const f = foodTally[k];
      return { name: f.name, times: f.times, days: Object.keys(f.dates).length,
               totalKcal: Math.round(f.kcal), avgGrams: Math.round(f.grams / f.times) };
    }).sort((a, b) => b.times - a.times).slice(0, 12);

    // Weight: the full-history trend plus the trailing 28 days, which is the one that
    // answers "is the current corridor working" rather than "did I lose weight ever".
    const ws = (inp.weights || []).filter(w => +w.kg > 0)
      .slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const recentW = ws.slice(-28);
    const trAll = weightTrend(ws), tr28 = weightTrend(recentW);
    const weight = ws.length ? {
      latest: ws[ws.length - 1].kg, latestDate: ws[ws.length - 1].date,
      first: ws[0].kg, firstDate: ws[0].date, weighIns: ws.length,
      changeKg: Math.round((ws[ws.length - 1].kg - ws[0].kg) * 100) / 100,
      ratePerWeek: trAll ? Math.round(trAll.ratePerWeek * 100) / 100 : null,
      ratePerWeek28: tr28 ? Math.round(tr28.ratePerWeek * 100) / 100 : null
    } : null;

    const openTotals = tot(inp.open);
    const remaining = {
      kcalToFloor: floor ? Math.max(0, Math.round(floor - openTotals.kcal)) : null,
      kcalToCeil: ceil ? Math.round(ceil - openTotals.kcal) : null,
      proteinToTarget: pTarget ? Math.max(0, Math.round(pTarget - openTotals.p)) : null
    };

    return {
      today: inp.today || (inp.open && inp.open.date) || null,
      targets: { floor, ceil, protein: pTarget, carbCap: +t.carbCap || null, fatCap: +t.fatCap || null,
                 goalLabel: t.goalLabel || null, corridorAuto: !!t.corridorAuto },
      training: inp.training || null,
      openDay: { date: (inp.open && inp.open.date) || null, totals: roundTotals(openTotals),
                 items: (inp.open && inp.open.entries || []).length },
      remaining, windows, streak, topFoods, weight,
      tdee: inp.tdee || null,
      supplements: inp.supplements || [],
      micros: inp.micros || [],
      loggedDays: days.length,
      // Item-level detail for lookups, newest first and capped — enough to answer "what
      // did I eat on Tuesday" without burying the computed figures above.
      recent: days.slice(0, 14).map(d => ({
        date: d.date, totals: roundTotals(tot(d)),
        items: (d.entries || []).slice(0, 30).map(e => ({
          name: e.name, grams: Math.round(+e.grams || 0), kcal: Math.round(+e.kcal || 0),
          p: Math.round((+e.p || 0) * 10) / 10, f: Math.round((+e.f || 0) * 10) / 10,
          c: Math.round((+e.c || 0) * 10) / 10
        }))
      }))
    };
  }
  function roundTotals(x) {
    return { kcal: Math.round(x.kcal || 0), p: Math.round((x.p || 0) * 10) / 10,
             f: Math.round((x.f || 0) * 10) / 10, c: Math.round((x.c || 0) * 10) / 10 };
  }

  // Render a digest as the plain-text FACTS block the model is handed. Kept separate
  // from assistantDigest so the numbers can be tested without parsing prose.
  function digestFacts(d) {
    const L = [];
    const n = v => v == null ? 'unknown' : (typeof v === 'number' ? String(v) : v);
    L.push(`TODAY: ${n(d.today)}` + (d.training && d.training.split ? ` (${d.training.split}${d.training.isTraining ? ' — training day' : ' — rest day'})` : ''));
    const t = d.targets;
    L.push(`TARGETS: corridor ${n(t.floor)}-${n(t.ceil)} kcal/day, protein floor ${n(t.protein)} g`
      + (t.carbCap ? `, carb cap ${t.carbCap} g` : '') + (t.fatCap ? `, fat cap ${t.fatCap} g` : '')
      + (t.goalLabel ? `, goal "${t.goalLabel}"` : '') + (t.corridorAuto ? ', corridor auto-set from TDEE' : ''));
    const o = d.openDay;
    L.push(`TODAY SO FAR: ${o.totals.kcal} kcal, ${o.totals.p} g protein, ${o.totals.f} g fat, ${o.totals.c} g carb, across ${o.items} logged item(s)`);
    const r = d.remaining;
    L.push(`REMAINING TODAY: ${r.kcalToCeil == null ? 'unknown' : r.kcalToCeil + ' kcal to ceiling'}`
      + (r.kcalToFloor == null ? '' : `, ${r.kcalToFloor} kcal still needed to reach the floor`)
      + (r.proteinToTarget == null ? '' : `, ${r.proteinToTarget} g protein still needed`));
    L.push(`HISTORY: ${d.loggedDays} closed day(s) logged; current compliant streak ${d.streak} day(s)`);
    DIGEST_WINDOWS.forEach(k => {
      const w = d.windows['d' + k];
      if (!w || !w.days) { L.push(`LAST ${k} DAYS: no closed days logged`); return; }
      L.push(`LAST ${k} DAYS (${w.days} logged): avg ${w.avgKcal} kcal, ${w.avgProtein} g protein, `
        + `${w.avgFat} g fat, ${w.avgCarb} g carb; ${w.inCorridor} of ${w.days} fully on target; `
        + `${w.overCeilDays.length} over ceiling${w.overCeilDays.length ? ' (' + w.overCeilDays.join(', ') + ')' : ''}; `
        + `${w.underFloorDays.length} under floor${w.underFloorDays.length ? ' (' + w.underFloorDays.join(', ') + ')' : ''}; `
        + `${w.missedProteinDays.length} short on protein${w.missedProteinDays.length ? ' (' + w.missedProteinDays.join(', ') + ')' : ''}`);
    });
    L.push(d.weight
      ? `WEIGHT: latest ${d.weight.latest} kg on ${d.weight.latestDate}, from ${d.weight.first} kg on ${d.weight.firstDate} `
        + `(${d.weight.changeKg >= 0 ? '+' : ''}${d.weight.changeKg} kg over ${d.weight.weighIns} weigh-ins); `
        + `trend ${d.weight.ratePerWeek == null ? 'unknown' : d.weight.ratePerWeek + ' kg/week'} all-time, `
        + `${d.weight.ratePerWeek28 == null ? 'unknown' : d.weight.ratePerWeek28 + ' kg/week'} over the last 28 days`
      : 'WEIGHT: no weigh-ins logged — weight-based questions cannot be answered');
    L.push(d.tdee && d.tdee.blended
      ? `MAINTENANCE (TDEE): ${d.tdee.blended} kcal/day (formula ${d.tdee.formula}, `
        + `measured-from-data ${d.tdee.dataTDEE == null ? 'not yet available' : d.tdee.dataTDEE}, `
        + `data weighted ${Math.round((d.tdee.w || 0) * 100)}% over ${d.tdee.sampleDays || 0} days; `
        + `average logged intake ${d.tdee.avgIntake || 0} kcal)`
      : 'MAINTENANCE (TDEE): not computable — needs a bodyweight and profile');
    if (d.topFoods.length)
      L.push('MOST-LOGGED FOODS (last 30 days): ' + d.topFoods.map(f =>
        `${f.name} x${f.times} on ${f.days} day(s), ${f.totalKcal} kcal total, typical ${f.avgGrams} g`).join('; '));
    if (d.micros.length)
      L.push('MICRONUTRIENTS TODAY (USDA-matched foods only, so these under-read): ' + d.micros.map(m =>
        `${m.name} ${m.value}/${m.target} ${m.unit} (${m.status})`).join('; '));
    if (d.supplements.length)
      L.push('SUPPLEMENTS: ' + d.supplements.map(s =>
        `${s.name} — ${s.cadence}, ${s.dueToday ? 'due today' : 'not due today'}, `
        + `${s.takenToday ? 'taken today' : 'not yet taken today'}, ${s.taken}/${s.due} of the last ${s.windowDays} days, streak ${s.streak}`).join('; '));
    d.recent.forEach(day => {
      L.push(`ENTRIES ${day.date} (${day.totals.kcal} kcal, ${day.totals.p} g protein): `
        + (day.items.length ? day.items.map(i => `${i.name} ${i.grams}g = ${i.kcal} kcal/${i.p}p/${i.f}f/${i.c}c`).join('; ') : 'nothing logged'));
    });
    return L.join('\n');
  }

  // Guard against the model doing arithmetic anyway. Pulls every number out of an answer
  // and checks it against the numbers in the facts block. Values under 10 are ignored —
  // counts, ordinals and "2 eggs" dominate there and would drown the signal. A 1% (or
  // ±1) tolerance absorbs sensible rounding. Returns the numbers with no basis in the
  // data; the caller flags them rather than hiding the answer, since a false positive is
  // cheaper than silently shipping an invented figure.
  function unverifiedNumbers(answer, factsText, minValue) {
    const min = minValue == null ? 10 : minValue;
    const grab = s => (String(s || '').match(/\d[\d,]*(?:\.\d+)?/g) || [])
      .map(x => parseFloat(x.replace(/,/g, ''))).filter(v => isFinite(v));
    const facts = grab(factsText);
    const out = [];
    grab(answer).forEach(v => {
      if (Math.abs(v) < min) return;
      const tol = Math.max(1, Math.abs(v) * 0.01);
      if (facts.some(f => Math.abs(f - v) <= tol)) return;
      if (out.indexOf(v) < 0) out.push(v);
    });
    return out;
  }

  // ---- Supplement cycles: which days a protocol is ON ------------------------
  // A protocol is either "every N days" or "these weekdays". Every-other-day (N=2) is the
  // one nobody can hold in their head, so the ON/OFF parity is made a property of the
  // calendar rather than of memory: pin an anchor date and the grid answers for any day,
  // past or future. sched = {every, anchor, mode} or {days:[0..6]}, Monday=0 to match the
  // training split. Two ways to run an every-N cycle, because they genuinely differ:
  //   'fixed'   — ON days are the calendar grid: (date − anchor) % N === 0. A missed dose
  //               does NOT shift the pattern; tomorrow is still whatever the grid says.
  //   'rolling' — the cycle re-anchors on the last dose actually taken: due once N days
  //               have passed since it. Taking one a day late pushes the next one out a
  //               day too, which is what a true "one every 48h" protocol wants.
  const DAY_MS = 86400000;
  function isoDay(iso) { return Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY_MS); }
  function dayIso(n) { return new Date(n * DAY_MS).toISOString().slice(0, 10); }
  // Epoch day 0 (1970-01-01) was a Thursday, which is index 3 in a Monday-first week.
  function isoWeekdayMon(iso) { return ((isoDay(iso) + 3) % 7 + 7) % 7; }
  function supplementDue(sched, dateISO, lastTakenISO) {
    if (!sched) return false;
    if (Array.isArray(sched.days) && sched.days.length) return sched.days.indexOf(isoWeekdayMon(dateISO)) >= 0;
    const n = Math.max(1, Math.round(sched.every || 1));
    if (n === 1) return true;                                  // daily — every day is ON
    if (sched.mode === 'rolling') {
      if (!lastTakenISO) return true;                          // never dosed — start today
      return isoDay(dateISO) - isoDay(lastTakenISO) >= n;
    }
    if (!sched.anchor) return true;                            // no anchor to phase against
    const d = isoDay(dateISO) - isoDay(sched.anchor);
    return d >= 0 && d % n === 0;                              // before the anchor = not started
  }
  // First ON day at or after fromISO — the "next dose" line on an OFF day. Null if the
  // schedule has no ON day within the horizon (only possible for an empty weekday set).
  function supplementNextDue(sched, fromISO, lastTakenISO, horizon) {
    const h = horizon > 0 ? horizon : 60;
    for (let i = 0; i <= h; i++) {
      const d = dayIso(isoDay(fromISO) + i);
      if (supplementDue(sched, d, lastTakenISO)) return d;
    }
    return null;
  }
  // The day-strip: for each of the last `days` days ending at endISO, was the protocol ON
  // and was a dose logged. taken = {'YYYY-MM-DD': true}. A rolling schedule depends on
  // dosing history, so the walk carries lastTaken forward and seeds it from the most
  // recent dose BEFORE the window — that keeps the strip in the right phase at its left edge.
  function supplementWindow(sched, taken, endISO, days) {
    const n = days > 0 ? days : 7;
    const end = isoDay(endISO), start = end - (n - 1);
    let last = null;
    Object.keys(taken || {}).forEach(d => {
      if (taken[d] && isoDay(d) < start && (last === null || d > last)) last = d;
    });
    const cells = [];
    for (let i = start; i <= end; i++) {
      const date = dayIso(i);
      const due = supplementDue(sched, date, last);
      const got = !!(taken && taken[date]);
      cells.push({ date: date, due: due, taken: got });
      if (got) last = date;
    }
    return cells;
  }
  // Score a strip. streak = the run of ON days met, counted back from the end; OFF days are
  // skipped over, an unmet ON day breaks it. The final cell is the day on screen and is
  // still open, so an un-taken ON day there can't break the streak — it just hasn't
  // happened yet. Doses on OFF days count as `extra`, never as adherence.
  function supplementStats(cells) {
    let due = 0, hit = 0, extra = 0;
    cells.forEach(c => { if (c.due) { due++; if (c.taken) hit++; } else if (c.taken) extra++; });
    let i = cells.length - 1;
    if (i >= 0 && cells[i].due && !cells[i].taken) i--;         // open day: pending, not missed
    let streak = 0;
    for (; i >= 0; i--) {
      if (!cells[i].due) continue;
      if (!cells[i].taken) break;
      streak++;
    }
    return { due: due, taken: hit, missed: due - hit, extra: extra, streak: streak,
             rate: due ? hit / due : null };
  }

  // ---- Sync merge: last-write-wins per DAY ----------------------------------
  // A sync state is {days:{'YYYY-MM-DD':[entries]}, meta:{'YYYY-MM-DD':isoStamp}}.
  // Per-day (not per-blob) LWW makes "phone logs lunch, PC logs dinner on another
  // day" trivially safe; a same-day conflict resolves to the most recent editor.
  // Days with no meta stamp count as oldest, and a day deleted on one side but
  // edited later on the other survives. Returns fresh objects; inputs untouched.
  function mergeSyncStates(local, remote) {
    const days = {}, meta = {};
    const stamp = (s, d) => (s.meta && s.meta[d]) || '';
    const dates = new Set(
      Object.keys((local && local.days) || {}).concat(Object.keys((remote && remote.days) || {})));
    dates.forEach(d => {
      let win = stamp(remote, d) > stamp(local, d) ? remote : local;
      if (!(win.days && win.days[d])) win = win === remote ? local : remote;  // stale stamp without data
      if (win.days && win.days[d]) { days[d] = win.days[d]; meta[d] = stamp(win, d); }
    });
    return { days, meta };
  }

  // ---- Ternary meal engineering (barycentric) ------------------------------
  // Three foods balanced against a strict calorie target. A point in the triangle
  // has barycentric weights w=[wA,wB,wC], w>=0, sum 1 — the fraction of the calorie
  // budget spent on each food. Vertices = 100% of one food; centre = equal thirds.
  const ternary = {
    // Cartesian <-> barycentric for a triangle V = [[x,y],[x,y],[x,y]].
    cartesianFromBary(w, V) {
      return [
        w[0] * V[0][0] + w[1] * V[1][0] + w[2] * V[2][0],
        w[0] * V[0][1] + w[1] * V[1][1] + w[2] * V[2][1]
      ];
    },
    baryFromCartesian(px, py, V) {
      const [x1, y1] = V[0], [x2, y2] = V[1], [x3, y3] = V[2];
      const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
      const w1 = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / det;
      const w2 = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / det;
      return [w1, w2, 1 - w1 - w2];
    },
    // Project an arbitrary weight vector back into the valid simplex: clamp negative
    // weights (dragged outside the triangle) to 0 and renormalise.
    clampBary(w) {
      const c = w.map(v => Math.max(0, v));
      const sum = c[0] + c[1] + c[2];
      return sum > 0 ? c.map(v => v / sum) : [1 / 3, 1 / 3, 1 / 3];
    },
    // Grams of each food for weights w at a calorie target. g_i = w_i*target*100/kcal_i.
    baryToGrams(w, foods, targetKcal) {
      return foods.map((f, i) => f.kcal > 0 ? w[i] * targetKcal * 100 / f.kcal : 0);
    },
    // Nutrient totals for a grams triple. kcal always ~= targetKcal by construction.
    totalsForGrams(grams, foods) {
      return grams.reduce((t, g, i) => {
        const s = g / 100, f = foods[i];
        t.kcal += (f.kcal || 0) * s; t.p += (f.p || 0) * s;
        t.f += (f.f || 0) * s; t.c += (f.c || 0) * s;
        return t;
      }, { kcal: 0, p: 0, f: 0, c: 0 });
    },
    // Protein at each pure vertex: all budget on food i -> target*p_i/kcal_i grams * ...
    vertexProteins(foods, targetKcal) {
      return foods.map(f => f.kcal > 0 ? targetKcal * f.p / f.kcal : 0);
    },
    // The iso-protein contour (combo protein == pNeed) is a straight line; return the
    // (<=2) points where it crosses the triangle edges, or [] if it misses entirely.
    isoProteinCrossings(foods, targetKcal, pNeed, V) {
      const P = this.vertexProteins(foods, targetKcal);
      const edges = [[0, 1], [1, 2], [2, 0]];
      const pts = [];
      edges.forEach(([i, j]) => {
        const denom = P[j] - P[i];
        if (Math.abs(denom) < 1e-9) return;             // edge is level in protein
        const t = (pNeed - P[i]) / denom;
        if (t < -1e-9 || t > 1 + 1e-9) return;          // crossing lies outside the edge
        pts.push([
          V[i][0] + t * (V[j][0] - V[i][0]),
          V[i][1] + t * (V[j][1] - V[i][1])
        ]);
      });
      return pts.slice(0, 2);
    },
    // The "green zone" polygon (protein >= pNeed), ordered for SVG fill. Empty if the
    // whole triangle is short; the full triangle if every vertex already clears pNeed.
    greenPolygon(foods, targetKcal, pNeed, V) {
      const P = this.vertexProteins(foods, targetKcal);
      const green = [0, 1, 2].filter(i => P[i] >= pNeed - 1e-9);
      if (green.length === 3) return V.slice();
      if (green.length === 0) return [];
      const pts = green.map(i => V[i]).concat(this.isoProteinCrossings(foods, targetKcal, pNeed, V));
      // Order by angle around the centroid so the polygon is non-self-intersecting.
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      return pts.slice().sort((a, b) =>
        Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    }
  };

  return {
    nutrientsFrom, resolvePTarget, capGrams, computeEntry,
    solveFridge, budgetCombos, scoreFood, rankFoods, defaultSelection, proteinFix, weightTrend,
    fatEstimate, bmrMifflin, calibrateTDEE, corridorFromTDEE, mealPaceKcal, microStatus,
    supplementDue, supplementNextDue, supplementWindow, supplementStats, isoWeekdayMon,
    repairJson, assistantDigest, digestFacts, unverifiedNumbers,
    KCAL_PER_KG_FAT, mergeSyncStates, ternary
  };
});
