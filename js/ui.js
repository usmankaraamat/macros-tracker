// ui.js -- Shared UI primitives: status lines, spinners, toasts, undo, and the
// bottom sheets that replace alert/confirm/prompt.
//
// Native dialogs block the main thread, cannot be styled, and read as browser
// chrome inside an installed app. Everything here is in-app, focus-trapped,
// dismissible with Escape, and returns a promise so call sites stay linear.

// ---- status lines ----------------------------------------------------------
function setStatus(el, msg, cls){
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || '';
  el.className = 'tactical' + (cls ? ' '+cls : '');
  if (msg) announce(msg);
}
// Like setStatus but prepends a spinner — for in-flight network calls.
function busy(el, msg){
  if (!el) return;
  el.hidden = false;
  el.className = 'tactical';
  el.innerHTML = `<span class="spin"></span>${escapeHtml(msg)}`;
  announce(msg);
}
// Placeholder rows while a lookup is in flight, so the panel keeps its shape
// instead of collapsing and jumping the page under the user's thumb.
function skeleton(n){
  return Array.from({length: n || 3}, (_, i) =>
    `<div class="skeleton" style="width:${[92,74,83][i%3]}%"></div>`).join('');
}

// ---- screen-reader announcements -------------------------------------------
// Every status message shown visually is also spoken. Without this the whole
// parse / search / sync flow is silent to assistive tech.
function announce(msg){
  const el = document.getElementById('srLive');
  if (!el || !msg) return;
  el.textContent = '';                       // re-trigger even for a repeat message
  setTimeout(()=>{ el.textContent = msg; }, 30);
}

// ---- haptics ---------------------------------------------------------------
function prefersReducedMotion(){
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e){ return false; }
}
// A tick on a successful log (PWA on Android; silently ignored elsewhere).
function haptic(ms){
  try { if (navigator.vibrate && !prefersReducedMotion()) navigator.vibrate(ms || 18); } catch(e){}
}

// ---- toast + undo ----------------------------------------------------------
// Destructive actions are reversible for a few seconds rather than gated behind
// a confirm nobody reads. `undo` is a function that puts the world back.
let _toastTimer = null;
function toast(msg, opts){
  const o = opts || {};
  dismissToast();
  const el = document.createElement('div');
  el.className = 'toast' + (o.tone ? ' '+o.tone : '');
  el.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = msg;
  el.appendChild(text);

  if (o.undo){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = o.undoLabel || 'Undo';
    btn.onclick = ()=>{ dismissToast(); o.undo(); };
    el.appendChild(btn);
  }
  document.body.appendChild(el);
  announce(msg);
  _toastTimer = setTimeout(dismissToast, o.ms || (o.undo ? 6500 : 3200));
  return el;
}
function dismissToast(){
  clearTimeout(_toastTimer); _toastTimer = null;
  document.querySelectorAll('.toast').forEach(t => t.remove());
}

// ---- bottom sheets ---------------------------------------------------------
// One sheet at a time. Opening a second closes the first, so a stray call can
// never strand the user behind two backdrops.
let _sheetClose = null;

function openSheet(build){
  if (_sheetClose) _sheetClose(null);

  const restoreTo = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  backdrop.appendChild(sheet);

  return new Promise(resolve => {
    let settled = false;
    const close = (value)=>{
      if (settled) return;
      settled = true;
      _sheetClose = null;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (restoreTo && restoreTo.focus) { try { restoreTo.focus(); } catch(e){} }
      resolve(value);
    };
    _sheetClose = close;

    // Escape cancels; Tab is wrapped so focus can never leave the sheet.
    const onKey = (ev)=>{
      if (ev.key === 'Escape'){ ev.preventDefault(); close(null); return; }
      if (ev.key !== 'Tab') return;
      const f = sheet.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first){ ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last){ ev.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.onclick = (ev)=>{ if (ev.target === backdrop) close(null); };

    const autofocus = build(sheet, close);
    document.body.appendChild(backdrop);
    // Focus the field if there is one, else the safe (cancel) action.
    const target = autofocus || sheet.querySelector('input, textarea') ||
                   sheet.querySelector('button.ghost') || sheet.querySelector('button');
    if (target) { try { target.focus(); if (target.select) target.select(); } catch(e){} }
  });
}

function sheetHead(sheet, title, body){
  const h = document.createElement('h2');
  h.textContent = title;
  sheet.appendChild(h);
  sheet.setAttribute('aria-label', title);
  if (body){
    const p = document.createElement('p');
    p.textContent = body;
    sheet.appendChild(p);
  }
}

function sheetActions(sheet, confirmLabel, cancelLabel, tone, onConfirm, onCancel){
  const wrap = document.createElement('div');
  wrap.className = 'footer-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = cancelLabel || 'Cancel';
  cancel.onclick = onCancel;
  const ok = document.createElement('button');
  ok.type = 'button';
  if (tone === 'danger') ok.className = 'danger';
  ok.textContent = confirmLabel;
  ok.onclick = onConfirm;
  wrap.appendChild(cancel);
  wrap.appendChild(ok);
  sheet.appendChild(wrap);
  return ok;
}

// confirmSheet({...}) -> Promise<boolean>
// The confirm label always names the action it performs ("Close day", not "OK"),
// so the button reads the same as the control that opened it.
function confirmSheet(o){
  return openSheet((sheet, close)=>{
    sheetHead(sheet, o.title, o.body);
    sheetActions(sheet, o.confirmLabel || 'Confirm', o.cancelLabel, o.tone,
      ()=> close(true), ()=> close(false));
  }).then(v => v === true);
}

// alertSheet({...}) -> Promise<void>. For things that went wrong and carry no choice.
function alertSheet(o){
  return openSheet((sheet, close)=>{
    sheetHead(sheet, o.title, o.body);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = o.confirmLabel || 'Got it';
    btn.onclick = ()=> close(true);
    sheet.appendChild(btn);
    return btn;
  }).then(()=> undefined);
}

// promptSheet({...}) -> Promise<string|null>. Null means cancelled.
function promptSheet(o){
  return openSheet((sheet, close)=>{
    sheetHead(sheet, o.title, o.body);

    const field = document.createElement('div');
    field.className = 'sheet-field';
    const id = 'sheetField' + Date.now();
    if (o.label){
      const lab = document.createElement('label');
      lab.setAttribute('for', id);
      lab.textContent = o.label;
      field.appendChild(lab);
    }
    const input = document.createElement('input');
    input.id = id;
    input.type = o.type || 'text';
    if (o.type === 'number'){
      input.inputMode = 'decimal';
      input.step = o.step || 'any';
      input.min = o.min == null ? '0' : o.min;
    }
    input.value = o.value == null ? '' : String(o.value);
    input.placeholder = o.placeholder || '';
    input.autocomplete = 'off';
    field.appendChild(input);
    sheet.appendChild(field);

    const submit = ()=>{
      const v = input.value.trim();
      if (o.required && !v){ input.focus(); return; }
      close(v);
    };
    input.addEventListener('keydown', ev=>{
      if (ev.key === 'Enter'){ ev.preventDefault(); submit(); }
    });
    sheetActions(sheet, o.confirmLabel || 'Save', o.cancelLabel, null, submit, ()=> close(null));
    return input;
  });
}
