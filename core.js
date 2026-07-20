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
    return { kcal, p, f, c, ca: g('301'), ph: g('305') };
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
      c: (base.c || 0) * s, ca: (base.ca || 0) * s, ph: (base.ph || 0) * s, flags: []
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
    mergeSyncStates, ternary
  };
});
