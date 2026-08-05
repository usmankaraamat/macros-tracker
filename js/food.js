// food.js -- Food resolution: the picker registry, USDA lookup, the AI parsers
// (Gemini + OpenRouter fallback), pending review, and meal photos.

// ---- FOOD PICKER ----
function initFoods(){
  const sel = document.getElementById('food');
  sel.innerHTML = Object.keys(foodBase).map(k=>`<option>${k}</option>`).join('');
}
// Register a resolved food into the picker + registry so it's selectable/reusable.
function registerFood(name, base, source){
  if (!foodBase[name]) {
    foodBase[name] = base;
    const opt = document.createElement('option');
    opt.textContent = name;
    document.getElementById('food').appendChild(opt);
  } else {
    foodBase[name] = base;                   // refresh in case values differ
  }
  if (source) foodSource[name] = source;
}

// ---- USDA FoodData Central ----
// Per-100g nutrients keyed by USDA nutrient number: 208 kcal, 203 protein,
// 204 fat, 205 carb, 301 calcium(mg), 305 phosphorus(mg).
function nutrientsFrom(food){ return LedgerCore.nutrientsFrom(food); }
// estKcal (optional): per-100g calorie prior for plausibility ranking — pass the AI's
// estimate so keyword cousins with absurd energy density ("cooking oil" → plantain oil
// at 100 kcal/100g) sink below the real thing.
async function usdaSearch(query, estKcal){
  if (!hasUSDA()) throw new Error('No USDA key — add one in ⚙ Settings.');
  const q = (query||'').trim();
  if (!q) return [];
  const pin = LedgerCore.foodPin(q);
  if (!pin) return usdaFetchRanked(q, q, estKcal);
  // Pinned ingredient: search USDA for the pinned description itself, so the entry we
  // want is actually in the ten results rather than buried behind the raw cuts. Rank
  // with the user's own words so the REST of the list still reflects what was asked for.
  const ranked = await usdaFetchRanked(pin.query, q, estKcal);
  if (ranked.some(f => LedgerCore.pinMatches(f, pin))) return LedgerCore.applyPin(ranked, pin);
  // USDA didn't return the pinned entry (description drift, or the dataType filter hid
  // it). Better a normal search on what the user said than whatever the pinned query
  // happened to hit — costs one extra call, and only on the failure path.
  return usdaFetchRanked(q, q, estKcal);
}
// apiQuery is what USDA is asked for; rankQuery is what the results are scored against.
// They differ only for pinned ingredients (see above).
async function usdaFetchRanked(apiQuery, rankQuery, estKcal){
  // POST with a JSON body — the documented form. Passing dataType as an array here
  // avoids the URL-encoding quirks that make the GET query 400 on spaces/parens.
  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?api_key='
    + encodeURIComponent(usdaKey());
  const body = JSON.stringify({
    query: apiQuery,
    dataType: ['Foundation','SR Legacy','Survey (FNDDS)'],
    pageSize: 10
  });
  // USDA's API is often slow (4–6s) and occasionally drops the connection outright.
  // Without a timeout a hung request spins forever; without a retry a single transient
  // drop surfaces as a bare "Failed to fetch" and (inside the AI-parse loop) silently
  // collapses that item to an AI estimate. So: abort a hung request and retry a
  // network-level failure once before giving up.
  let r, netErr;
  for (let attempt = 0; attempt < 2; attempt++){
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), 12000);
    try {
      r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body, signal: ctrl.signal });
      netErr = null; break;
    } catch(e){
      netErr = e;                                 // TypeError (Failed to fetch) or AbortError (timeout)
      if (attempt === 0) await new Promise(res => setTimeout(res, 600));
    } finally { clearTimeout(timer); }
  }
  if (netErr) throw new Error("Couldn't reach USDA — it may be slow or temporarily down. "
    + "Check your connection and try again.");
  if (r.status === 429) throw new Error('USDA API 429 — your key is rate-limited this hour, try later.');
  if (!r.ok) throw new Error('USDA API ' + r.status
    + (r.status===403 ? ' — key rejected' : r.status===400 ? ' — bad request' : ''));
  const d = await r.json();
  const foods = (d.foods||[]).map(f => ({ id:f.fdcId, name:f.description, base:nutrientsFrom(f) }));
  return LedgerCore.rankFoods(foods, rankQuery, estKcal);
}

// ---- Gemini model discovery ----
// Model names available to a key vary by account/region, so we can list them and
// auto-pick a working one rather than hardcoding a name that may be rejected.
async function listGeminiModels(){
  if (!hasGemini()) throw new Error('No Gemini key — add one in ⚙ Settings.');
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key='
    + encodeURIComponent(getKey(LS.gem)));
  if (!r.ok) throw new Error('Model list failed: Gemini API ' + r.status);
  const d = await r.json();
  return (d.models||[])
    .filter(m => (m.supportedGenerationMethods||[]).includes('generateContent'))
    .map(m => (m.name||'').replace(/^models\//,''))
    .filter(Boolean);
}
// Prefer the known-good default, then any newer flash-lite, and only then a full flash.
// flash-lite outranks flash deliberately: benchmarked on this app's own prompt, the lite
// tier matched the full tier on decomposition and per-100g estimates while running ~5x
// faster on far fewer tokens, and the full-flash models spend 1-2k thinking tokens per
// parse to no measurable benefit here. gemini-3.5-flash is excluded outright — it emits
// unbalanced JSON on this prompt (repairJson covers it, but don't pick it on purpose).
function pickModel(list){
  const ok = n => !/preview|thinking|image|tts|gemini-3\.5-flash$/.test(n);
  return list.find(n=>n==='gemini-3.5-flash-lite')
      || list.find(n=>/3\.\d.*flash-lite/.test(n) && ok(n))
      || list.find(n=>/flash-lite/.test(n) && ok(n))
      || list.find(n=>/flash/.test(n) && ok(n))
      || list.find(n=>/flash/.test(n))
      || list[0];
}

// ---- Gemini natural-language parse ----
// Returns items: {name, partOf, grams, weighed, est:{per-100g}}. Composite
// dishes are decomposed into base ingredients (USDA only has clean data for simple
// foods); partOf groups a dish's components in review. est is a fallback used only
// when USDA has no match — flagged so it never masquerades as authoritative.
function geminiGenerate(model, prompt, imageB64){
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(getKey(LS.gem));
  // Image (when present) goes first so the text reads as instructions about it.
  const parts = imageB64 ? [{inline_data:{mime_type:'image/jpeg', data:imageB64}}] : [];
  parts.push({text: prompt});
  return fetch(url, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      contents:[{parts}],
      generationConfig:{ responseMimeType:'application/json', temperature:0 }
    })
  });
}
// ---- OpenRouter fallback (per-user key; free vision models, rotated on limits) ----
const OR_MODELS = ['google/gemini-2.0-flash-exp:free',
                   'qwen/qwen2.5-vl-72b-instruct:free',
                   'meta-llama/llama-3.2-11b-vision-instruct:free'];
async function openrouterGenerate(prompt, imageB64){
  let lastErr;
  for (const m of OR_MODELS){
    try {
      const content = imageB64
        ? [{type:'image_url', image_url:{url:'data:image/jpeg;base64,'+imageB64}}, {type:'text', text:prompt}]
        : prompt;
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST',
        headers:{Authorization:'Bearer '+getKey(LS.or), 'Content-Type':'application/json'},
        body: JSON.stringify({ model:m, messages:[{role:'user', content}],
          response_format:{type:'json_object'}, temperature:0 })
      });
      // Rate-limited or model gone/unsupported → try the next free model.
      if (r.status===429 || r.status===404 || r.status===400){ lastErr = new Error('OpenRouter '+r.status+' on '+m); continue; }
      if (!r.ok){ const t = await r.text().catch(()=> ''); throw new Error('OpenRouter '+r.status+' '+t.slice(0,120)); }
      const d = await r.json();
      const txt = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '';
      if (!txt){ lastErr = new Error('empty response from '+m); continue; }
      return { txt, via: 'OpenRouter · '+m };
    } catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('All OpenRouter models failed.');
}

let AI_VIA = '';                               // which provider/model handled the last parse
// One completion from whichever provider is configured — Gemini first (auto-detecting a
// replacement model once if the configured one has gone), OpenRouter as the fallback.
// Returns raw text; every caller does its own parsing and its own validation.
async function aiComplete(prompt, imageB64){
  if (!hasAI()) throw new Error('No AI key — add a Gemini or OpenRouter key in ⚙ Settings.');
  let txt = '', gemErr = null;
  if (hasGemini()){
    try {
      let model = geminiModel();
      let r = await geminiGenerate(model, prompt, imageB64);
      // 404/400 → configured model not available for this key; auto-detect and retry once.
      if (r.status === 404 || r.status === 400) {
        const alt = pickModel(await listGeminiModels());
        if (!alt) throw new Error('No Gemini models support generateContent for this key.');
        setKey(LS.model, alt);
        const mf = document.getElementById('geminiModel'); if (mf) mf.value = alt;
        model = alt;
        r = await geminiGenerate(model, prompt, imageB64);
      }
      if (!r.ok){ const t = await r.text().catch(()=> ''); throw new Error('Gemini API '+r.status+' '+t.slice(0,140)); }
      const d = await r.json();
      txt = d.candidates && d.candidates[0] && d.candidates[0].content
        && d.candidates[0].content.parts && d.candidates[0].content.parts[0].text || '';
      if (!txt) throw new Error('Gemini returned no content (blocked or empty).');
      AI_VIA = 'Gemini · ' + model;
    } catch(e){ gemErr = e; txt = ''; }
  }
  if (!txt && hasOR()){
    const o = await openrouterGenerate(prompt, imageB64);   // throws if all models fail
    txt = o.txt; AI_VIA = o.via;
  }
  if (!txt) throw gemErr || new Error('No AI provider available.');
  return txt;
}
async function aiParse(text, imageB64){
  if (!hasAI()) throw new Error('No AI key — add a Gemini or OpenRouter key in ⚙ Settings.');
  const photoClause = imageB64
    ? `A photo of the meal is attached. Identify every food visible in it and estimate each portion's grams from visual cues (plate size, utensils, typical serving volumes). The text below adds context or corrections — when it states an amount or names a food, the text wins over your visual guess. If the text is empty, work from the photo alone.\n`
    : '';
  const prompt =
`You convert a meal description into structured food items for a macro tracker.
${photoClause}
Break composite or prepared dishes (samosa, biryani, sandwich, burger, pizza slice, curry, paratha, wrap, etc.) into their base single-ingredient components — the nutrient database only has reliable data for simple ingredients, not assembled dishes. Each component gets its own estimated grams; the components of one dish should sum to roughly that dish's total weight. When a dish is fried, oily, or served in a curry or gravy, add a "cooking oil" component for the absorbed fat — with a realistic gram estimate, since this is the only place that fat gets counted.
Leave naturally single-ingredient foods (an egg, an apple, grilled chicken, rice, milk) as ONE item — never split those. Also keep everyday breads and flatbreads that the database stores as finished items — chapati, roti, naan, tortilla, pita, plain bread, idli, dosa — as ONE item under their common name (e.g. "chapati", "roti"); do NOT split those into flour and water.
Never output water, ice, plain black coffee or unsweetened tea, or any other zero-calorie liquid as an item — they carry no macros and only distort the totals.
Return JSON: {"items":[{"name":<short generic single-ingredient name good for a USDA database search>,`+
`"partOf":<the dish this component came from, or "" if it was logged as a plain food>,`+
`"grams":<number, estimate a realistic portion if none is stated>,`+
`"weighed":<boolean, true ONLY if the user gave an explicit weight/measure for THIS component; a decomposed guess is false>,`+
`"est":{"kcal":<per 100g>,"p":<protein g per 100g>,"f":<fat g per 100g>,"c":<carb g per 100g>}}]}.
"est" is your best per-100g estimate, used only as a fallback. Output JSON only, no prose.
Meal: """${text}"""`;

  const txt = await aiComplete(prompt, imageB64);

  // Models are flaky with strict JSON mode — free ones wrap it in prose, and some paid ones
  // (measured: gemini-3.5-flash) end an otherwise perfect reply one closing brace short.
  // repairJson balances the brackets rather than regex-slicing, which handles both.
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch(e){
    parsed = LedgerCore.repairJson(txt);
    if (!parsed) throw new Error('Could not parse AI JSON.');
  }
  const items = Array.isArray(parsed) ? parsed : (parsed.items || []);
  if (!items.length) throw new Error('No foods recognised.');
  // Safety net: some models still emit a plain-water/ice component despite the prompt.
  // It carries no macros yet USDA matches "water" to a spurious ~40 kcal entry — drop it.
  const cleaned = items.filter(it => {
    const n = String(it && it.name || '').trim().toLowerCase();
    const estK = it && it.est && +it.est.kcal;
    const zeroLiquid = /^(water|ice|iced water|plain water|tap water|cold water|hot water)$/.test(n)
      || (/\bwater\b/.test(n) && (!estK || estK < 5));   // "rose water" etc. with ~0 kcal
    return !zeroLiquid;
  });
  return cleaned.length ? cleaned : items;
}

// ---- PENDING (AI review) ----
// Resolve a pending item's active choice (a USDA candidate or the AI estimate).
function pendResolve(p){
  if (p.sel==='est' || !p.candidates.length)
    return {base: p.estBase || {kcal:0,p:0,f:0,c:0}, source:'AI est', label: p.name};
  const c = p.candidates[+p.sel.slice(1)] || p.candidates[0];
  return {base: c.base, source:'USDA', label: c.name};
}
function pendWarn(p){
  const r = pendResolve(p);
  if (r.source==='USDA' && p.estBase && p.estBase.kcal>0 &&
      Math.abs(r.base.kcal - p.estBase.kcal)/p.estBase.kcal > 0.25)
    return `USDA ${Math.round(r.base.kcal)} vs AI est ${Math.round(p.estBase.kcal)} kcal/100g — check the match`;
  return '';
}
// Capture live input state back into `pending` so a re-render doesn't lose edits.
function syncPendingFromDOM(){
  pending.forEach((p,i)=>{
    const g=document.getElementById('pg'+i); if(g && g.value!=='') p.grams=parseFloat(g.value);
    const s=document.getElementById('ps'+i); if(s) p.include=s.checked;
    const w=document.getElementById('pw'+i); if(w) p.weighed=w.checked;
    const f=document.getElementById('pf'+i); if(f) p.sel=f.value;
  });
}
// Aggregate what the currently-selected pending items would contribute if added —
// runs the same computeEntry (penalties and all) so the preview matches the ledger.
function pendingTotals(){
  return pending.reduce((t,p)=>{
    if (!p.include || !p.grams || p.grams<=0) return t;
    const r = pendResolve(p);
    const e = computeEntry(p.name, p.grams, p.weighed, r.base, r.source);
    t.kcal+=e.kcal; t.p+=e.p; t.f+=e.f; t.c+=e.c; t.n++;
    return t;
  }, {kcal:0,p:0,f:0,c:0,n:0});
}
// One pending item's own macro contribution at its current grams/selection — the same
// computeEntry the ledger and the overall summary use, so the per-item line reconciles
// with the total. Shown even when the item is unchecked (its would-be contribution).
function pendItemMacroStr(p){
  const g = +p.grams || 0;
  if (!g || g <= 0) return '—';
  const r = pendResolve(p);
  const e = computeEntry(p.name, g, p.weighed, r.base, r.source);
  return `${Math.round(e.kcal)} kcal · ${e.p.toFixed(1)}P · ${e.f.toFixed(1)}F · ${e.c.toFixed(1)}C`;
}
// Refresh just the per-item macro lines (grams typing keeps focus, so no full rebuild).
function updatePendItemMacros(){
  pending.forEach((p,i)=>{
    const el = document.getElementById('pm'+i);
    if (!el) return;
    const g = +p.grams || 0;
    el.textContent = pendItemMacroStr(p);
    el.classList.toggle('zero', !(g > 0) || !p.include);
  });
}
function pendSummaryHTML(){
  const t = pendingTotals();
  if (!t.n) return `<div class="pend-summary"><span class="ink-dim">Nothing selected.</span></div>`;
  const after = totals().kcal + t.kcal;
  const st = corridorState(after);
  // Only a projection that lands out of tolerance is coloured — landing inside
  // the corridor is the expected outcome and reads in plain chalk.
  const tone = st.key === 'breach' ? 'var(--hot)' : st.key === 'under' ? 'var(--brass)' : 'var(--chalk)';
  return `<div class="pend-summary">
    <div class="ps-row"><span>This meal · ${t.n} item${t.n>1?'s':''}</span>
      <span class="ps-macros"><b>${Math.round(t.kcal)}</b> kcal · <b>${t.p.toFixed(0)}</b>P · <b>${t.f.toFixed(0)}</b>F · <b>${t.c.toFixed(0)}</b>C</span></div>
    <div class="ps-row ps-day"><span>Day after adding</span>
      <span><b style="color:${tone}">${Math.round(after)}</b> / ${Math.round(FLOOR)}–${Math.round(CEIL)} kcal · ${st.label}</span></div>
  </div>`;
}
function updatePendSummary(){
  const el = document.getElementById('pendSummaryWrap');
  if (el) el.innerHTML = pendSummaryHTML();
}

// One reviewable ingredient card. `i` is the pending index — its DOM ids stay stable
// regardless of grouping so syncPendingFromDOM keeps working by index.
function renderPendItem(p, i){
  const r = pendResolve(p);
  const badge = `<span class="badge ${r.source==='USDA'?'usda':'est'}">${r.source}</span>`;
  const kc = Math.round(r.base.kcal||0);
  const opts = p.candidates.map((c,idx)=>
    `<option value="u${idx}" ${p.sel==='u'+idx?'selected':''}>${escapeHtml(c.name)} · ${Math.round(c.base.kcal)} kcal/100g</option>`).join('')
    + (p.estBase ? `<option value="est" ${p.sel==='est'?'selected':''}>AI estimate · ${Math.round(p.estBase.kcal)} kcal/100g</option>` : '');
  const picker = (p.candidates.length || p.estBase)
    ? `<select id="pf${i}" style="margin-top:6px;font-size:11px">${opts}</select>` : '';
  const warn = pendWarn(p);
  const warnLine = warn ? `<div class="tactical bad" style="margin-top:6px;font-size:10px;padding-left:8px">${warn}</div>` : '';
  const qv = (p.name||'').replace(/"/g,'&quot;');
  return `<div class="pend-item">
    <div class="pend-top">
      <input type="checkbox" id="ps${i}" ${p.include?'checked':''} style="width:auto">
      <span class="pname">${badge} ${escapeHtml(p.name)} <span style="color:var(--graphite);font-family:var(--data);font-size:10px">${kc} kcal/100g</span></span>
      <input type="number" id="pg${i}" value="${Math.round(p.grams)}" min="0" step="1" title="grams">
    </div>
    ${picker}
    <div class="pend-macros num ${(+p.grams>0 && p.include)?'':'zero'}" id="pm${i}">${pendItemMacroStr(p)}</div>
    <div class="pend-research">
      <input type="text" id="pq${i}" value="${qv}" placeholder="wrong match? type a better USDA term">
      <button class="sm ghost" data-research="${i}" title="Search USDA for this term">&#8635;</button>
    </div>
    <div class="pend-tog">
      <label class="chk"><input type="checkbox" id="pw${i}" ${p.weighed?'checked':''}> weighed</label>
    </div>
    ${warnLine}
  </div>`;
}
// Re-run a USDA search for one component with a user-supplied term — the fix when the
// AI's search word matched the wrong food (e.g. "maida" → wheat flour, not all-purpose).
async function researchPending(i){
  const inp = document.getElementById('pq'+i);
  const q = (inp && inp.value || '').trim();
  if (!q) return;
  syncPendingFromDOM();                              // keep other edits (grams, toggles, picks)
  const btn = document.querySelector(`[data-research="${i}"]`);
  if (btn){ btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
  try {
    const cands = (await usdaSearch(q, pending[i].estBase && pending[i].estBase.kcal)).slice(0,6);
    if (cands.length){ pending[i].candidates = cands; pending[i].sel = 'u0'; pending[i].name = q; }
    else if (btn){ btn.disabled = false; btn.textContent = '∅'; return; }
  } catch(e){ if (btn){ btn.disabled = false; btn.textContent = '!'; } return; }
  renderPending();
}
function renderPending(){
  const wrap = document.getElementById('pending');
  if (!pending.length){ wrap.innerHTML=''; syncComposerTray(); return; }
  // Order into blocks: each dish (non-empty partOf) collects its components in first-seen
  // order; plain foods are their own singleton blocks. Ids stay keyed on the pending index.
  const blocks = [], seen = {};
  pending.forEach((p,i)=>{
    const dish = p.partOf || '';
    if (dish){
      if (seen[dish]==null){ seen[dish]=blocks.length; blocks.push({dish, idxs:[i]}); }
      else blocks[seen[dish]].idxs.push(i);
    } else blocks.push({dish:'', idxs:[i]});
  });
  wrap.innerHTML = blocks.map(b=>{
    const items = b.idxs.map(i=>renderPendItem(pending[i], i)).join('');
    if (!b.dish) return items;
    const gTotal = b.idxs.reduce((s,i)=> s + (pending[i].include ? (+pending[i].grams||0) : 0), 0);
    return `<div class="pend-group">
      <div class="pend-group-head">🍽️ ${escapeHtml(b.dish)}
        <span class="pgh-meta">${b.idxs.length} ingredient${b.idxs.length>1?'s':''} · ${Math.round(gTotal)}g</span></div>
      ${items}
    </div>`;
  }).join('')
  // Totals and the two verdict buttons stay pinned to the foot of the tray: with
  // a dish split into eight ingredients, "what will this do to my day" and "add
  // it" must not be something you have to scroll a list to reach.
  + `<div class="pend-foot">
       <div id="pendSummaryWrap"></div>
       <div class="footer-actions">
         <button id="addPendingBtn">Add selected to ledger</button>
         <button class="ghost" id="discardBtn">Discard</button>
       </div>
     </div>`;
  updatePendSummary();
  document.getElementById('addPendingBtn').onclick = commitPending;
  document.getElementById('discardBtn').onclick = clearParseReview;
  wrap.querySelectorAll('[data-research]').forEach(btn=>{
    btn.onclick = ()=> researchPending(+btn.dataset.research);
  });
  wrap.querySelectorAll('input[id^="pq"]').forEach(inp=>{
    inp.addEventListener('keydown', ev=>{ if (ev.key==='Enter'){ ev.preventDefault(); researchPending(+inp.id.slice(2)); } });
  });
  // Live totals: typing grams updates just the summary (keeps focus); a discrete toggle
  // or candidate swap rebuilds the list. The re-search term box is exempt from rebuilds
  // so an in-progress query isn't wiped when it loses focus.
  wrap.oninput  = ev => { if (ev.target.id && ev.target.id.startsWith('pq')) return; syncPendingFromDOM(); updatePendItemMacros(); updatePendSummary(); };
  wrap.onchange = ev => { if (ev.target.id && ev.target.id.startsWith('pq')) return; syncPendingFromDOM(); renderPending(); };
  syncComposerTray();
}
// Put the composer back to a bare input: no status, no list, tray closed.
function clearParseReview(){
  pending = [];
  setStatus(document.getElementById('parseStatus'), '');
  renderPending();
}
function commitPending(){
  syncPendingFromDOM();
  let added = 0;
  pending.forEach(p=>{
    if (!p.include || !p.grams || p.grams<=0) return;
    const r = pendResolve(p);
    const name = r.source==='USDA' ? r.label : p.name;   // log under the real matched food name
    registerFood(name, r.base, r.source);
    pushEntry(computeEntry(name, p.grams, p.weighed, r.base, r.source));
    added++;
  });
  // Nothing to add means the review isn't finished — keep the list up, or the
  // advice to tick an item would be about a list that just vanished.
  if (!added){
    toast('Nothing selected — tick at least one item and give it grams.', { tone:'warn' });
    return;
  }
  const before = ledger.slice(0, ledger.length - added);
  clearParseReview();
  haptic(); save(); render();
  document.getElementById('nlInput').value = '';
  autoGrow();                                  // collapse the composer back to one line
  setMealPhoto(null);
  toast(`Logged ${added} ${added === 1 ? 'item' : 'items'}`,
    { undo: ()=>{ ledger = before; save(); render(); } });
}

// ---- Meal photo: downscaled client-side, sent to Gemini alongside the text ----
let mealPhotoB64 = null;                       // base64 JPEG body (no data: prefix), or null
function setMealPhoto(b64, label){
  mealPhotoB64 = b64;
  const chip = document.getElementById('photoChip');
  chip.hidden = !b64;
  if (b64){
    document.getElementById('photoThumb').src = 'data:image/jpeg;base64,' + b64;
    document.getElementById('photoName').textContent = label || 'meal photo';
  }
}
// Longest edge ≤1024px, JPEG q0.8 — small enough to inline, detailed enough to count rotis.
// Round-tripping through canvas also strips EXIF/location metadata before upload.
function shrinkImage(file){
  return new Promise((res, rej)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      res(cv.toDataURL('image/jpeg', 0.8).split(',')[1]);
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); rej(new Error('Could not read that image.')); };
    img.src = url;
  });
}
document.getElementById('photoBtn').onclick = ()=> document.getElementById('photoFile').click();
document.getElementById('galleryBtn').onclick = ()=> document.getElementById('photoGallery').click();
document.getElementById('photoClear').onclick = ()=> setMealPhoto(null);
// Shared by both the camera and gallery inputs — same downscale/attach path.
async function handlePhotoPick(ev){
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  const status = document.getElementById('parseStatus');
  try { setMealPhoto(await shrinkImage(file), file.name); setStatus(status, 'Photo attached — add notes if you like, then Parse meal.'); }
  catch(e){ setStatus(status, e.message, 'bad'); }
  syncComposerTray();
}
document.getElementById('photoFile').onchange = handlePhotoPick;
document.getElementById('photoGallery').onchange = handlePhotoPick;

// AI meal parse → resolve each item against USDA, else keep the AI estimate.
document.getElementById('parseBtn').onclick = async ()=>{
  const text = document.getElementById('nlInput').value.trim();
  const status = document.getElementById('parseStatus');
  if (!text && !mealPhotoB64){ document.getElementById('nlInput').focus(); return; }
  closeComposerMenu();
  busy(status, mealPhotoB64 ? 'Reading photo with AI…' : 'Parsing with AI…');
  syncComposerTray();                          // the tray is where progress shows
  const btn = document.getElementById('parseBtn'); btn.disabled = true;
  try {
    const items = await aiParse(text, mealPhotoB64);
    busy(status, `Parsed ${items.length} item(s). Resolving nutrients via USDA…`);
    pending = [];
    for (const it of items){
      const estBase = (it.est && it.est.kcal!=null)
        ? {kcal:+it.est.kcal||0, p:+it.est.p||0, f:+it.est.f||0, c:+it.est.c||0} : null;
      let candidates = [];
      if (hasUSDA() && it.name){
        try { candidates = (await usdaSearch(it.name, estBase && estBase.kcal)).slice(0,6); }
        catch(e){ /* fall back to AI estimate */ }
      }
      pending.push({
        name: it.name || 'unknown',
        partOf: (it.partOf || '').trim(),         // dish this component was split from ('' = plain food)
        grams: Number(it.grams) || 0,
        weighed: !!it.weighed,
        candidates, estBase,
        // Default to the best plausible USDA match; fall back to the AI estimate when the
        // top match's calories are wildly off the estimate (USDA returned the wrong food).
        // A pinned ingredient (e.g. chicken → cooked breast) skips both and takes the pin.
        sel: LedgerCore.defaultSelection(candidates, estBase && estBase.kcal, LedgerCore.foodPin(it.name)),
        include: true
      });
    }
    const nUsda = pending.filter(p=>p.sel!=='est').length;
    // Terse: the tray is short and the list below it now says "check me" on its
    // own, so the status line reports provenance and gets out of the way.
    setStatus(status, `${pending.length} item${pending.length>1?'s':''} via ${AI_VIA} · ${nUsda} USDA, ${pending.length-nUsda} AI-estimated`);
    setMealPhoto(null);                        // consumed — don't leak into the next parse
    renderPending();                           // opens the tray under the bar; no page jump
  } catch(err){
    setStatus(status, err.message, 'bad');
    pending = []; renderPending();
  } finally { btn.disabled = !hasAI(); }
};

document.getElementById('addBtn').onclick = ()=>{
  const name = document.getElementById('food').value;
  const grams = parseFloat(document.getElementById('grams').value);
  if (!grams || grams<=0){ document.getElementById('grams').focus(); return; }
  const e = computeEntry(name, grams,
    document.getElementById('weighed').checked,
    getBase(name), foodSource[name] || 'DB');
  pushEntry(e);
  document.getElementById('grams').value='';
  clearProjection(); haptic();
  save(); render();
  toast(`Logged ${e.name} · ${grams}g`,
    { undo: ()=>{ ledger.pop(); save(); render(); } });
};

// Keyboard: Enter logs / searches. In the composer Enter sends, the way a chat
// bar does; Shift+Enter is the newline.
document.getElementById('grams').addEventListener('keydown', e=>{ if (e.key==='Enter') document.getElementById('addBtn').click(); });
document.getElementById('usdaSearch').addEventListener('keydown', e=>{ if (e.key==='Enter') document.getElementById('usdaBtn').click(); });
document.getElementById('nlInput').addEventListener('keydown', e=>{
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  document.getElementById('parseBtn').click();
});
