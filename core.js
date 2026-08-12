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
    // Fat breakdown (g): 606 saturated · 645 monounsaturated · 646 polyunsaturated · 605 trans.
    // Unsaturated is mono+poly; the "unhealthy" share the footnote flags is saturated+trans.
    return { kcal, p, f, c, ca: g('301'), ph: g('305'), fib: g('291'), sug: g('269'), na: g('307'),
             k: g('306'), mg: g('304'), fe: g('303'), zn: g('309'), vc: g('401'), vd: g('328'),
             sfa: g('606'), ufa: g('645') + g('646'), tfa: g('605') };
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

  // ---- Completing the macro split ------------------------------------------
  // Set two of the three macros and the third is arithmetic, not a decision: whatever
  // is left of the calorie floor has to come from somewhere. This works it out so the
  // UI can fill the blank field in.
  //
  // macros = {p,c,f}, each {mode:'g'|'pct', val}; val 0 (or blank) means "not set".
  // Returns null when there is nothing to infer — fewer than two set, all three set, or
  // no floor to divide up. Otherwise {key, mode, val, kcal}, with val already expressed
  // in the missing field's OWN unit so a % field is handed a % and a gram field grams.
  // kcal is recomputed from the ROUNDED val, so the readout matches what lands in the
  // box rather than the unrounded ideal.
  const KCAL_PER_G = { p: 4, c: 4, f: 9 };
  function macroKcal(m, kcalPerG, floor) {
    if (!m || !(m.val > 0)) return 0;
    return m.mode === 'pct' ? m.val / 100 * floor : m.val * kcalPerG;
  }
  function completeMacros(floor, macros) {
    if (!(floor > 0) || !macros) return null;
    const keys = ['p', 'c', 'f'];
    const set = keys.filter(k => macros[k] && macros[k].val > 0);
    if (set.length !== 2) return null;            // exactly two pins down exactly one
    const key = keys.filter(k => set.indexOf(k) < 0)[0];
    const used = set.reduce((s, k) => s + macroKcal(macros[k], KCAL_PER_G[k], floor), 0);
    const left = floor - used;
    const mode = macros[key] && macros[key].mode === 'pct' ? 'pct' : 'g';
    // The two given macros already spend the whole floor. Say so rather than filling in
    // a zero or a negative, which would read as a deliberate target of "none".
    if (left <= 0) return { key: key, mode: mode, val: 0, kcal: 0,
                            used: Math.round(used), over: true };
    const exact = mode === 'pct' ? left / floor * 100 : left / KCAL_PER_G[key];
    const val = Math.round(exact);
    if (val <= 0) return { key: key, mode: mode, val: 0, kcal: 0,
                           used: Math.round(used), over: true };
    return { key: key, mode: mode, val: val, over: false,
             used: Math.round(used),
             kcal: Math.round(mode === 'pct' ? val / 100 * floor : val * KCAL_PER_G[key]) };
  }

  // ---- Free (added) sugar ---------------------------------------------------
  // USDA reports only TOTAL sugar (#269) — the fructose in an apple and the sugar in a soda
  // land in the same number. "Free sugar" (WHO: added sugars plus those in honey, syrups and
  // fruit juice, but NOT the sugars intrinsic to whole fruit, vegetables and milk) is the one
  // worth cutting, and it isn't in the data. So estimate the FRACTION of a food's sugar that
  // is free from its name: whole foods score 0, obvious sweets/juice/syrup score 1. The meal
  // parser can override this per food (the AI knows a mango lassi's sugar better than a
  // keyword can); this is the floor everything else falls back to.
  const SUGAR_INTRINSIC = /\b(apples?|bananas?|oranges?|mango(?:es)?|grapes?|berry|berries|strawberr\w*|blueberr\w*|raspberr\w*|blackberr\w*|melons?|watermelons?|cantaloupes?|pears?|peach(?:es)?|plums?|apricots?|cherry|cherries|pineapples?|kiwis?|figs?|guavas?|papayas?|pomegranates?|nectarines?|clementines?|mandarins?|tangerines?|lychees?|fruits?|milk|yoghurt|yogurt|curd|dahi|labneh|kefir|vegetables?|carrots?|tomato(?:es)?|onions?|beets?|beetroot|peas?|corn|sweetcorn|potato(?:es)?|lentils?|beans?|chickpeas?)\b/;
  const SUGAR_FREE = /\b(sugar|sugars|syrup|honey|jam|jelly|marmalade|preserve|juice|soda|cola|pop|soft ?drink|energy ?drink|cordial|squash|lemonade|candy|candies|sweet|sweets|chocolate|cocoa|cookie|biscuit|cake|pastry|muffin|donut|doughnut|brownie|dessert|pudding|custard|ice ?cream|gelato|sorbet|toffee|caramel|fudge|nutella|frosting|icing|glucose|fructose|sucrose|dextrose|maple|molasses|jaggery|gur|treacle|agave|condensed milk|sweetened)\b/;
  function freeSugarFraction(name) {
    const n = ' ' + String(name || '').toLowerCase() + ' ';
    if (SUGAR_FREE.test(n)) return 1;                 // named as a sweet / juice / syrup
    if (SUGAR_INTRINSIC.test(n)) return 0;            // a whole fruit, veg or plain dairy
    return 1;                                         // unclassified: count it as free, the safe side when cutting
  }

  // ---- Per-entry contribution with penalties -------------------------------
  // base = per-100g nutrients; pen = {inflate, deduct}. source tags provenance so
  // AI estimates read as provisional. partOf (optional) is the dish this entry was
  // decomposed out of — kept on the entry so the ledger can still show the meal.
  // Without it, decomposing "biryani" into six ingredients loses the biryani.
  function computeEntry(name, grams, weighed, base, source, pen, partOf) {
    const s = grams / 100;
    // Free sugar per 100g = total sugar × free fraction. base.freeFrac (set by the parser from
    // the AI's read) wins; otherwise the name heuristic. Clamped so free can never exceed total.
    const frac = base.freeFrac != null ? Math.max(0, Math.min(1, +base.freeFrac || 0))
                                       : freeSugarFraction(name);
    const e = {
      name, grams, weighed, base, source: source || 'DB',
      kcal: base.kcal * s, p: base.p * s, f: base.f * s,
      c: (base.c || 0) * s, ca: (base.ca || 0) * s, ph: (base.ph || 0) * s,
      fib: (base.fib || 0) * s, sug: (base.sug || 0) * s, fsug: (base.sug || 0) * s * frac,
      sfa: (base.sfa || 0) * s, ufa: (base.ufa || 0) * s, tfa: (base.tfa || 0) * s,
      na: (base.na || 0) * s,
      k: (base.k || 0) * s, mg: (base.mg || 0) * s, fe: (base.fe || 0) * s,
      zn: (base.zn || 0) * s, vc: (base.vc || 0) * s, vd: (base.vd || 0) * s, flags: []
    };
    if (!weighed) {
      e.kcal *= pen.inflate; e.p *= pen.deduct;
      e.flags.push(`+${Math.round((pen.inflate - 1) * 100)}% kcal / −${Math.round((1 - pen.deduct) * 100)}% P`);
    }
    if (e.source === 'AI est') e.flags.push('AI-estimated nutrition — provisional');
    // Only set when there is one: an absent key keeps plain foods the shape they
    // have always been, and `partOf` truthiness is what marks a dish component.
    if (partOf) e.partOf = String(partOf);
    return e;
  }

  // ---- Repeat units: what "I ate this before" actually means ----------------
  // The parser decomposes a dish into ingredients, which is right for accuracy and
  // ruinous for repeats — what recurs in a ledger mined by food name is "Sugar, NFS",
  // never "chai". Grouping each day's entries by `partOf` puts the dish back, so the
  // one-tap chips offer meals again. Entries with no dish stay their own unit.
  //
  // days = [{date, ledger}] newest-first (the caller's own ordering is preserved).
  // Rows whose source is in `skipSources` never count — a bulk import row is a day's
  // total wearing a food's clothes, and it would otherwise dominate every list.
  function mineRepeats(days, opts) {
    const o = opts || {};
    const skip = o.skipSources || ['import'];
    const count = {}, last = {};
    (days || []).forEach(d => {
      const dishes = {};
      (d.ledger || []).forEach(e => {
        if (!e || !e.name) return;
        if (skip.indexOf(e.source) >= 0) return;
        if (!(+e.grams > 0)) return;                 // nothing to repeat at zero grams
        const dish = (e.partOf || '').trim();
        if (dish) (dishes[dish] = dishes[dish] || []).push(e);
        else {
          const k = 'f:' + e.name;
          count[k] = (count[k] || 0) + 1;
          if (!last[k]) last[k] = { kind: 'food', name: e.name, items: [e] };
        }
      });
      // A dish counts once per day however many ingredients it was split into.
      Object.keys(dishes).forEach(dish => {
        const k = 'd:' + dish;
        count[k] = (count[k] || 0) + 1;
        if (!last[k]) last[k] = { kind: 'dish', name: dish, items: dishes[dish] };
      });
    });
    return Object.keys(count)
      .sort((a, b) => count[b] - count[a] || (last[a].name < last[b].name ? -1 : 1))
      .slice(0, o.limit > 0 ? o.limit : 6)
      .map(k => Object.assign({ count: count[k] }, last[k]));
  }

  // A day that reports zero fat AND zero carbs against real calories did not measure
  // them — it is a kcal/protein-only import. Averaging those zeros in reports fat and
  // carbs as if they had been observed, which is how 21 imported days can quietly
  // halve a three-month macro average.
  function macrosComplete(ledger) {
    const l = ledger || [];
    const kcal = l.reduce((s, e) => s + (+(e && e.kcal) || 0), 0);
    if (!(kcal > 0)) return false;
    return l.some(e => (+(e && e.f) || 0) > 0 || (+(e && e.c) || 0) > 0);
  }

  // ---- Corridor drift: has the corridor stopped describing what you eat? -----
  // A ceiling breached most days is not a warning any more, it is wallpaper — you
  // stop seeing it, and the one signal the instrument exists to give is gone. This
  // reports the sustained gap so the app can say "your goal says +300 and you are
  // running +620; move one of them" instead of flashing the same alarm daily.
  // days = [{kcal, floor, ceil}] for each CLOSED day in the window. Each day carries its
  // own bounds because a training/rest cycle moves the corridor by hundreds of calories
  // between one day and the next — judging a rest day against a training day's ceiling
  // would manufacture drift out of a schedule that is working exactly as configured.
  // The reported gap is the median overshoot past the bound each day actually had.
  const DRIFT_MIN_DAYS = 10;
  const DRIFT_SHARE = 0.6;          // this fraction of days on one side = not noise
  function corridorDrift(days) {
    const xs = (days || []).filter(d => d && +d.kcal > 0 && +d.ceil > +d.floor);
    const n = xs.length;
    const base = { n, verdict: 'thin', over: 0, under: 0, inside: 0, median: null, gap: null };
    if (n < DRIFT_MIN_DAYS) return base;
    const overs = xs.filter(d => d.kcal > d.ceil);
    const unders = xs.filter(d => d.kcal < d.floor);
    const inside = n - overs.length - unders.length;
    const med = median(xs.map(d => +d.kcal));
    let verdict = 'aligned', gap = 0;
    if (overs.length / n >= DRIFT_SHARE) {
      verdict = 'over';  gap = median(overs.map(d => d.kcal - d.ceil));
    } else if (unders.length / n >= DRIFT_SHARE) {
      verdict = 'under'; gap = median(unders.map(d => d.kcal - d.floor));
    }
    return { n, verdict, over: overs.length, under: unders.length, inside,
             median: Math.round(med), gap: Math.round(gap) };
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
  // ---- Pinned USDA entries -------------------------------------------------
  // A few ingredients resolve wrong no matter how the generic ranker is tuned, because
  // the ranker's own heuristics fight the right answer. "chicken breast" is the standing
  // case: USDA's raw entry is shorter (fewer-words bonus) AND collects the +6 `raw` bonus,
  // so it beats every cooked entry — but nobody logs raw chicken. Raw meat carries the
  // water that cooking drives off, so per 100g it reads materially lower in both kcal and
  // protein than the cooked weight actually on the plate: the ledger under-counts both.
  //
  // A pin hardcodes the exact USDA description to use for an ingredient. It rewrites the
  // search query (so the entry is in the result set at all) and then wins the default
  // pick outright — ahead of ranking and ahead of the plausibility check below.
  const FOOD_PINS = [{
    id: 'chicken-breast-cooked',
    // Any chicken, EXCEPT cuts and preparations that are a genuinely different food.
    // Forcing breast-meat-only onto "chicken thigh" or "fried chicken" would trade one
    // wrong number for a worse one, so those keep the normal ranked search.
    when: /\bchicken\b/,
    not: /\b(thighs?|drumsticks?|wings?|legs?|livers?|hearts?|gizzards?|skin|whole|ground|minced?|nuggets?|patty|patties|sausages?|salami|bacon|broth|stock|soup|fried|breaded)\b/,
    // ("grilled" / "roasted" / "tandoori" chicken is still chicken breast in practice and the
    // cooked entry is the right answer for it — only coatings, organs and other cuts are out.)
    query: 'Chicken, broilers or fryers, breast, meat only, cooked, stewed',
    // Must name the cooking method: USDA carries roasted/stewed/fried variants of the
    // identical cut, and a looser pattern silently pins whichever one ranks first.
    pick: /chicken.*breast.*meat only.*cooked.*stewed/
  }, {
    id: 'cooking-oil',
    // The decomposer emits a "cooking oil" component for anything fried or in gravy,
    // so this is the single most-logged ingredient in the whole database — and it was
    // landing on three different names for the same fat. \boil\b matters: an unanchored
    // "oil" also matches "brOILer", which would pin every chicken entry to fat.
    when: /\b(cooking|vegetable|frying|refined)?\s*oils?\b/,
    // Named oils are genuinely different foods with different fatty-acid profiles and,
    // for the ones people cook with deliberately, different reasons for being logged.
    not: /\b(olive|coconut|sesame|mustard|peanut|groundnut|avocado|walnut|almond|flax|fish|cod|castor|palm|ghee|butter)\b/,
    query: 'Vegetable oil, NFS',
    pick: /^vegetable oil, nfs$/
  }, {
    id: 'sugar-white',
    // Pure consolidation: "Sugar, NFS" and "Sugar, white, granulated or lump" are the
    // same 387 kcal/100g, so nothing about the numbers changes. What changes is that
    // 60 entries stop being two foods, so sugar can appear once in the repeat lists.
    when: /\bsugars?\b/,
    not: /\b(free|less|substitute|brown|jaggery|gur|palm|coconut|icing|powdered|cane juice|syrup|cookie|cookies|wafer|candy|snap peas?|snap pea)\b/,
    query: 'Sugar, NFS',
    pick: /^sugar, nfs$/
  }];
  // The pin that applies to a search query, or null. Longest-standing behaviour when
  // nothing matches: the ordinary ranked search, untouched.
  function foodPin(query) {
    const q = ' ' + (query || '').toLowerCase() + ' ';
    return FOOD_PINS.find(p => p.when.test(q) && !(p.not && p.not.test(q))) || null;
  }
  function pinMatches(food, pin) {
    return !!(pin && food && pin.pick.test((food.name || '').toLowerCase()));
  }
  // Move the pinned entry to the front of a ranked list. Returns the list untouched when
  // USDA didn't return it — a pin expresses a preference among real results, it never
  // fabricates one.
  function applyPin(ranked, pin) {
    if (!pin || !ranked || !ranked.length) return ranked || [];
    const i = ranked.findIndex(f => pinMatches(f, pin));
    if (i <= 0) return ranked;
    const out = ranked.slice();
    out.unshift(out.splice(i, 1)[0]);
    return out;
  }

  // Given ranked candidates and a trusted AI per-100g calorie prior, decide the DEFAULT
  // pick. USDA sometimes returns the wrong food entirely — a generic "water" at 40 kcal,
  // a cousin ingredient — and ranking alone can still float it to the top. When the best
  // match's energy density is implausibly far from the prior, prefer the highest-ranked
  // candidate that DOES land near it; if none do, trust the AI estimate over a clearly
  // wrong match. Returns 'u<index>' for candidates[index], or 'est' for the AI estimate.
  // pin (optional): when the pinned entry is present it is the answer, full stop — it is
  // a deliberate hardcoding and outranks the estimate-plausibility check.
  const SEL_LN_TOL = Math.log(1.8);   // >1.8x or <0.55x off the prior = wrong food, not mere imprecision
  function defaultSelection(ranked, estKcal, pin) {
    if (!ranked || !ranked.length) return 'est';
    if (pin) {
      const p = ranked.findIndex(f => pinMatches(f, pin));
      if (p >= 0) return 'u' + p;
    }
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

  // ---- Micronutrient registry -----------------------------------------------
  // One canonical list of every micronutrient the panel can show, with a general adult
  // daily reference (m/f) and its unit. `core:true` marks the set USDA foods populate — the
  // panel shows those whenever any food is logged. The rest are supplement-only: the USDA
  // extractor doesn't read them off foods, so they surface only on days a supplement supplies
  // them, which is how a nutrient "not covered yet" gets added to the tab retroactively the
  // moment a label brings it in. `limit:true` is a ceiling (sodium, sugar), not a floor.
  // References are RDA/AI figures — general guidance, not medical advice.
  const MICRO_REF = [
    { key:'fib', name:'Fiber',            unit:'g',  m:38,   f:25,   limit:false, core:true },
    { key:'k',   name:'Potassium',        unit:'mg', m:3400, f:2600, limit:false, core:true, rec:true },
    { key:'mg',  name:'Magnesium',        unit:'mg', m:400,  f:310,  limit:false, core:true, rec:true },
    { key:'ca',  name:'Calcium',          unit:'mg', m:1000, f:1000, limit:false, core:true },
    { key:'fe',  name:'Iron',             unit:'mg', m:8,    f:18,   limit:false, core:true },
    { key:'zn',  name:'Zinc',             unit:'mg', m:11,   f:8,    limit:false, core:true },
    { key:'vc',  name:'Vitamin C',        unit:'mg', m:90,   f:75,   limit:false, core:true, rec:true },
    { key:'vd',  name:'Vitamin D',        unit:'µg', m:15,   f:15,   limit:false, core:true },
    { key:'na',  name:'Sodium',           unit:'mg', m:2300, f:2300, limit:true,  core:true, rec:true },
    // Free sugar (the added/juice/syrup share) is the one to cut — a tighter limit than total,
    // set to the AHA added-sugar guidance (36 g men / 25 g women). Total sugar stays as context.
    { key:'fsug', name:'Free sugar',      unit:'g',  m:36,   f:25,   limit:true,  core:true },
    { key:'sug', name:'Total sugar',      unit:'g',  m:50,   f:50,   limit:true,  core:true },
    // Supplement-sourced extras — shown only on days something actually supplies them.
    { key:'va',  name:'Vitamin A',        unit:'µg', m:900,  f:700,  limit:false },
    { key:'ve',  name:'Vitamin E',        unit:'mg', m:15,   f:15,   limit:false },
    { key:'vk',  name:'Vitamin K',        unit:'µg', m:120,  f:90,   limit:false },
    { key:'b1',  name:'Thiamin (B1)',     unit:'mg', m:1.2,  f:1.1,  limit:false },
    { key:'b2',  name:'Riboflavin (B2)',  unit:'mg', m:1.3,  f:1.1,  limit:false },
    { key:'b3',  name:'Niacin (B3)',      unit:'mg', m:16,   f:14,   limit:false },
    { key:'b5',  name:'Pantothenic (B5)', unit:'mg', m:5,    f:5,    limit:false },
    { key:'b6',  name:'Vitamin B6',       unit:'mg', m:1.3,  f:1.3,  limit:false },
    { key:'b7',  name:'Biotin (B7)',      unit:'µg', m:30,   f:30,   limit:false },
    { key:'b9',  name:'Folate (B9)',      unit:'µg', m:400,  f:400,  limit:false },
    { key:'b12', name:'Vitamin B12',      unit:'µg', m:2.4,  f:2.4,  limit:false },
    { key:'cho', name:'Choline',          unit:'mg', m:550,  f:425,  limit:false },
    { key:'cu',  name:'Copper',           unit:'mg', m:0.9,  f:0.9,  limit:false },
    { key:'se',  name:'Selenium',         unit:'µg', m:55,   f:55,   limit:false },
    { key:'mn',  name:'Manganese',        unit:'mg', m:2.3,  f:1.8,  limit:false },
    { key:'io',  name:'Iodine',           unit:'µg', m:150,  f:150,  limit:false },
    { key:'cr',  name:'Chromium',         unit:'µg', m:35,   f:25,   limit:false },
    { key:'mo',  name:'Molybdenum',       unit:'µg', m:45,   f:45,   limit:false }
  ];
  const MICRO_KEYS = MICRO_REF.map(m => m.key);
  function microRef(key) { return MICRO_REF.filter(m => m.key === key)[0] || null; }

  // Sum the per-dose micronutrient content of the supplements taken on a day. supps is the
  // protocol list, takenIds that day's dose log (the ids ticked). A protocol with no `.micros`
  // adds nothing; only registry keys with a positive value are counted, so an unknown or
  // zeroed field can never leak an untracked total into the panel.
  function sumSuppMicros(supps, takenIds) {
    const ids = takenIds || [];
    const out = {};
    (supps || []).forEach(s => {
      if (!s || !s.micros || ids.indexOf(s.id) < 0) return;
      MICRO_KEYS.forEach(k => {
        const v = +s.micros[k];
        if (v > 0) out[k] = (out[k] || 0) + v;
      });
    });
    return out;
  }

  // ---- Elemental mineral content --------------------------------------------
  // A mineral supplement's label weight is the whole salt, but only the mineral ION counts
  // toward intake: 1200 mg of calcium citrate is ~250 mg of elemental calcium, and it is the
  // 250 a tracker should add — not the 1200. These are the elemental mass fractions of the
  // common salts (mineral mass ÷ salt mass). Approximate — salts ship in varying hydrate
  // states — but close enough to turn a compound weight into the number that matters.
  const ELEMENTAL_FRACTION = {
    ca: { carbonate:0.40, phosphate:0.29, 'citrate malate':0.25, acetate:0.25, citrate:0.21, lactate:0.13, ascorbate:0.10, gluconate:0.09 },
    mg: { oxide:0.60, hydroxide:0.42, carbonate:0.29, malate:0.15, citrate:0.16, glycinate:0.14, bisglycinate:0.14, chloride:0.12, lactate:0.12, sulfate:0.10, taurate:0.09, threonate:0.072, gluconate:0.058 },
    fe: { fumarate:0.33, 'ferrous fumarate':0.33, sulfate:0.20, 'ferrous sulfate':0.20, bisglycinate:0.20, gluconate:0.12, 'ferrous gluconate':0.12 },
    zn: { oxide:0.80, citrate:0.31, acetate:0.30, sulfate:0.23, monomethionine:0.21, picolinate:0.20, gluconate:0.14 },
    k:  { chloride:0.52, bicarbonate:0.39, citrate:0.38, gluconate:0.17 }
  };
  // Elemental mg of `mineralKey` in `mgSalt` of the named salt form. Returns null when the
  // mineral or salt form isn't known, so a caller falls back to the label value rather than
  // silently multiplying by a guess. A salt name is matched exactly first, then loosely
  // (any known form named inside the string — "calcium citrate" finds "citrate").
  function elementalMg(mineralKey, saltForm, mgSalt) {
    const forms = ELEMENTAL_FRACTION[mineralKey];
    if (!forms || !(mgSalt > 0)) return null;
    const key = String(saltForm || '').trim().toLowerCase();
    let frac = forms[key];
    if (frac == null) {
      const hit = Object.keys(forms).find(f => key.indexOf(f) >= 0);
      frac = hit ? forms[hit] : null;
    }
    return frac == null ? null : Math.round(mgSalt * frac);
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
    const fit = linearTrend(entries.map(e =>
      ({ x: (Date.parse(e.date + 'T00:00:00Z') - t0) / 86400000, y: e.kg })));
    if (!fit) return null;
    return { ratePerWeek: fit.slope * 7, latest: entries[entries.length - 1].kg };
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

  // ---- Workout window: when the app should open on Lift ----------------------
  // Opening a logging app on the food view during a training session is a tab-tap of
  // friction on every set. The training schedule already knows which days are training
  // days and when the session runs, so the launch tab can just follow it.
  //
  // The window is the user's own start→end, widened slightly at both ends: you reach for
  // the phone before the first warm-up set and again after racking the last one, and
  // neither moment is inside a literal start/end reading.
  const LIFT_OPEN_LEAD_MIN = 15;      // turning up early still counts as workout time
  const LIFT_OPEN_TAIL_MIN = 30;      // and so does logging the last set on the way out
  // 'HH:MM' → minutes past midnight, or null when it isn't a time.
  function hhmmMinutes(hhmm) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(hhmm == null ? '' : hhmm));
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  function isTrainingSplit(s) {
    return !!s && String(s).trim() !== '' && String(s).trim().toLowerCase() !== 'rest';
  }
  // train = {split:[7 Mon-first labels], start:'HH:MM', end:'HH:MM'}. weekdayMon/minutesOfDay
  // describe "now" on the same clock the rest of the app uses. Pure: the caller owns both
  // the clock and the user's opt-in.
  function liftWindowOpen(train, weekdayMon, minutesOfDay) {
    if (!train || !Array.isArray(train.split) || train.split.length !== 7) return false;
    if (!(minutesOfDay >= 0)) return false;
    const start = hhmmMinutes(train.start);
    if (start == null) return false;
    let end = hhmmMinutes(train.end);
    if (end == null || end === start) end = start + 60;   // no usable end → assume an hour
    if (end < start) end += 1440;                         // session runs past midnight
    const from = start - LIFT_OPEN_LEAD_MIN, to = end + LIFT_OPEN_TAIL_MIN;
    // A session anchored on yesterday can still be open (late workout, or the tail past
    // midnight); one anchored on tomorrow can already be open when the lead-in crosses
    // midnight backwards. back = how many days ago the session started.
    for (let back = -1; back <= 1; back++) {
      const day = ((weekdayMon - back) % 7 + 7) % 7;
      if (!isTrainingSplit(train.split[day])) continue;
      const t = minutesOfDay + back * 1440;               // now, in that session's day-frame
      if (t >= from && t <= to) return true;
    }
    return false;
  }

  // ---- Lifting: progression, stalling, and the recomp check ------------------
  // The question this answers is "am I still growing, or just getting heavier?", so
  // every number here is computed from the logs and nothing is asked of a model.
  //
  // Above this many effective reps an estimated 1RM is fantasy: Epley is calibrated on
  // low-rep work and inflates badly out at 20+. High-rep exercises get a different
  // metric entirely rather than a bad e1RM (see classifyExercise).
  const LIFT_REP_CAP = 12;
  // Fewer sessions than this and a slope is noise wearing a trend's clothes. At the
  // usual weekly frequency that is about five weeks before the app will call anything.
  const LIFT_MIN_SESSIONS = 5;
  // Dead band: a trend inside ±this is "flat". Session-to-session output swings ~5% on
  // sleep, food and how warm you were, so only a sustained move outside the band counts.
  const LIFT_FLAT_PCT = 1.5;          // % per month
  // A month-over-month change in reported RIR this large is effort drift, not a strength
  // change. Only the CHANGE is ever read — a constant personal bias (calling it 3 when
  // it is really 1) cancels out of a slope, which is what makes a guessed RIR usable.
  const LIFT_RIR_DRIFT = 1.0;         // RIR per month
  const LIFT_WINDOW_DAYS = 56;        // 8 weeks of history feed a trend
  const LIFT_MAX_SESSIONS = 12;
  const LIFT_WEIGHT_FLAT = 0.1;       // kg/week dead band on bodyweight

  function median(xs) {
    if (!xs || !xs.length) return null;
    const a = xs.slice().sort((p, q) => p - q), m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  // Least-squares slope of y over x. Shared by the weight trend and every lift trend so
  // "is this going up" is answered the same way everywhere. Null when nothing can be fit.
  function linearTrend(pts) {
    const n = (pts || []).length;
    if (n < 2) return null;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n;
    const my = pts.reduce((s, p) => s + p.y, 0) / n;
    const den = pts.reduce((s, p) => s + (p.x - mx) * (p.x - mx), 0);
    if (den === 0) return null;
    return { slope: pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / den, mean: my, n: n };
  }
  // Epley, extended by reps-in-reserve: a set stopped n reps short of failure is treated
  // as a set of (reps + n) taken to failure. Returns null when the effective rep count is
  // too high for the formula to mean anything — the caller must not substitute a guess.
  function e1RM(kg, reps, rir) {
    if (!(kg > 0) || !(reps > 0)) return null;
    const eff = reps + Math.max(0, +rir || 0);
    if (eff > LIFT_REP_CAP) return null;
    return kg * (1 + eff / 30);
  }
  // What the body actually moved. For a bodyweight movement `kg` is ADDED load, so the
  // real load needs the day's bodyweight; without one the set is unmeasurable and the
  // honest answer is null, not zero (zero would quietly erase real work from the trend).
  function setLoad(set, bodyweightKg) {
    const added = +(set && set.kg) || 0;
    if (!(set && set.bw)) return added;
    return bodyweightKg > 0 ? bodyweightKg + added : null;
  }
  // Bodyweight on a given date: the most recent weigh-in at or before it. Before the first
  // weigh-in, that first value is the closest thing to the truth available.
  function weightAt(entries, dateISO) {
    if (!entries || !entries.length) return null;
    let best = null, earliest = null;
    entries.forEach(e => {
      if (!e || !e.date || !(e.kg > 0)) return;
      if (!earliest || e.date < earliest.date) earliest = e;
      if (e.date <= dateISO && (!best || e.date > best.date)) best = e;
    });
    return best ? best.kg : (earliest ? earliest.kg : null);
  }
  // Which metric an exercise can honestly be judged on, decided by its own history rather
  // than by asking the user to classify anything. Median working reps at or under the cap
  // means e1RM is meaningful ('strength'); above it the exercise is high-rep isolation
  // ('volume') where e1RM would be invented and capacity is tracked instead.
  function classifyExercise(sessions) {
    const reps = [];
    (sessions || []).forEach(s => (s.sets || []).forEach(t => { if (+t.reps > 0) reps.push(+t.reps); }));
    const m = median(reps);
    return m != null && m > LIFT_REP_CAP ? 'volume' : 'strength';
  }
  // One session of one exercise, reduced to comparable numbers.
  //   bestE1RM     — strength signal. Best SET, so adding junk sets cannot inflate it.
  //   bestCapacity — load × (reps + RIR) of the best set: the high-rep equivalent, up when
  //                  you add reps, add load, or finish further from failure.
  //   volume       — Σ load × reps. Total work; rises with set count, so it is read only
  //                  alongside the best-set metric, never on its own.
  // opts.rir is the exercise-level RIR for the session. It is applied to every set: that
  // overstates the easier sets, but it overstates them the same way every session, and
  // only the slope is ever read.
  function sessionMetrics(sets, opts) {
    const o = opts || {};
    let volume = 0, topLoad = 0, best = null, cap = 0, counted = 0, skipped = 0, reps = 0, capped = 0;
    const rirs = [];
    (sets || []).forEach(s => {
      const load = setLoad(s, o.bodyweightKg);
      const r = +s.reps || 0;
      if (load == null || !(load > 0) || !(r > 0)) { skipped++; return; }
      counted++; reps += r; volume += load * r;
      if (load > topLoad) topLoad = load;
      const rir = s.rir != null ? +s.rir : (o.rir != null ? +o.rir : null);
      if (rir != null && isFinite(rir)) rirs.push(rir);
      const one = e1RM(load, r, rir);
      // A set past the effective-rep cap yields no e1RM at all. Counting those is what
      // lets the app say WHY an exercise is being judged on capacity instead of strength,
      // rather than silently switching metric behind the user's back.
      if (one == null) capped++;
      if (one != null && (best == null || one > best)) best = one;
      const c = load * (r + Math.max(0, rir || 0));
      if (c > cap) cap = c;
    });
    return { sets: counted, skipped: skipped, reps: reps, volume: volume, topLoad: topLoad,
             bestE1RM: best, bestCapacity: counted ? cap : null, cappedSets: capped,
             medianRir: median(rirs), hasRir: rirs.length > 0, incomplete: skipped > 0 };
  }
  // Is this exercise still moving? sessions = [{date, sets:[{kg,reps,bw,rir}], rir}] in any
  // order. opts.weights = [{date,kg}] so bodyweight movements resolve their real load.
  // Verdicts are deliberately few and mean one thing each:
  //   thin         — not enough sessions yet; the app says how many more rather than
  //                  drawing a confident line through three points.
  //   progressing  — the metric is climbing beyond the noise band.
  //   regressing   — it is falling beyond it.
  //   effort-drift — flat, but you are stopping further from failure than you were, so
  //                  this is not evidence of a plateau.
  //   grinding     — flat while volume climbs or RIR falls: more work for the same output.
  //   stalled      — flat, with effort and volume steady. The real thing.
  function exerciseTrend(sessions, opts) {
    const o = opts || {};
    const minN = o.minSessions > 0 ? o.minSessions : LIFT_MIN_SESSIONS;
    const all = (sessions || []).filter(s => s && s.date).slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const empty = { name: o.name || '', cls: 'strength', metric: 'e1RM', n: 0, sessions: 0,
                    first: null, last: null, pctPerMonth: null, volPctPerMonth: null,
                    rirPerMonth: null, verdict: 'thin', confidence: 'none',
                    sessionsNeeded: minN, spanDays: 0, latest: null,
                    setsTotal: 0, setsCapped: 0 };
    if (!all.length) return empty;
    const end = isoDay(all[all.length - 1].date);
    const windowDays = o.windowDays > 0 ? o.windowDays : LIFT_WINDOW_DAYS;
    let win = all.filter(s => end - isoDay(s.date) <= windowDays);
    if (win.length > LIFT_MAX_SESSIONS) win = win.slice(win.length - LIFT_MAX_SESSIONS);
    if (!win.length) return empty;
    const t0 = isoDay(win[0].date);

    const build = cls => {
      const pts = [], vol = [], rir = [];
      let last = null, setsTotal = 0, setsCapped = 0;
      win.forEach(s => {
        const m = sessionMetrics(s.sets, {
          bodyweightKg: o.weights ? weightAt(o.weights, s.date) : o.bodyweightKg, rir: s.rir });
        setsTotal += m.sets; setsCapped += m.cappedSets;
        const x = isoDay(s.date) - t0;
        const y = cls === 'volume' ? m.bestCapacity : m.bestE1RM;
        if (y != null && y > 0) pts.push({ x: x, y: y });
        if (m.volume > 0) vol.push({ x: x, y: m.volume });
        if (m.hasRir) rir.push({ x: x, y: m.medianRir });
        last = m;
      });
      return { pts: pts, vol: vol, rir: rir, latest: last, setsTotal: setsTotal, setsCapped: setsCapped };
    };
    // A 'strength' exercise whose sessions mostly sit above the rep cap yields too few
    // e1RM points to fit. Rather than mixing units or inventing values, judge it as a
    // volume exercise — the classification is a means to a metric, not a label to defend.
    let cls = o.cls || classifyExercise(win);
    let b = build(cls);
    if (cls === 'strength' && b.pts.length < Math.min(minN, win.length)) { cls = 'volume'; b = build(cls); }

    const fit = linearTrend(b.pts), volFit = linearTrend(b.vol), rirFit = linearTrend(b.rir);
    // Expressed as % of the mean so exercises in different units and loads are comparable.
    const pct = fit && fit.mean > 0 ? fit.slope * 30 / fit.mean * 100 : null;
    const volPct = volFit && volFit.mean > 0 ? volFit.slope * 30 / volFit.mean * 100 : null;
    const rirPm = rirFit ? rirFit.slope * 30 : null;
    const n = b.pts.length;

    let verdict;
    if (n < minN || pct == null) verdict = 'thin';
    else if (pct > LIFT_FLAT_PCT) verdict = 'progressing';
    else if (pct < -LIFT_FLAT_PCT) verdict = 'regressing';
    else if (rirPm != null && rirPm >= LIFT_RIR_DRIFT) verdict = 'effort-drift';
    else if ((volPct != null && volPct > LIFT_FLAT_PCT) || (rirPm != null && rirPm <= -LIFT_RIR_DRIFT)) verdict = 'grinding';
    else verdict = 'stalled';
    // Volume-class exercises never rate above 'low': rear-delt and cuff work is there for
    // joint health, and letting its noise vote in the headline would make it meaningless.
    const confidence = verdict === 'thin' ? 'none'
      : cls === 'volume' ? 'low' : (n >= minN + 3 ? 'high' : 'medium');

    return { name: o.name || '', cls: cls, metric: cls === 'volume' ? 'capacity' : 'e1RM',
             n: n, sessions: win.length,
             first: n ? b.pts[0].y : null, last: n ? b.pts[n - 1].y : null,
             pctPerMonth: pct, volPctPerMonth: volPct, rirPerMonth: rirPm,
             verdict: verdict, confidence: confidence,
             sessionsNeeded: Math.max(0, minN - n),
             spanDays: end - t0, latest: b.latest,
             setsTotal: b.setsTotal, setsCapped: b.setsCapped };
  }
  // The reason this lives in a food tracker: cross-reference strength against bodyweight.
  // A surplus that is not buying strength is buying fat, and no lifting app can see that
  // because it does not know what you ate or what you weigh.
  //   building  — gaining weight, strength climbing. The surplus is doing its job.
  //   spinning  — gaining weight, strength flat. The surplus is going somewhere else.
  //   retaining — losing weight, strength held. A well-run cut.
  //   shedding  — losing weight and strength with it.
  //   recomping — weight steady, strength climbing.
  //   holding   — weight steady, strength steady.
  // Only strength-class exercises with a real trend vote, and the median is taken so one
  // odd lift cannot swing the verdict.
  function liftVsWeight(trends, wTrend) {
    const votes = (trends || []).filter(t =>
      t && t.cls === 'strength' && t.verdict !== 'thin' && t.pctPerMonth != null);
    const kgWk = wTrend && wTrend.ratePerWeek != null ? wTrend.ratePerWeek : null;
    const base = { status: 'thin', n: votes.length, kgPerWeek: kgWk, strengthPctPerMonth: null,
                   progressing: 0, stalled: 0, regressing: 0 };
    if (!votes.length || kgWk == null) return base;
    const s = median(votes.map(t => t.pctPerMonth));
    let status;
    if (kgWk > LIFT_WEIGHT_FLAT) status = s > LIFT_FLAT_PCT ? 'building' : 'spinning';
    else if (kgWk < -LIFT_WEIGHT_FLAT) status = s >= -LIFT_FLAT_PCT ? 'retaining' : 'shedding';
    else status = s > LIFT_FLAT_PCT ? 'recomping' : 'holding';
    return { status: status, n: votes.length, kgPerWeek: kgWk, strengthPctPerMonth: s,
             progressing: votes.filter(t => t.verdict === 'progressing').length,
             stalled: votes.filter(t => t.verdict === 'stalled' || t.verdict === 'grinding').length,
             regressing: votes.filter(t => t.verdict === 'regressing').length };
  }

  // ---- Lift parsing: text → sets, with no model involved ---------------------
  // Meals need a model because "a bowl of daal" contains no numbers. Lift notation is
  // almost entirely numbers, so a grammar handles it with no latency, no API cost and no
  // network — which matters when you are logging between sets on bad reception. The AI is
  // the fallback for lines this cannot read, never the first resort.
  const LIFT_ABBR = { db: 'dumbbell', bb: 'barbell', kb: 'kettlebell', ez: 'ez bar',
                      ohp: 'overhead press', bp: 'bench press', rdl: 'romanian deadlift',
                      dl: 'deadlift', sldl: 'romanian deadlift' };
  const LIFT_MATCH_MIN = 60;
  // Canonicalisation is what makes the whole feature work: "bicep curls", "db curl" and
  // "dumbbell curls" must land on one exercise or the history fragments into singletons
  // and a trend can never be fit. Expand abbreviations, drop punctuation, singularise.
  // English plurals, only as far as canonicalisation needs. Dropping a lone trailing
  // "s" is right for "curls" and wrong for "crunches", which it turns into "crunche"
  // — a token no singular spelling can ever match, so "Cable Crunch" would start a
  // second exercise beside "Cable Crunches" and split the history in half.
  //   -ies after a consonant -> -y   (flies -> fly)
  //   -es after ch/sh/x/z/ss  -> drop both   (crunches -> crunch, presses -> press)
  //   otherwise               -> drop the s  (curls -> curl, raises -> raise)
  // "-ss" is never a plural marker, so "press" survives intact.
  function singularise(w) {
    if (w.length <= 2 || !/s$/.test(w) || /ss$/.test(w)) return w;
    if (/[^aeiou]ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (/(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
    return w.slice(0, -1);
  }
  function normalizeName(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/).filter(Boolean)
      .map(w => LIFT_ABBR[w] || w).join(' ')
      .split(/\s+/).filter(Boolean)
      .map(singularise)
      .join(' ').trim();
  }
  function exerciseId(name) { return normalizeName(name).replace(/\s+/g, '-'); }
  // Every word the user typed must appear in the candidate. Extra words in the QUERY are
  // qualifiers that change the movement — "incline bench press" is NOT "bench press" — so
  // a partial match stays unresolved and gets confirmed rather than silently merging two
  // different lifts into one trend line. Fewer spare words in the candidate scores higher.
  function matchExercise(name, known) {
    const q = normalizeName(name);
    if (!q) return null;
    const qt = q.split(' ');
    let best = null, bestScore = 0;
    (known || []).forEach(ex => {
      [ex.name].concat(ex.aliases || []).forEach(c => {
        const nc = normalizeName(c);
        if (!nc) return;
        let sc = 0;
        if (nc === q) sc = 100;
        else {
          const ct = nc.split(' ');
          if (qt.every(t => ct.indexOf(t) >= 0)) sc = 90 - Math.min(25, (ct.length - qt.length) * 5);
        }
        if (sc > bestScore) { bestScore = sc; best = ex; }
      });
    });
    return bestScore >= LIFT_MATCH_MIN ? { exercise: best, score: bestScore } : null;
  }
  const LB_TO_KG = 0.45359237;
  // One line = one exercise. Commas separate SETS, so they can never separate exercises;
  // newlines and semicolons do that. Returns {name, sets, rir, bw, error}.
  function parseWorkoutLine(line) {
    let s = String(line || '').trim();
    if (!s) return null;
    let rir = null, bw = false;
    // "rir 2", "rir:2", "@rir2", "2 rir" — the reversed form is checked first, being the
    // more specific pattern.
    s = s.replace(/(\d+(?:\.\d+)?)\s*rir\b/i, (m, d) => { rir = +d; return ' '; });
    if (rir == null) s = s.replace(/\brir\s*[:=@]?\s*(\d+(?:\.\d+)?)/i, (m, d) => { rir = +d; return ' '; });
    if (/\bbw\b|\bbodyweight\b/i.test(s)) { bw = true; s = s.replace(/\bbodyweight\b|\bbw\b/ig, ' '); }

    // The set list starts at the first digit, or at the word "set" when a line is written
    // out longhand ("bicep curls, set 1 20kg 12 reps").
    const iNum = s.search(/\d/), iSet = s.search(/\bsets?\b/i);
    let cut = iNum;
    if (iSet >= 0 && (cut < 0 || iSet < cut)) cut = iSet;
    const name = cut > 0 ? s.slice(0, cut).replace(/[,:;+\-–—\s]+$/, '').trim() : '';
    if (cut < 0) return { name: s.trim(), sets: [], rir: rir, bw: bw, error: 'no sets found' };
    if (!name) return { name: '', sets: [], rir: rir, bw: bw, error: 'no exercise name' };
    const rest = s.slice(cut);
    // Does the line state a weight anywhere? That decides how a bare "3x12" is read.
    const hasUnit = /\d\s*(kgs?|kilos?|lbs?|pounds?)\b/i.test(rest) || /@\s*\d/.test(rest);

    const sets = [];
    let ctxW = null, ctxR = null, bad = 0;
    rest.split(/[,;]|\band\b|&/i).map(c => c.trim()).filter(Boolean).forEach(chunk => {
      let c = chunk.replace(/^sets?\s*#?\s*\d+\s*[:.\-]?\s*/i, '');   // "set 1" is a label, not a count
      let w = null, r = null, count = 1;
      c = c.replace(/(\d+(?:\.\d+)?)\s*(?:kgs?|kilos?)\b/i, (m, d) => { w = +d; return ' '; });
      c = c.replace(/(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/i, (m, d) => { if (w == null) w = +d * LB_TO_KG; return ' '; });
      c = c.replace(/@\s*(\d+(?:\.\d+)?)/, (m, d) => { if (w == null) w = +d; return ' '; });
      c = c.replace(/(\d+(?:\.\d+)?)\s*reps?\b/i, (m, d) => { r = +d; return ' '; });
      c = c.replace(/(\d+)\s*sets?\b/i, (m, d) => { count = +d; return ' '; });
      // Keep x-joined runs together: "10 3x6" is a 10kg load and a 3×6 structure, which a
      // flat list of numbers would lose.
      const groups = (c.match(/\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)*/gi) || [])
        .map(g => g.split(/[x×*]/i).map(v => +v.trim()));
      const multi = groups.filter(g => g.length > 1);
      const singles = groups.filter(g => g.length === 1).map(g => g[0]);
      if (multi.length) {
        const g = multi[0];
        if (g.length >= 3) { if (w == null) w = g[0]; r = g[1]; count = g[2]; }        // 22.5x10x3
        else if (w != null || hasUnit || singles.length) {                             // weight known ⇒ sets × reps
          count = g[0]; r = g[1];
          if (w == null && singles.length) w = singles[0];
        }
        // No weight anywhere on the line, so A×B is ambiguous. A small first number is a
        // set count ("5x5", "3x12"); anything larger is a load ("20x12", "60x8"). Nobody
        // runs twenty sets, and nobody benches five kilos.
        else if (g[0] <= 6 && g[1] >= 5) { count = g[0]; r = g[1]; }
        else { w = g[0]; r = g[1]; }
      } else if (singles.length >= 2) {
        if (w == null) { w = singles[0]; r = singles[1]; } else if (r == null) r = singles[0];
      } else if (singles.length === 1) {
        if (r == null) r = singles[0]; else if (w == null) w = singles[0];
      }
      // "bench 60kg 8, 8, 6" — a bare rep count carries the last stated load forward.
      if (w == null) w = ctxW;
      if (w == null && bw) w = 0;      // a bodyweight set with no added load is a real set
      if (r == null) r = ctxR;
      if (!(r > 0) || (w == null) || (!bw && !(w > 0))) { bad++; return; }
      ctxW = w; ctxR = r;
      const n = Math.max(1, Math.min(20, Math.round(count)));
      for (let i = 0; i < n; i++) sets.push(bw ? { kg: w, reps: r, bw: true } : { kg: w, reps: r });
    });
    return { name: name, sets: sets, rir: rir, bw: bw,
             error: sets.length ? null : (bad ? 'could not read the sets' : 'no sets found') };
  }
  function parseWorkout(text, known) {
    const exercises = [], unresolved = [], errors = [];
    String(text || '').split(/[\n;]+/).forEach(line => {
      const p = parseWorkoutLine(line);
      if (!p) return;
      if (!p.name || !p.sets.length) {
        errors.push({ line: String(line).trim(), reason: p.error || 'could not read this line' });
        return;
      }
      const m = matchExercise(p.name, known);
      const ex = { raw: p.name,
                   name: m ? m.exercise.name : p.name.charAt(0).toUpperCase() + p.name.slice(1),
                   id: m ? m.exercise.id : exerciseId(p.name),
                   matched: !!m, score: m ? m.score : 0,
                   sets: p.sets, rir: p.rir, bw: p.bw };
      exercises.push(ex);
      if (!m) unresolved.push(ex.name);
    });
    return { exercises: exercises, unresolved: unresolved, errors: errors };
  }
  // A starting catalogue so the first session parses against something. It is a seed, not
  // a whitelist: anything unrecognised is offered as a new exercise to confirm.
  const SEED_EXERCISES = [
    { id: 'bench-press', name: 'Bench press', aliases: ['bench', 'flat bench', 'barbell bench press'] },
    { id: 'incline-bench-press', name: 'Incline bench press', aliases: ['incline bench', 'incline barbell press'] },
    { id: 'dumbbell-bench-press', name: 'Dumbbell bench press', aliases: ['db bench', 'db press', 'dumbbell press'] },
    { id: 'incline-dumbbell-press', name: 'Incline dumbbell press', aliases: ['incline db press'] },
    { id: 'overhead-press', name: 'Overhead press', aliases: ['ohp', 'military press', 'standing press'] },
    { id: 'dumbbell-shoulder-press', name: 'Dumbbell shoulder press', aliases: ['db shoulder press', 'seated dumbbell press'] },
    { id: 'lateral-raise', name: 'Lateral raise', aliases: ['side raise', 'db lateral raise', 'lat raise'] },
    { id: 'rear-delt-fly', name: 'Rear delt fly', aliases: ['reverse fly', 'rear delt raise'] },
    { id: 'face-pull', name: 'Face pull', aliases: ['facepull', 'facepulls'] },
    { id: 'tricep-pushdown', name: 'Tricep pushdown', aliases: ['pushdown', 'cable pushdown', 'tricep extension'] },
    { id: 'skull-crusher', name: 'Skull crusher', aliases: ['lying tricep extension'] },
    { id: 'dip', name: 'Dip', aliases: ['dips', 'tricep dip'], bw: true },
    { id: 'push-up', name: 'Push-up', aliases: ['pushup', 'press up'], bw: true },
    { id: 'pull-up', name: 'Pull-up', aliases: ['pullup'], bw: true },
    { id: 'chin-up', name: 'Chin-up', aliases: ['chinup'], bw: true },
    { id: 'lat-pulldown', name: 'Lat pulldown', aliases: ['pulldown', 'lat pull down'] },
    { id: 'barbell-row', name: 'Barbell row', aliases: ['bent over row', 'bb row', 'pendlay row'] },
    { id: 'dumbbell-row', name: 'Dumbbell row', aliases: ['db row', 'one arm row', 'single arm row'] },
    { id: 'seated-cable-row', name: 'Seated cable row', aliases: ['cable row'] },
    { id: 'bicep-curl', name: 'Bicep curl', aliases: ['curl', 'db curl', 'dumbbell curl', 'barbell curl'] },
    { id: 'hammer-curl', name: 'Hammer curl', aliases: [] },
    { id: 'preacher-curl', name: 'Preacher curl', aliases: [] },
    { id: 'shrug', name: 'Shrug', aliases: ['barbell shrug', 'db shrug'] },
    { id: 'squat', name: 'Squat', aliases: ['back squat', 'barbell squat'] },
    { id: 'front-squat', name: 'Front squat', aliases: [] },
    { id: 'leg-press', name: 'Leg press', aliases: [] },
    { id: 'lunge', name: 'Lunge', aliases: ['walking lunge', 'db lunge'] },
    { id: 'bulgarian-split-squat', name: 'Bulgarian split squat', aliases: ['split squat'] },
    { id: 'deadlift', name: 'Deadlift', aliases: ['conventional deadlift'] },
    { id: 'romanian-deadlift', name: 'Romanian deadlift', aliases: ['stiff leg deadlift'] },
    { id: 'leg-curl', name: 'Leg curl', aliases: ['hamstring curl', 'lying leg curl'] },
    { id: 'leg-extension', name: 'Leg extension', aliases: ['quad extension'] },
    { id: 'calf-raise', name: 'Calf raise', aliases: ['standing calf raise', 'seated calf raise'] },
    { id: 'hip-thrust', name: 'Hip thrust', aliases: ['glute bridge'] },
    { id: 'plank', name: 'Plank', aliases: [], bw: true },
    { id: 'hanging-leg-raise', name: 'Hanging leg raise', aliases: ['leg raise'], bw: true }
  ];

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
    nutrientsFrom, resolvePTarget, capGrams, computeEntry, mineRepeats, macrosComplete,
    corridorDrift, DRIFT_MIN_DAYS, singularise,
    completeMacros, macroKcal, KCAL_PER_G,
    solveFridge, budgetCombos, scoreFood, rankFoods, defaultSelection, proteinFix, weightTrend,
    FOOD_PINS, foodPin, pinMatches, applyPin,
    fatEstimate, bmrMifflin, calibrateTDEE, corridorFromTDEE, mealPaceKcal, microStatus,
    freeSugarFraction, SUGAR_INTRINSIC, SUGAR_FREE,
    MICRO_REF, MICRO_KEYS, microRef, sumSuppMicros, ELEMENTAL_FRACTION, elementalMg,
    supplementDue, supplementNextDue, supplementWindow, supplementStats, isoWeekdayMon,
    repairJson, median, linearTrend,
    e1RM, setLoad, weightAt, classifyExercise, sessionMetrics, exerciseTrend, liftVsWeight,
    normalizeName, exerciseId, matchExercise, parseWorkoutLine, parseWorkout, SEED_EXERCISES,
    LIFT_REP_CAP, LIFT_MIN_SESSIONS, LIFT_FLAT_PCT, LIFT_RIR_DRIFT, LIFT_WINDOW_DAYS,
    liftWindowOpen, hhmmMinutes, isTrainingSplit, LIFT_OPEN_LEAD_MIN, LIFT_OPEN_TAIL_MIN,
    KCAL_PER_KG_FAT, mergeSyncStates, ternary
  };
});
