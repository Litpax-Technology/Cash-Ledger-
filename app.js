'use strict';
/* Owner Cash Ledger — frontend logic (JSONP to Google Apps Script) */

const ROLES = ['Owner', 'Admin', 'HR', 'Employee', 'Technician'];     // login ke baad server ki "Role List" se bharte hain
const CASH_ROLES = ['Admin', 'HR', 'Employee', 'Technician'];            // "Cash leta hai" wale roles
const S = { token: null, me: null, cfg: null, settings: null, persons: [], employees: [], view: null, params: {}, f: {} };

/* =========================== Utilities =========================== */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Number(v) || 0;
const inr = n => '₹' + num(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const monthStart = () => today().slice(0, 8) + '01';
const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
const sum = (arr, k) => arr.reduce((s, o) => s + num(o[k]), 0);
const role = () => S.me && S.me.role;
const isOwner = () => role() === 'Owner';
const isAdmin = () => role() === 'Admin';
const isMgr = () => ['Owner', 'Admin'].includes(role());
const isAdvMgr = () => !!(S.mods && S.mods.advances && S.mods.advances.manage);   // Role access se (default HR)
const debounce = (fn, ms = 350) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('ocl_' + k) || 'null'); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('ocl_' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('ocl_' + k); } catch (e) {} }
};

function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'ok' : 'bad');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.className = 'toast', 3000);
}

/* =========================== API =========================== */
function jsonp(action, params = {}) {
  return new Promise((resolve, reject) => {
    const cb = 'jp_' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(true); reject(new Error('timeout')); }, CONFIG.TIMEOUT_MS);
    // late jawab aaye toh "jp_… is not defined" error na aaye — khaali callback chhod do
    function cleanup(late) { clearTimeout(timer); if (late) window[cb] = () => { delete window[cb]; }; else delete window[cb]; s.remove(); }
    window[cb] = res => { cleanup(); resolve(res); };
    const qs = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    s.src = CONFIG.API_URL + '?action=' + action + '&callback=' + cb +
      (S.token ? '&token=' + encodeURIComponent(S.token) : '') + (qs ? '&' + qs : '');
    s.onerror = () => { cleanup(); reject(new Error('network')); };
    document.body.appendChild(s);
  });
}

/* sirf padhne wali actions — inhe timeout pe ek baar dobara bhejna safe hai */
const READ_ACTIONS = ['bootstrap', 'dashboard', 'approvals', 'listVouchers', 'voucherDetail', 'listExpenses', 'ledger',
  'listAdvances', 'advanceDetail', 'employeeAdvances', 'listEmployees', 'listUsers', 'configAll', 'listRoles',
  'ticketList', 'ticketDetail', 'scrapBoot', 'scrapKhata', 'scrapSummary'];
async function jsonpRetry(action, params) {
  try { return await jsonp(action, params); }
  catch (e) {
    if (READ_ACTIONS.indexOf(action) === -1) throw e;
    return jsonp(action, params);                       // ek baar aur (server pehli baar slow tha)
  }
}

/* returns: response object (check .ok) or null on network failure */
async function call(action, params = {}, quiet = false) {
  try {
    const r = await jsonpRetry(action, params);
    if (r && r.error === 'AUTH') { toast(r.message || 'Session expired', false); logout(); return null; }
    if (!r || !r.ok) { if (!quiet) toast((r && r.message) || 'Something went wrong', false); return r || null; }
    return r;
  } catch (e) {
    if (!quiet) toast('Network problem — your data is kept, please try again', false);
    return null;
  }
}

/* ---- Instant pages: show the last data at once, refresh in background ---- */
const MEMO = new Map(), FRESH_MS = 20000;        // data younger than 20 s is not fetched again
const keyOf = (a, p) => a + '|' + Object.keys(p || {}).sort().map(k => k + '=' + p[k]).join('&');
function memoSet(a, p, r) { MEMO.set(keyOf(a, p), { s: JSON.stringify(r), t: Date.now() }); }
function markStale() { MEMO.forEach(v => { v.t = 0; }); }   // show cached, but refetch at once
function dropCache() { MEMO.clear(); }                         // after any save: old data is never shown again
async function load(action, params, render, host) {
  const key = keyOf(action, params), hit = MEMO.get(key);
  const tok = host ? (host._tok = (host._tok || 0) + 1) : 0;
  if (hit) {
    render(JSON.parse(hit.s), true);
    if (Date.now() - hit.t < FRESH_MS) return;
  }
  const r = await call(action, params, !!hit);
  if (host && (host._tok !== tok || !document.body.contains(host))) return;   // user moved on
  if (r && r.ok) {
    const fresh = JSON.stringify(r);
    MEMO.set(key, { s: fresh, t: Date.now() });
    if (!hit || fresh !== hit.s) render(r, false);
  } else if (!hit) render(r, false);
}

/* submit with double-submit guard; keeps form data on failure */
async function submit(form, action, params) {
  if (form.dataset.busy === '1') return null;
  form.dataset.busy = '1';
  const btns = $$('button[type=submit]', form);
  const labels = btns.map(b => b.innerHTML);
  btns.forEach(b => { b.disabled = true; b.innerHTML = '<span class="spinner"></span>Saving…'; });
  try {
    const r = await call(action, params);
    if (r && r.ok) dropCache();
    return r && r.ok ? r : null;
  } finally {
    form.dataset.busy = '0';
    btns.forEach((b, i) => { b.disabled = false; b.innerHTML = labels[i]; });
  }
}

/* run a one-click action from a button with guard */
async function act(btn, action, params, okMsg) {
  if (btn.disabled) return null;
  const label = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + label;
  const r = await call(action, params);
  btn.disabled = false; btn.innerHTML = label;
  if (r && r.ok) { dropCache(); if (okMsg) toast(okMsg); return r; }
  return null;
}

/* bill upload — POST (too large for JSONP) */
async function uploadBill(file) {
  if (file.size > CONFIG.MAX_BILL_MB * 1024 * 1024) throw new Error('File is larger than ' + CONFIG.MAX_BILL_MB + ' MB');
  const { data, mime } = await prepareFile(file);
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'uploadBill', token: S.token, mime, data })
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.message || 'Upload failed');
  return j.url;
}

function prepareFile(file) {
  return new Promise((resolve, reject) => {
    if (file.type === 'application/pdf') {
      const fr = new FileReader();
      fr.onload = () => resolve({ mime: 'application/pdf', data: String(fr.result).split(',')[1] });
      fr.onerror = () => reject(new Error('Could not read file'));
      fr.readAsDataURL(file);
      return;
    }
    if (!/^image\//.test(file.type)) return reject(new Error('Only image or PDF bills are allowed'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = CONFIG.BILL_MAX_PX;
      let { width: w, height: h } = img;
      if (w > max || h > max) { const k = max / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve({ mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.75).split(',')[1] });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

/* =========================== UI helpers =========================== */
function badge(status, overdue) {
  const cls = {
    'Pending Confirm': 'b-pending', 'Open': 'b-open', 'Closed': 'b-closed', 'Rejected': 'b-rejected',
    'Confirmed': 'b-done', 'Outstanding': 'b-pending', 'Partly Recovered': 'b-open', 'Recovered': 'b-done',
    'Active': 'b-open', 'Inactive': 'b-closed'
  }[status] || 'b-closed';
  return `<span class="badge ${cls}">${esc(status)}</span>` + (overdue ? ' <span class="badge b-rejected">Overdue</span>' : '');
}
function kpi(label, value, sub, opts = {}) {
  return `<div class="kpi fade-in ${opts.go ? 'clickable' : ''} ${opts.hl ? 'hl' : ''}" ${opts.go ? `data-go="${opts.go}"` : ''}>
    <div class="kpi-l">${esc(label)}</div><div class="kpi-v">${value}</div>${sub ? `<div class="kpi-s">${esc(sub)}</div>` : ''}</div>`;
}
const skel = (n = 5) => '<div class="skeleton"></div>'.repeat(n);
const emptyBox = msg => `<div class="empty"><svg class="empty-ic" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="12" width="32" height="26" rx="5"/><path d="M8 26h9l3 4h8l3-4h9"/><path d="M18 6l2 4M30 6l-2 4M24 4v5"/></svg><div>${esc(msg)}</div></div>`;

/* person avatar: initials on a navy/blue tint picked from the name (single accent family) */
const AV_TINTS = ['#0b1f3a', '#1d4ed8', '#1e3a8a', '#13294d', '#2563eb', '#1e40af'];
function avatar(name, size = '') {
  const n = String(name || '?').trim();
  const ini = n.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="av ${size ? 'av-' + size : ''}" style="background:${AV_TINTS[h % AV_TINTS.length]}">${esc(ini)}</span>`;
}
const who = (name, sub) => `<span class="who-cell">${avatar(name, 'sm')}<span>${esc(name)}${sub ? ` <span class="muted sm">${esc(sub)}</span>` : ''}</span></span>`;
const vTitle = v => (v.Purpose && v.Purpose !== 'General') ? v.Purpose : (v.Remarks ? String(v.Remarks).slice(0, 48) : 'Cash from Owner');
const pid = name => (S.personIds || {})[name] || '';
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';

function helloCard(sub, actions) {
  const h = new Date().getHours(), g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `<div class="hello fade-in">
    <div class="hello-l">${avatar(S.me.name, 'lg')}<div><div class="hello-t">${g}, ${esc(firstName(S.me.name))}</div><div class="hello-s">${sub}</div></div></div>
    ${actions ? `<div class="hello-a">${actions}</div>` : ''}</div>`;
}

/* numbers in KPI cards count up once per session per page */
function animateNums(root, key) {
  S.anim = S.anim || {};
  if (S.anim[key] || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  S.anim[key] = true;
  $$('.kpi-v, .stat b', root).forEach(el => {
    const txt = el.textContent.trim(), money = txt[0] === '₹', to = Number(txt.replace(/[^\d.-]/g, ''));
    if (!isFinite(to) || to === 0) return;
    const t0 = performance.now(), dur = 900;
    const tick = t => {
      const k = Math.min(1, (t - t0) / dur), v = Math.round(to * (1 - Math.pow(1 - k, 3)));
      el.textContent = money ? inr(v) : String(v);
      if (k < 1) requestAnimationFrame(tick); else el.textContent = txt;
    };
    requestAnimationFrame(tick);
  });
}

/* ---- 30-day trend: two lines (Given / Spent), crosshair + tooltip ---- */
const TREND = { W: 760, H: 230, l: 54, r: 14, t: 14, b: 30, given: '#0b1f3a', spent: '#7aa7ff' };
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v || 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const shortInr = v => v >= 1e5 ? '₹' + +(v / 1e5).toFixed(1) + 'L' : v >= 1e3 ? '₹' + +(v / 1e3).toFixed(1) + 'k' : '₹' + v;
const dLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function trendChart(t) {
  if (!t || !t.length) return '';
  const C = TREND, max = niceMax(Math.max(1, ...t.map(d => Math.max(d.given, d.spent))));
  const x = i => C.l + i * (C.W - C.l - C.r) / (t.length - 1);
  const y = v => C.t + (C.H - C.t - C.b) * (1 - v / max);
  const line = k => t.map((d, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(d[k]).toFixed(1)).join(' ');
  const tg = t.reduce((s, d) => s + d.given, 0), ts = t.reduce((s, d) => s + d.spent, 0);
  const grid = [0, .5, 1].map(f => `<line x1="${C.l}" x2="${C.W - C.r}" y1="${y(max * f)}" y2="${y(max * f)}" class="tg"/>
    <text x="${C.l - 8}" y="${y(max * f) + 4}" text-anchor="end" class="tl">${shortInr(max * f)}</text>`).join('');
  const xl = t.map((d, i) => ((i % 7 === 0 && i < t.length - 4) || i === t.length - 1) ? `<text x="${x(i)}" y="${C.H - 8}" text-anchor="${i === 0 ? 'start' : i === t.length - 1 ? 'end' : 'middle'}" class="tl">${dLabel(d.d)}</text>` : '').join('');
  return `<div class="card trend fade-in"><div class="card-h">Cash given vs spent <span class="muted">last 30 days</span><span class="spacer"></span>
      <span class="lgd"><i style="background:${C.given}"></i>Given <b>${inr(tg)}</b></span>
      <span class="lgd"><i style="background:${C.spent}"></i>Spent <b>${inr(ts)}</b></span></div>
    <div class="card-b"><div class="trend-wrap">
      <svg class="trend-svg" viewBox="0 0 ${C.W} ${C.H}" role="img" aria-label="Cash given and spent per day, last 30 days">
        ${grid}${xl}
        <path d="${line('given')} L${x(t.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z" class="ta"/>
        <path d="${line('given')}" class="tline" stroke="${C.given}"/>
        <path d="${line('spent')}" class="tline" stroke="${C.spent}"/>
        <g class="tx-hover" style="display:none"><line class="tcross" y1="${C.t}" y2="${C.H - C.b}"/>
          <circle r="5" class="tdot" fill="${C.given}"/><circle r="5" class="tdot" fill="${C.spent}"/></g>
        <rect class="thit" x="${C.l}" y="0" width="${C.W - C.l - C.r}" height="${C.H}"/>
      </svg><div class="ttip" style="display:none"></div></div></div></div>`;
}

function bindTrend(root, t) {
  const svg = $('.trend-svg', root); if (!svg) return;
  const C = TREND, max = niceMax(Math.max(1, ...t.map(d => Math.max(d.given, d.spent))));
  const x = i => C.l + i * (C.W - C.l - C.r) / (t.length - 1);
  const y = v => C.t + (C.H - C.t - C.b) * (1 - v / max);
  const g = $('.tx-hover', svg), dots = $$('.tdot', svg), cross = $('.tcross', svg), tip = $('.ttip', root);
  const move = e => {
    const r = svg.getBoundingClientRect(), vx = (e.clientX - r.left) * C.W / r.width;
    const i = Math.max(0, Math.min(t.length - 1, Math.round((vx - C.l) / ((C.W - C.l - C.r) / (t.length - 1)))));
    const d = t[i], px = x(i);
    g.style.display = ''; cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    dots[0].setAttribute('cx', px); dots[0].setAttribute('cy', y(d.given));
    dots[1].setAttribute('cx', px); dots[1].setAttribute('cy', y(d.spent));
    tip.innerHTML = `<b>${dLabel(d.d)}</b><div><i style="background:${C.given}"></i>Given <span>${inr(d.given)}</span></div><div><i style="background:${C.spent}"></i>Spent <span>${inr(d.spent)}</span></div>`;
    tip.style.display = '';
    const left = px * r.width / C.W;
    tip.style.left = Math.min(Math.max(left, 70), r.width - 70) + 'px';
  };
  const hit = $('.thit', svg);
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { g.style.display = 'none'; tip.style.display = 'none'; });
}

const errBox = () => `<div class="empty">Could not load data. <button class="btn btn-ghost btn-sm" data-retry>Retry</button></div>`;
function bindRetry(el) { const b = $('[data-retry]', el); if (b) b.onclick = refreshView; }
function opts(list, sel, placeholder) {
  return (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '') +
    list.map(v => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
}
function pager(r) {
  const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
  if (r.total <= r.pageSize) return `<div class="pager muted sm">${r.total} record${r.total === 1 ? '' : 's'}</div>`;
  return `<div class="pager"><button class="btn btn-ghost btn-sm" data-page="${r.page - 1}" ${r.page <= 1 ? 'disabled' : ''}>Prev</button>
    <span class="muted sm">Page ${r.page} of ${pages} · ${r.total} records</span>
    <button class="btn btn-ghost btn-sm" data-page="${r.page + 1}" ${r.page >= pages ? 'disabled' : ''}>Next</button></div>`;
}
function bindPager(el, fn) { $$('[data-page]', el).forEach(b => b.onclick = () => fn(Number(b.dataset.page))); }
function billLink(url) { return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">View</a>` : '<span class="badge b-rejected">No bill</span>'; }

function formData(form) {
  const o = {};
  $$('[name]', form).forEach(el => {
    if (el.type === 'file') return;
    o[el.name] = el.type === 'checkbox' ? el.checked : String(el.value).trim();
  });
  return o;
}
function trackDraft(form, key, ref) {
  form.addEventListener('input', () => store.set('draft_' + key,
    Object.assign(formData(form), { ClientRef: typeof ref === 'function' ? ref() : ref })));
}
const getDraft = key => store.get('draft_' + key) || {};
const clearDraft = key => store.del('draft_' + key);

/* client-side validation (mirrors server) */
function vReq(v, label) { return String(v ?? '').trim() ? null : label + ' is required'; }
function vMoney(v) { const n = Number(v); if (v === '' || isNaN(n)) return 'Amount must be a number'; if (n <= 0) return 'Amount must be greater than 0'; return null; }
function vDate(v) { if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return 'Date is required'; if (v > today()) return 'Date cannot be in the future'; return null; }

function exportCSV(name, cols, rows) {
  const line = vals => vals.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  const csv = '\ufeff' + [line(cols.map(c => c[1]))].concat(rows.map(r => line(cols.map(c => r[c[0]])))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name + '_' + today() + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* =========================== Modal / dialogs =========================== */
function openModal(html, wide = false) {
  const box = $('#modalBox');
  box.className = 'modal-box modal' + (wide ? ' wide' : '');
  box.innerHTML = html;
  $('#modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  return box;
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalBox').innerHTML = '';
  document.body.style.overflow = '';
}
function dialog(html) {
  $('#dialogBox').innerHTML = html;
  $('#dialog').classList.remove('hidden');
  return $('#dialogBox');
}
function closeDialog() { $('#dialog').classList.add('hidden'); $('#dialogBox').innerHTML = ''; }

function confirmBox(title, msg, okLabel = 'Confirm', danger = false) {
  return new Promise(resolve => {
    const box = dialog(`<div class="m-head"><div class="m-title">${esc(title)}</div></div>
      <p class="muted">${esc(msg)}</p>
      <div class="m-actions"><button class="btn btn-ghost" data-no>Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary btn-auto'}" data-yes>${esc(okLabel)}</button></div>`);
    $('[data-no]', box).onclick = () => { closeDialog(); resolve(false); };
    $('[data-yes]', box).onclick = () => { closeDialog(); resolve(true); };
  });
}
function askText(title, label, required = true, okLabel = 'Submit') {
  return new Promise(resolve => {
    const box = dialog(`<div class="m-head"><div class="m-title">${esc(title)}</div></div>
      <div class="form"><label class="full">${esc(label)}<textarea class="input" rows="3" maxlength="300" data-txt></textarea></label></div>
      <div class="m-actions"><button class="btn btn-ghost" data-no>Cancel</button>
      <button class="btn btn-primary btn-auto" data-yes>${esc(okLabel)}</button></div>`);
    const ta = $('[data-txt]', box); ta.focus();
    $('[data-no]', box).onclick = () => { closeDialog(); resolve(null); };
    $('[data-yes]', box).onclick = () => {
      const v = ta.value.trim();
      if (required && !v) return toast(label + ' is required', false);
      closeDialog(); resolve(v);
    };
  });
}

/* Owner confirm: kis owner ne cash diya — returns name or null */
function askGivenBy() {
  return new Promise(resolve => {
    const list = CONFIG.OWNERS || [];
    const box = dialog(`<div class="m-head"><div class="m-title">Cash kisne diya?</div></div>
      <div class="form"><label class="full">Given by<select class="input" data-gb>
        <option value="">Select owner</option>${list.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
      </select></label></div>
      <div class="m-actions"><button class="btn btn-ghost" data-no>Cancel</button>
      <button class="btn btn-ok btn-auto" data-yes>Confirm</button></div>`);
    $('[data-no]', box).onclick = () => { closeDialog(); resolve(null); };
    $('[data-yes]', box).onclick = () => {
      const v = $('[data-gb]', box).value;
      if (!v) return toast('Select who gave the cash', false);
      closeDialog(); resolve(v);
    };
  });
}

/* =========================== Auth / boot =========================== */
/* Login: Emp ID → (Employee: seedha andar) | (HR / Owner / Admin: PIN step) */
const LG_ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 5l7 7-7 7M20 12H4"/></svg>';
const pinMode = () => !$('#pinStep').classList.contains('hidden');
function setLoginBtn() { $('#loginBtn').innerHTML = `<span>${pinMode() ? 'Sign in' : 'Continue'}</span>${LG_ARROW}`; }

async function doLogin() {
  const err = $('#loginErr');
  const id = $('#loginId').value.trim();
  if (!id) { err.textContent = 'Enter your Emp ID'; $('#loginId').focus(); return; }
  const withPin = pinMode(), pin = $('#pin').value.trim();
  if (withPin && !/^\d{4}$/.test(pin)) { err.textContent = 'Enter your 4 digit PIN'; return; }
  const btn = $('#loginBtn');
  if (btn.disabled) return;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Checking…'; err.textContent = '';
  try {
    const r = await jsonp('login', withPin ? { id, pin } : { id });
    if (r && r.needPin) return showPinStep(r);                // approver: PIN chahiye
    if (!r || !r.ok) { err.textContent = (r && r.message) || 'Login failed'; shakeLogin(); return; }
    S.token = r.token; S.me = { name: r.name, role: r.role };
    store.set('session', { token: S.token, me: S.me });
    $('#pin').value = ''; $('#loginId').value = '';
    await startApp(r.startup);
  } catch (e) {
    err.textContent = 'Could not connect. Check internet and try again.';
  } finally { btn.disabled = false; setLoginBtn(); }
}

function showPinStep(r) {
  $('#idStep').classList.add('hidden'); $('#pinStep').classList.remove('hidden');
  $('#lgHello').textContent = 'Hi, ' + (r.name || 'there');
  $('#lgSub').textContent = r.newPin ? 'Pehli baar — apna 4-digit PIN set karo' : 'Enter your 4-digit PIN';
  $('#pinLbl').textContent = r.newPin ? 'New PIN' : 'PIN';
  $('#lgHint').textContent = r.newPin ? 'Ye PIN yaad rakhna — agli baar yahi lagega' : 'Signs in automatically after 4 digits';
  $('#pin').value = ''; setLoginBtn(); drawPin();
  setTimeout(() => $('#pin').focus(), 30);
}

function showIdStep() {
  $('#pinStep').classList.add('hidden'); $('#idStep').classList.remove('hidden');
  $('#pin').value = ''; $('#loginErr').textContent = '';
  $('#lgSub').textContent = 'Sign in with your Emp ID';
  $('#lgHint').textContent = 'HR / Owner / Admin ko agle step mein PIN dalna hoga';
  initLoginScreen(); setLoginBtn();
  setTimeout(() => $('#loginId').focus(), 30);
}

/* Self register: pehle Emp ID check (naam dikhao), phir request bhejo */
let REG = null;
function showReg(on) {
  $('#lgBox').classList.toggle('hidden', on); $('#regBox').classList.toggle('hidden', !on);
  REG = null;
  const btn = $('#regBtn');
  btn.classList.remove('hidden'); btn.disabled = false; btn.innerHTML = '<span>Check Emp ID</span>';
  $('#regErr').textContent = ''; $('#regInfo').className = 'reg-info hidden'; $('#regId').disabled = false;
  if (on) { $('#regId').value = $('#loginId').value.trim(); setTimeout(() => $('#regId').focus(), 30); }
  else showIdStep();
}

async function doRegister() {
  const err = $('#regErr'), info = $('#regInfo'), btn = $('#regBtn'), id = $('#regId').value.trim();
  if (!id) { err.textContent = 'Enter your Emp ID'; return; }
  if (btn.disabled) return;
  let next = REG ? 'Request bhejo' : 'Check Emp ID';
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + (REG ? 'Sending…' : 'Checking…'); err.textContent = '';
  try {
    const r = await jsonp('register', REG ? { empId: REG.empId, confirm: '1' } : { empId: id });
    if (!r || !r.ok) { err.textContent = (r && r.message) || 'Could not register'; return; }
    if (!REG) {
      REG = { empId: r.empId, name: r.name };
      info.innerHTML = `<b>${esc(r.name)}</b><span>${esc(r.empId)}${r.dept ? ' · ' + esc(r.dept) : ''}</span><small>Ye aap ho? Toh request bhejo.</small>`;
      info.className = 'reg-info'; $('#regId').disabled = true;
      next = 'Request bhejo';
    } else {
      info.innerHTML = '<b>Request bhej di ✓</b><small>Admin approve karega, uske baad apni Emp ID se login karna.</small>';
      info.className = 'reg-info done';
      next = null;
    }
  } catch (e) {
    err.textContent = 'Could not connect. Check internet and try again.';
  } finally {
    btn.disabled = false; btn.innerHTML = `<span>${next || ''}</span>`;
    btn.classList.toggle('hidden', !next);
  }
}

/* Suite token → server check (ERP suiteMe) → Owner session; fail ho to normal PIN screen */
async function suiteSso_(tok) {
  let r = null;
  try { r = await jsonp('suiteLogin', { suiteToken: tok }); } catch (e) {}
  if (!r || !r.ok) {
    showLogin();
    if (r && r.message) $('#loginErr').textContent = r.message;
    return;
  }
  S.token = r.token; S.me = { name: r.name, role: r.role };
  store.set('session', { token: S.token, me: S.me });
  await startApp(r.startup);
}

function shakeLogin() {
  const box = $('#lgBox');
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
  if (pinMode()) { $('#pin').value = ''; $('#pin').focus(); drawPin(); }
  else $('#loginId').select();
}

/* OTP-style PIN boxes mirror the hidden input */
function drawPin() {
  const i = $('#pin'), v = i.value, reveal = i.dataset.reveal === '1', focused = document.activeElement === i;
  $$('#pinBoxes i').forEach((b, k) => {
    b.textContent = k < v.length && reveal ? v[k] : '';
    b.classList.toggle('f', k < v.length);
    b.classList.toggle('on', focused && k === Math.min(v.length, 3));
  });
}

/* login screen niceties: greeting by time of day + hero numbers counting up */
function initLoginScreen() {
  const h = new Date().getHours();
  $('#lgHello').textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  drawPin();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $$('[data-count]').forEach(el => {
    const to = Number(el.dataset.count), t0 = performance.now(), dur = 1400;
    const tick = t => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = inr(Math.round(to * e));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function startApp(pre) {
  let r = pre;
  if (!r) {
    r = await call('bootstrap', {}, true);
    if (!r || !r.ok) {
      if (r === null && S.token) $('#loginErr').textContent = 'Could not connect. Check internet and try again.';
      else if (r && r.message) $('#loginErr').textContent = r.message;
      showLogin(); return;
    }
  }
  store.set('boot', r);
  applyStartup(r);
  enterApp();
}

/* config + first screen data arrive together; seed the page cache with them */
function applyStartup(r) {
  S.me = r.me; S.cfg = r.config; S.settings = r.settings; S.persons = r.persons; S.employees = r.employees;
  S.personIds = r.personIds || {};
  S.mods = r.modules || {};                                // which modules this user can open
  setRoles(r.roles);
  if (r.dash && r.dash.flow) { memoSet('dashboard', { from: r.dash.from, to: r.dash.to }, r.dash); setBadge(r.dash.live.pending); }
  if (r.mine) memoSet('listVouchers', { page: 1, status: '', mine: '1' }, r.mine);
}

/* server ki Role List → yahi arrays (in-place, kyunki NAV inhi ko refer karta hai) */
function setRoles(x) {
  if (!x) return;
  const fill = (a, b) => { if (Array.isArray(b) && b.length) a.splice(0, a.length, ...b); };
  fill(ROLES, x.all); fill(CASH_ROLES, x.cash); fill(EMP_ROLES, x.emp); fill(PIN_ROLES, x.pin);
}

function enterApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#who').innerHTML = `${avatar(S.me.name)}<span>${esc(S.me.name)}<small>${esc(S.me.role)}</small></span>`;
  buildNav();
  if (S.badge !== undefined) setBadge(S.badge);
  go(isMgr() ? 'dashboard' : '');                                 // baaki: nav ka pehla tab (Technician → Tickets, Employee → My Cash)
  // warm the next screen in the background so it opens instantly
  if (isMgr()) call('approvals', {}, true).then(r => { if (r && r.ok) { memoSet('approvals', {}, r); setBadge(r.count); } });
}

function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  $('#regBox').classList.add('hidden'); $('#lgBox').classList.remove('hidden');
  showIdStep();
}

function logout() {
  if (S.token) jsonp('logout').catch(() => {});        // server stops accepting this token
  S.token = null; S.me = null; S.f = {}; S.badge = undefined;
  MEMO.clear();
  store.del('session'); store.del('boot');
  closeModal(); closeDialog();
  showLogin();
}

/* =========================== Navigation =========================== */
const NAV = [
  { id: 'dashboard', label: 'Dashboard', roles: ['Owner', 'Admin'], render: viewDashboard },
  { id: 'approvals', label: 'Approvals', roles: ['Owner', 'Admin'], render: viewApprovals },
  { id: 'mycash', label: 'My Cash', roles: CASH_ROLES, render: viewMyCash },
  { id: 'vouchers', label: 'All Cash Entries', roles: ['Owner', 'Admin'], render: viewVouchers },
  { id: 'expenses', label: 'Expenses', roles: ['Owner', 'Admin'], render: viewExpenses },
  { id: 'ledger', label: 'Ledger', roles: ROLES, render: viewLedger },
  { id: 'settings', label: 'Settings', roles: ['Admin'], render: viewSettings }
];

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  approvals: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  mycash: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13.5h2"/>',
  vouchers: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  expenses: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  ledger: '<path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z"/><path d="M4 17a3 3 0 0 1 3-3h11"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'
};

const SHORT = { dashboard: 'Home', approvals: 'Approve', mycash: 'My Cash', vouchers: 'Entries', expenses: 'Expenses',
  ledger: 'Ledger', settings: 'Settings' };   // modules apne labels khud jodte hain
const TOP = { dashboard: 'Overview', approvals: 'Approvals', mycash: 'My Cash', vouchers: 'Entries', expenses: 'Expenses',
  ledger: 'Ledger', settings: 'Settings' };   // short labels for the top nav
const icon = id => `<svg viewBox="0 0 24 24">${ICONS[id] || ''}</svg>`;

function buildNav() {
  const items = NAV.filter(n => n.roles.includes(role()) && (!n.show || n.show()));
  $('#nav').innerHTML = items
    .map(n => `<a class="nav-item" data-id="${n.id}"><span class="ni">${icon(n.id)}${TOP[n.id] || n.label}</span>${n.id === 'approvals' ? '<span class="count hidden appr-count"></span>' : ''}</a>`).join('');
  $$('.nav-item').forEach(a => a.onclick = () => go(a.dataset.id));
  // phones: bottom tab bar (max 5 slots; the rest go under "More")
  const main = items.length > 5 ? items.slice(0, 4) : items, more = items.length > 5 ? items.slice(4) : [];
  $('#bnav').style.gridTemplateColumns = `repeat(${main.length + (more.length ? 1 : 0)}, 1fr)`;
  $('#bnav').innerHTML = main.map(n => `<a class="bn-item" data-id="${n.id}">${icon(n.id)}<span>${SHORT[n.id]}</span>${n.id === 'approvals' ? '<i class="count hidden appr-count"></i>' : ''}</a>`).join('') +
    (more.length ? `<a class="bn-item" data-more><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg><span>More</span></a>` : '');
  $$('#bnav [data-id]').forEach(a => a.onclick = () => go(a.dataset.id));
  const m = $('#bnav [data-more]');
  if (m) m.onclick = () => {
    const box = openModal(`<div class="m-head"><div><div class="m-title">More</div></div><button class="x" data-close>&times;</button></div>
      <div class="pick-list">${more.map(n => `<button class="pick" data-id="${n.id}"><span class="ni-row">${icon(n.id)}<b>${n.label}</b></span><span class="right">→</span></button>`).join('')}</div>`);
    $$('[data-id]', box).forEach(b => b.onclick = () => { closeModal(); go(b.dataset.id); });
  };
  $('#todayTxt').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function go(id, params = {}) {
  const allowed = NAV.filter(n => n.roles.includes(role()) && (!n.show || n.show()));
  const item = allowed.find(n => n.id === id) || allowed[0];
  S.view = item.id; S.params = params;
  $$('.nav-item, .bn-item[data-id]').forEach(a => a.classList.toggle('active', a.dataset.id === item.id));
  $('#fab').classList.toggle('hidden', item.id !== 'mycash');
  const mb = $('#bnav [data-more]'); if (mb) mb.classList.toggle('active', !$('#bnav .bn-item.active[data-id]'));
  $('#pageTitle').textContent = item.label;
  $('.content').classList.toggle('is-dash', item.id === 'dashboard' || item.id === 'scrap');   // these pages have their own big header
  const page = $('#page'), host = document.createElement('div');
  page.replaceChildren(host);
  page.classList.remove('fade-in'); void page.offsetWidth; page.classList.add('fade-in');
  window.scrollTo(0, 0);
  item.render(host, params);
}
function refreshView() { if (S.view) go(S.view, S.params); }

function setBadge(n) {
  S.badge = n;
  $$('.appr-count').forEach(el => { el.textContent = n; el.classList.toggle('hidden', !n); });
}
async function refreshBadge() {
  if (!isMgr()) return;
  const r = await call('approvals', {}, true);
  if (r && r.ok) setBadge(r.count);
}

/* =========================== Dashboard (Overview) =========================== */
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'],
  ['lastmonth', 'Last month'], ['last30', 'Last 30 days'], ['custom', 'Custom']];
const ymd = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
function periodRange(k) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const back = n => { const d = new Date(t); d.setDate(d.getDate() - n); return ymd(d); };
  if (k === 'today') return { from: today(), to: today() };
  if (k === 'week') return { from: back((t.getDay() + 6) % 7), to: today() };          // Monday se
  if (k === 'month') return { from: monthStart(), to: today() };
  if (k === 'lastmonth') return { from: ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: ymd(new Date(t.getFullYear(), t.getMonth(), 0)) };
  return { from: back(29), to: today() };                                                // last 30 days
}
const fullD = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const rangeTxt = (a, b) => a === b ? fullD(a) : fullD(a) + ' – ' + fullD(b);
const spanDays = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) + 1;

async function viewDashboard(el) {
  const f = S.f.dash = S.f.dash || { preset: 'last30' };
  if (f.preset !== 'custom') Object.assign(f, periodRange(f.preset));
  else if (!f.from) Object.assign(f, periodRange('last30'));
  const nd = spanDays(f.from, f.to);
  el.innerHTML = `<div class="ov-bar fade-in">
      <div><div class="ov-h">Overview</div>
        <div class="ov-range">Showing <b>${esc(rangeTxt(f.from, f.to))}</b> · ${nd} day${nd === 1 ? '' : 's'}</div></div>
      <div class="ov-ctl"><div class="chips">${PERIODS.map(([k, l]) => `<button class="chip ${f.preset === k ? 'on' : ''}" data-per="${k}">${l}</button>`).join('')}</div>
        ${f.preset === 'custom' ? `<span class="ov-custom"><input class="input" type="date" id="ovFrom" max="${today()}" value="${esc(f.from)}"/>
          <span>to</span><input class="input" type="date" id="ovTo" max="${today()}" value="${esc(f.to)}"/></span>` : ''}</div>
    </div><div id="ovBody"><div class="kstrip">${skel(4)}</div>${skel(6)}</div>`;
  $$('[data-per]', el).forEach(c => c.onclick = () => {
    f.preset = c.dataset.per;
    if (f.preset !== 'custom') Object.assign(f, periodRange(f.preset));
    viewDashboard(el);
  });
  const setCustom = () => {
    const a = $('#ovFrom', el).value, b = $('#ovTo', el).value;
    if (!a || !b) return;
    f.from = a <= b ? a : b; f.to = a <= b ? b : a;
    viewDashboard(el);
  };
  if ($('#ovFrom', el)) { $('#ovFrom', el).onchange = setCustom; $('#ovTo', el).onchange = setCustom; }
  const body = $('#ovBody', el);
  load('dashboard', { from: f.from, to: f.to }, r => renderOverview(body, r), body);
}

function renderOverview(el, r) {
  if (!r || !r.ok || !r.flow) { el.innerHTML = errBox(); return bindRetry(el); }
  setBadge(r.live.pending);
  const F = r.flow, L = r.live, P = r.persons;
  const fbox = (l, v, s, cls, k) => `<div class="fbox ${cls || ''} ${k ? 'clickable' : ''}" ${k ? `data-k="${k}"` : ''}>
    <span>${l}</span><b>${inr(v)}</b><small>${esc(s)}</small></div>`;
  const op = s => `<div class="fop" aria-hidden="true">${s}</div>`;
  const ks = (l, v, s, k, cls) => `<div class="ks ${k ? 'clickable' : ''}" ${k ? `data-k="${k}"` : ''}>
    <div class="ks-l">${esc(l)}</div><div class="kpi-v ${cls || ''}">${v}</div><div class="ks-s">${esc(s)}</div></div>`;
  const gmax = Math.max(1, ...r.givers.map(g => g.amount));
  const maxP = Math.max(1, ...r.byPurpose.map(p => p.amount));
  const unitTxt = { day: 'Daily', week: 'Weekly', month: 'Monthly' }[r.unit] || 'Daily';
  const tot = k => P.reduce((s, x) => s + num(x[k]), 0);
  const gvChips = gs => gs.length
    ? `<span class="gv-chips">${gs.map(g => `<span class="gv">${esc(g.name)} · ${inr(g.amount)}</span>`).join('')}</span>`
    : '<span class="muted">—</span>';

  el.innerHTML = `
    <div class="ov-lbl">Abhi ki position · live (period se alag)</div>
    <div class="kstrip">
      ${ks('Cash with people', inr(L.cashOut), L.ownerOwes ? inr(L.ownerOwes) + ' payable by Owner' : 'Sab open entries ka balance')}
      ${ks('Waiting for approval', L.pending, L.pending ? 'Owner confirm karega' : 'Kuch pending nahi', 'approvals', L.pending ? 'neg' : '')}
      ${ks('Overdue entries', L.overdue, 'Open > ' + r.overdueDays + ' din, balance baaki', 'overdue', L.overdue ? 'neg' : '')}
      ${ks('Bill missing', r.noBillCount, 'Is period ke expenses', 'nobill', r.noBillCount ? 'neg' : '')}
    </div>

    <div class="ov-lbl">Cash ka hisaab · ${esc(rangeTxt(r.from, r.to))}</div>
    <div class="flow fade-in">
      ${fbox('Opening', F.opening, 'Logon ke paas, period se pehle')}${op('+')}
      ${fbox('Given', F.given, F.givenCount + ' entr' + (F.givenCount === 1 ? 'y' : 'ies') + ' · list neeche', 'in', 'given')}${op('−')}
      ${fbox('Spent', F.spent, 'Expenses dekho →', 'out', 'spent')}${op('−')}
      ${fbox('Returned', F.returned, 'Owner ko wapas')}
      ${F.settled ? op('−') + fbox('Settled', F.settled, 'Close karte waqt adjust') : ''}${op('=')}
      ${fbox('Closing', F.closing, 'Logon ke paas, ' + fullD(r.to) + ' tak', 'hl')}
    </div>

    <div class="grid2">
      <div class="card"><div class="card-h">Cash kisne diya <span class="muted">is period mein</span></div><div class="card-b">
        ${r.givers.map(g => `<div class="bar-row"><span class="lbl">${esc(g.name)} <small class="muted">· ${g.count} entr${g.count === 1 ? 'y' : 'ies'}</small></span>
          <div class="bar"><span style="width:${(g.amount / gmax * 100).toFixed(1)}%"></span></div><b class="right">${inr(g.amount)}</b></div>`).join('') ||
          emptyBox('Is period mein koi cash nahi diya')}
        ${r.givers.some(g => g.name === 'Not recorded') ? '<div class="giv-note">"Not recorded" = purani entries jinme Given by save nahi hua tha.</div>' : ''}
      </div></div>
      <div class="card"><div class="card-h">Waiting for you <span class="spacer"></span><a href="#" class="sm" data-nav="approvals">All approvals</a></div>
        <div class="card-b"><div class="wl-list" id="wlist">${skel(3)}</div></div></div>
    </div>

    <div class="card ov-sec"><div class="card-h">Kisko kitna diya <span class="muted">period ka hisaab · row click = ledger</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Person</th><th class="right">Given</th><th class="right">Spent</th>
        <th class="right">Returned</th><th class="right">Balance (abhi)</th><th class="right">Entries</th><th>Kisne diya</th></tr></thead>
      <tbody>${P.map(p => `<tr class="click" data-person="${esc(p.person)}">
        <td>${who(p.person, p.empId)}${p.overdue ? ` <span class="badge b-rejected">${p.overdue} overdue</span>` : ''}</td>
        <td class="right"><b>${inr(p.given)}</b></td><td class="right">${inr(p.spent)}</td><td class="right">${inr(p.returned)}</td>
        <td class="right"><b class="${p.balance < 0 ? 'neg' : ''}">${inr(p.balance)}</b>${p.open ? `<div class="muted sm">${p.open} open · ${p.oldestDays}d</div>` : ''}</td>
        <td class="right">${p.entries}</td><td>${gvChips(p.givers)}</td></tr>`).join('') ||
        '<tr><td colspan="7">' + emptyBox('Is period mein koi movement nahi') + '</td></tr>'}</tbody>
      ${P.length ? `<tfoot><tr><td>Total</td><td class="right">${inr(tot('given'))}</td><td class="right">${inr(tot('spent'))}</td>
        <td class="right">${inr(tot('returned'))}</td><td class="right">${inr(tot('balance'))}</td><td class="right">${tot('entries')}</td><td></td></tr></tfoot>` : ''}
      </table></div></div>

    <div class="grid2 ov-sec">
      <div class="card"><div class="card-h">${unitTxt} movement <span class="muted">Given vs Spent</span></div>
        <div class="card-b">${periodBars(r.trend, r.unit)}</div></div>
      <div class="card"><div class="card-h">Spend by purpose <span class="muted">is period mein</span></div>
        <div class="card-b">${r.byPurpose.map((p, k) => { const hs = p.subs && p.subs.length; return `<div class="bar-row ${hs ? 'has-sub' : ''}" ${hs ? `data-pp="${k}" role="button" tabindex="0" aria-expanded="false"` : ''}>
          <span class="lbl">${hs ? '<i class="chev" aria-hidden="true">›</i>' : ''}${esc(p.purpose)}</span>
          <div class="bar"><span style="width:${(p.amount / maxP * 100).toFixed(1)}%"></span></div><b class="right">${inr(p.amount)}</b></div>
          ${hs ? `<div class="sub-bars hidden" data-ppsub="${k}">${p.subs.map(s => `<div class="bar-row sub"><span class="lbl">${esc(s.sub)}</span>
            <div class="bar"><span style="width:${(s.amount / p.amount * 100).toFixed(1)}%"></span></div><b class="right">${inr(s.amount)}</b></div>`).join('')}</div>` : ''}`; }).join('') ||
          emptyBox('Is period mein koi expense nahi')}</div></div>
    </div>

    <div class="card ov-sec" id="ovRecent"><div class="card-h">Cash given · kab, kisko, kitna
        <span class="muted">${r.recent.length < F.givenCount ? 'latest ' + r.recent.length + ' of ' + F.givenCount : F.givenCount + ' entr' + (F.givenCount === 1 ? 'y' : 'ies')}</span>
        <span class="spacer"></span><a href="#" class="sm" data-k="allv">All entries →</a></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Person</th><th class="right">Amount</th><th>Given by</th>
        <th>Note</th><th class="right">Balance</th><th>Status</th></tr></thead>
      <tbody>${r.recent.map(v => `<tr class="click" data-v="${esc(v.VoucherID)}"><td>${esc(v.Date)}</td>
        <td>${who(v.Person, v.PersonEmpID || pid(v.Person))}</td><td class="right"><b>${inr(v.Amount)}</b></td>
        <td>${v.GivenBy ? esc(v.GivenBy) : '<span class="muted">—</span>'}</td><td class="wrap">${esc(vTitle(v))}</td>
        <td class="right">${inr(v.Balance)}</td><td>${badge(v.Status, v.Overdue)}</td></tr>`).join('') ||
        '<tr><td colspan="7">' + emptyBox('Is period mein koi cash nahi diya') + '</td></tr>'}</tbody></table></div></div>

    <div class="grid2 ov-sec">
      <div class="card"><div class="card-h">Overdue entries <span class="muted">live · ${r.overdueDays} din se purani, balance baaki</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Entry</th><th>Person</th><th>Note</th><th class="right">Balance</th><th class="right">Days</th></tr></thead>
        <tbody>${r.overdue.map(v => `<tr class="click" data-v="${esc(v.VoucherID)}"><td>${esc(v.VoucherID)}</td><td>${esc(v.Person)}</td><td>${esc(vTitle(v))}</td>
          <td class="right"><b>${inr(v.Balance)}</b></td><td class="right neg">${v.Days}</td></tr>`).join('') ||
          '<tr><td colspan="5">' + emptyBox('No overdue entries') + '</td></tr>'}</tbody></table></div></div>
      <div class="card"><div class="card-h">Expenses without bill <span class="muted">is period mein</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Person</th><th>Paid to</th><th class="right">Amount</th></tr></thead>
        <tbody>${r.noBill.map(e => `<tr class="click" data-v="${esc(e.VoucherID)}"><td>${esc(e.Date)}</td><td>${esc(e.Person)}</td><td>${esc(e.PaidTo)}</td>
          <td class="right">${inr(e.Amount)}</td></tr>`).join('') ||
          '<tr><td colspan="4">' + emptyBox('All expenses have bills') + '</td></tr>'}</tbody></table></div></div>
    </div>`;

  // clicks: flow boxes + live strip
  const toExp = noBill => {
    S.f.expenses = Object.assign(S.f.expenses || { q: '', person: '', purpose: '' }, { from: r.from, to: r.to, page: 1, noBill, sub: '' });
    go('expenses');
  };
  const K = {
    given: () => $('#ovRecent', el).scrollIntoView({ behavior: 'smooth', block: 'start' }),
    spent: () => toExp(false), nobill: () => toExp(true),
    approvals: () => go('approvals'), overdue: () => go('vouchers', { overdue: true }), allv: () => go('vouchers')
  };
  $$('[data-k]', el).forEach(c => c.onclick = e => { e.preventDefault(); if (K[c.dataset.k]) K[c.dataset.k](); });
  $$('[data-person]', el).forEach(tr => tr.onclick = () => {
    S.f.ledger = { person: tr.dataset.person, from: r.from, to: r.to };       // ledger usi period ka khule
    go('ledger', { person: tr.dataset.person });
  });
  $$('[data-nav]', el).forEach(b => b.onclick = e => { e.preventDefault(); go(b.dataset.nav); });
  $$('[data-v]', el).forEach(tr => tr.onclick = () => openVoucher(tr.dataset.v));
  $$('[data-pp]', el).forEach(row => {
    const toggle = () => { const s = $(`[data-ppsub="${row.dataset.pp}"]`, el), open = s.classList.toggle('hidden') === false;
      row.classList.toggle('open', open); row.setAttribute('aria-expanded', open); };
    row.onclick = toggle; row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
  waitingList($('#wlist', el));
}

/* Given (navy) vs Spent (sky) — bars per day / week / month, period ke hisaab se */
function periodBars(t, unit) {
  if (!t || !t.length || !t.some(x => x.given || x.spent)) return emptyBox('Is period mein koi cash movement nahi');
  const n = t.length, W = 560, H = 200, base = 176, top = 14, gw = W / n, bw = Math.max(2, Math.min(14, gw / 2 - 2));
  const max = niceMax(Math.max(1, ...t.map(x => Math.max(x.given, x.spent))));
  const h = v => v > 0 ? Math.max(3, (base - top) * v / max) : 0;
  const lab = x => unit === 'month' ? new Date(x.d + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) : dLabel(x.d);
  const span = x => unit === 'day' ? dLabel(x.d) : dLabel(x.d) + ' – ' + dLabel(x.d2);
  const step = Math.max(1, Math.ceil(n / 6));
  const bar = (x, v, fill, del) => v ? `<rect class="db-b" x="${x.toFixed(1)}" y="${(base - h(v)).toFixed(1)}" width="${bw.toFixed(1)}" height="${h(v).toFixed(1)}" rx="${Math.min(3, bw / 2)}" fill="${fill}" style="animation-delay:${del}s"/>` : '';
  const groups = t.map((x, i) => {
    const cx = i * gw + gw / 2, del = (.2 + i * Math.min(.045, 1 / n)).toFixed(2);
    const showL = i === n - 1 || (i % step === 0 && n - 1 - i >= step * .6);
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', lx = i === 0 ? 1 : i === n - 1 ? W - 1 : cx;
    return `<g class="db-g"><title>${span(x)} — Given ${inr(x.given)} · Spent ${inr(x.spent)}</title>
      <rect class="db-hit" x="${(i * gw).toFixed(1)}" y="0" width="${gw.toFixed(1)}" height="${base}"/>
      ${bar(cx - bw - 1, x.given, TREND.given, del)}${bar(cx + 1, x.spent, TREND.spent, del)}
      ${showL ? `<text x="${lx.toFixed(1)}" y="${H - 4}" text-anchor="${anchor}" class="db-l">${lab(x)}</text>` : ''}</g>`;
  }).join('');
  return `<svg class="db-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cash given and spent, ${unit}-wise">
      <line x1="0" x2="${W}" y1="${top}" y2="${top}" class="db-grid"/><text x="0" y="${top - 4}" class="db-l">${shortInr(max)}</text>
      <line x1="0" x2="${W}" y1="${base}" y2="${base}" class="db-base"/>${groups}</svg>
    <div class="db-lgd"><span><i style="background:${TREND.given}"></i>Given <b>${inr(sum(t, 'given'))}</b></span>
      <span><i style="background:${TREND.spent}"></i>Spent <b>${inr(sum(t, 'spent'))}</b></span></div>`;
}


/* "Waiting for you": pending cash given / returns, Owner confirms right here */
function waitingList(host) {
  if (!host) return;
  load('approvals', {}, r => {
    if (!r || !r.ok) { host.innerHTML = errBox(); return bindRetry(host); }
    setBadge(r.count);
    const items = r.vouchers.map(v => ({ type: 'V', id: v.VoucherID, vid: v.VoucherID, person: v.Person, amt: v.Amount, what: 'Cash given · ' + vTitle(v) }))
      .concat(r.returns.map(x => ({ type: 'R', id: x.ReturnID, vid: x.VoucherID, person: x.Person, amt: x.Amount, what: 'Cash returned · ' + (x.VoucherIDs || x.VoucherID) })))
      .concat((r.scrap || []).map(o => ({ type: 'S', id: o.EntryID, vid: '', person: o.Kisne, amt: o.Mila, what: 'Scrap ka cash · ' + o.EntryID })));
    if (!items.length) { host.innerHTML = emptyBox('All caught up — nothing is waiting'); return; }
    const own = isOwner();
    host.innerHTML = items.slice(0, 4).map(it => `<div class="wl-item" ${it.vid ? `data-v="${esc(it.vid)}"` : 'data-scrap'}>
        <span class="who-cell">${avatar(it.person, 'sm')}<span><b>${esc(it.person)}</b><small>${esc(it.what)}</small></span></span>
        <span class="wl-r"><b class="wl-amt">${inr(it.amt)}</b>${own
          ? `<button class="btn btn-ok btn-sm" data-ok="${it.type}|${esc(it.id)}">Confirm</button>`
          : '<small class="muted">Owner confirms</small>'}</span></div>`).join('') +
      (items.length > 4 ? `<button class="btn btn-ghost wl-more" data-nav="approvals">View all ${items.length} →</button>` : '');
    $$('[data-v]', host).forEach(c => c.onclick = () => openVoucher(c.dataset.v));
    $$('[data-scrap]', host).forEach(c => c.onclick = () => go('scrap'));
    $$('[data-nav]', host).forEach(b => b.onclick = () => go(b.dataset.nav));
    $$('[data-ok]', host).forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const [type, id] = b.dataset.ok.split('|');
      const p = { id, decision: 'confirm' };
      if (type === 'V') { const g = await askGivenBy(); if (!g) return; p.givenBy = g; }
      const x = await act(b, CONFIRM_ACTION[type], p, 'Confirmed');
      if (x) { refreshView(); refreshBadge(); }
    });
  }, host);
}

/* =========================== Approvals =========================== */
const CONFIRM_ACTION = { V: 'confirmVoucher', R: 'confirmReturn', S: 'scrapCashConfirm' };
async function viewApprovals(el) {
  el.innerHTML = skel(5);
  load('approvals', {}, r => {
  if (!r || !r.ok) { el.innerHTML = errBox(); return bindRetry(el); }
  setBadge(r.count);
  const canAct = isOwner();
  const btns = (type, id) => canAct ? `<button class="btn btn-ok btn-sm" data-ok="${type}|${esc(id)}">Confirm</button>
    <button class="btn btn-danger btn-sm" data-rej="${type}|${esc(id)}">Reject</button>` : '<span class="muted sm">Owner confirms</span>';
  el.innerHTML = `
    ${!canAct ? '<div class="note">Only the Owner can confirm or reject. You can view pending items here.</div>' : ''}
    <div class="card"><div class="card-h">Cash given — waiting for confirmation <span class="muted">${r.vouchers.length}</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Person</th><th>Purpose</th><th class="right">Amount</th><th>Mode</th><th>Remarks</th><th></th></tr></thead>
      <tbody>${r.vouchers.map(v => `<tr><td>${esc(v.Date)}</td><td>${who(v.Person, v.PersonEmpID || pid(v.Person))}</td><td>${esc(vTitle(v))}</td>
        <td class="right"><b>${inr(v.Amount)}</b></td><td>${esc(v.Mode)}</td><td class="wrap">${esc(v.Remarks)}</td><td class="right">${btns('V', v.VoucherID)}</td></tr>`).join('') ||
        '<tr><td colspan="7">' + emptyBox('Nothing to confirm') + '</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="card-h">Cash returned — waiting for confirmation <span class="muted">${r.returns.length}</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Person</th><th>Entry</th><th class="right">Amount</th><th>Mode</th><th>Remarks</th><th></th></tr></thead>
      <tbody>${r.returns.map(x => `<tr><td>${esc(x.Date)}</td><td>${who(x.Person, x.PersonEmpID || pid(x.Person))}</td><td><a href="#" data-v="${esc(x.VoucherID)}">${esc(x.VoucherIDs || x.VoucherID)}</a> · ${esc(vTitle(x))}</td>
        <td class="right"><b>${inr(x.Amount)}</b></td><td>${esc(x.Mode)}</td><td class="wrap">${esc(x.Remarks)}</td><td class="right">${btns('R', x.ReturnID)}</td></tr>`).join('') ||
        '<tr><td colspan="7">' + emptyBox('Nothing to confirm') + '</td></tr>'}</tbody></table></div></div>
    ${(r.scrap || []).length ? `<div class="card"><div class="card-h">Scrap ka cash — Owner tak pahunchna baaki <span class="muted">${r.scrap.length}</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Kiske paas</th><th>Entry</th><th class="right">Amount</th><th>Kaise</th><th></th></tr></thead>
      <tbody>${r.scrap.map(o => `<tr><td>${esc(o.Date)}</td><td>${who(o.Kisne, pid(o.Kisne))}</td><td class="muted sm">${esc(o.EntryID)} · ${esc(o.Party)}</td>
        <td class="right"><b>${inr(o.Mila)}</b></td><td>${esc(o.Kaise)}</td>
        <td class="right">${canAct ? `<button class="btn btn-ok btn-sm" data-ok="S|${esc(o.EntryID)}">Mil gaya</button>` : '<span class="muted sm">Owner confirms</span>'}</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;

  $$('[data-v]', el).forEach(a => a.onclick = e => { e.preventDefault(); openVoucher(a.dataset.v); });
  $$('[data-ok]', el).forEach(b => b.onclick = async () => {
    const [type, id] = b.dataset.ok.split('|');
    const p = { id, decision: 'confirm' };
    if (type === 'V') { const g = await askGivenBy(); if (!g) return; p.givenBy = g; }
    const r2 = await act(b, CONFIRM_ACTION[type], p, 'Confirmed');
    if (r2) { refreshView(); refreshBadge(); }
  });
  $$('[data-rej]', el).forEach(b => b.onclick = async () => {
    const [type, id] = b.dataset.rej.split('|');
    const reason = await askText('Reject entry', 'Reason', true, 'Reject');
    if (reason === null) return;
    const r2 = await act(b, type === 'V' ? 'confirmVoucher' : 'confirmReturn', { id, decision: 'reject', reason }, 'Rejected');
    if (r2) { refreshView(); refreshBadge(); }
  });
  }, el);
}

/* =========================== My Cash =========================== */
async function viewMyCash(el) {
  const f = S.f.mycash = S.f.mycash || { page: 1, status: '' };
  const statuses = ['', 'Pending Confirm', 'Open', 'Closed', 'Rejected'];
  el.innerHTML = `<div class="toolbar">
      <div class="chips">${statuses.map(s => `<button class="chip ${f.status === s ? 'on' : ''}" data-status="${s}">${s || 'All'}</button>`).join('')}</div>
      <span class="spacer"></span><button class="btn btn-ghost" id="quickRet">Return Cash</button>
      <button class="btn btn-ghost" id="quickExp">+ Expense</button>
      <button class="btn btn-primary btn-auto" id="newCash">+ Cash Received</button>
    </div><div id="mcBody">${skel(4)}</div>`;
  $$('[data-status]', el).forEach(c => c.onclick = () => { f.status = c.dataset.status; f.page = 1; viewMyCash(el); });
  $('#newCash', el).onclick = formVoucher;
  $('#quickExp', el).onclick = () => quickExpense(S.openList);
  $('#quickRet', el).onclick = () => formReturn(null);
  $('#fab').onclick = () => {
    const box = openModal(`<div class="m-head"><div><div class="m-title">What do you want to add?</div></div><button class="x" data-close>&times;</button></div>
      <div class="pick-list">
        <button class="pick" data-a="cash"><span><b>Cash Received</b><small>Owner gave you cash</small></span><span class="right">→</span></button>
        <button class="pick" data-a="exp"><span><b>Expense</b><small>You paid from the cash you hold</small></span><span class="right">→</span></button>
        <button class="pick" data-a="ret"><span><b>Return Cash</b><small>Give unused cash back to the Owner</small></span><span class="right">→</span></button>
      </div>`);
    $('[data-a="cash"]', box).onclick = formVoucher;
    $('[data-a="exp"]', box).onclick = () => quickExpense(S.openList);
    $('[data-a="ret"]', box).onclick = () => formReturn(null);
  };

  load('listVouchers', { page: f.page, status: f.status, mine: '1' }, r => {
  const body = $('#mcBody', el);
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  const s = r.summary;
  S.openList = r.openList || [];
  S.myCash = s;                                    // expense / return form isi "Cash in hand" se chalenge
  const sub = `<b>${inr(s.cashInHand)}</b> cash in hand · ${s.open} open entr${s.open === 1 ? 'y' : 'ies'}` +
    (s.pending ? ` · <b>${s.pending}</b> waiting for Owner` : '') + (s.overdue ? ` · <span class="neg">${s.overdue} overdue</span>` : '');
  body.innerHTML = `${helloCard(sub)}<div class="kpis">
      ${kpi('Cash in hand', inr(s.cashInHand), 'Received but not yet accounted', { hl: true })}
      ${kpi('Open entries', s.open, s.overdue ? s.overdue + ' overdue' : 'Add expenses or return cash')}
      ${kpi('Waiting for Owner', s.pending, 'Not yet confirmed')}
      ${s.payable ? kpi('Payable by Owner', inr(s.payable), 'You spent more than received') : ''}
    </div>
    <div class="vlist">${r.rows.map(vCard).join('') || emptyBox('No entries yet. Tap "Cash Received" when the Owner gives you cash.')}</div>
    ${pager(r)}`;
  $$('[data-v]', body).forEach(c => c.onclick = () => openVoucher(c.dataset.v));
  bindPager(body, p => { f.page = p; viewMyCash(el); });
  animateNums(body, 'mycash');
  }, $('#mcBody', el));
}

function vCard(v) {
  const amt = num(v.Amount);
  const used = amt ? Math.min(100, (num(v.Spent) + num(v.Returned)) / amt * 100) : 0;
  return `<div class="vcard fade-in" data-v="${esc(v.VoucherID)}">
    <div class="vc-top"><div><div class="vc-title">${esc(vTitle(v))}</div>
      <div class="muted sm">${esc(v.VoucherID)} · ${esc(v.Date)} · ${esc(v.Mode)}</div></div>${badge(v.Status, v.Overdue)}</div>
    <div class="vc-nums"><div><span>Received</span><b>${inr(amt)}</b></div><div><span>Spent</span><b>${inr(v.Spent)}</b></div>
      <div><span>Returned</span><b>${inr(v.Returned)}</b></div><div><span>Balance</span><b class="${num(v.Balance) < 0 ? 'neg' : ''}">${inr(v.Balance)}</b></div></div>
    <div class="progress"><span style="width:${used.toFixed(1)}%"></span></div>
    ${v.Status === 'Rejected' && v.RejectReason ? `<div class="note bad" style="margin:10px 0 0">Rejected: ${esc(v.RejectReason)}</div>` : ''}
  </div>`;
}

/* "+ Expense": seedha form — overall cash in hand se (backend purani entry se pehle kaatega) */
function quickExpense(list) {
  if (!list || !list.length) return toast('No open entry yet. Add "Cash Received" and wait for Owner confirmation.', false);
  formExpense(null);
}

/* =========================== All cash entries (Owner/Admin) =========================== */
async function viewVouchers(el, params = {}) {
  const f = S.f.vouchers = S.f.vouchers || { page: 1, q: '', status: '', person: '', purpose: '', overdue: false };
  if (params.overdue) { f.overdue = true; f.status = ''; f.page = 1; S.params = {}; }
  el.innerHTML = `<div class="toolbar">
      <input class="input search" id="q" placeholder="Search entry, person, remarks…" value="${esc(f.q)}" />
      <select class="input" id="fStatus">${opts(['Pending Confirm', 'Open', 'Closed', 'Rejected'], f.status, 'All statuses')}</select>
      <select class="input" id="fPerson">${opts(S.persons, f.person, 'All persons')}</select>
      <label class="check"><input type="checkbox" id="fOver" ${f.overdue ? 'checked' : ''}/> Overdue only</label>
      <span class="spacer"></span><button class="btn btn-ghost" id="exp">Export CSV</button>
    </div><div id="vBody">${skel(6)}</div>`;
  const reload = () => { f.page = 1; viewVouchers(el); };
  $('#q', el).oninput = debounce(e => { f.q = e.target.value; reload(); });
  $('#fStatus', el).onchange = e => { f.status = e.target.value; reload(); };
  $('#fPerson', el).onchange = e => { f.person = e.target.value; reload(); };
  $('#fOver', el).onchange = e => { f.overdue = e.target.checked; reload(); };
  const params2 = () => ({ q: f.q, status: f.status, person: f.person, purpose: f.purpose, overdue: f.overdue ? '1' : '' });
  $('#exp', el).onclick = async e => {
    const r = await act(e.currentTarget, 'listVouchers', Object.assign(params2(), { all: '1' }));
    if (r) exportCSV('cash_entries', [['VoucherID', 'Entry'], ['Date', 'Date'], ['Person', 'Person'], ['PersonEmpID', 'Emp ID'], ['Purpose', 'Purpose'], ['Amount', 'Amount'],
      ['Mode', 'Mode'], ['Spent', 'Spent'], ['Returned', 'Returned'], ['Balance', 'Balance'], ['Status', 'Status'], ['Days', 'Days'],
      ['Remarks', 'Remarks'], ['GivenBy', 'Given By'], ['ConfirmedBy', 'Confirmed By'], ['ClosedBy', 'Closed By'], ['CloseNote', 'Close Note']], r.rows);
  };

  load('listVouchers', Object.assign(params2(), { page: f.page }), r => {
  const body = $('#vBody', el);
  if (!body) return;
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  body.innerHTML = `<div class="table-card"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Entry</th><th>Date</th><th>Person</th><th>Note</th><th class="right">Amount</th><th class="right">Spent</th>
      <th class="right">Returned</th><th class="right">Balance</th><th>Status</th></tr></thead>
    <tbody>${r.rows.map(v => `<tr class="click" data-v="${esc(v.VoucherID)}"><td>${esc(v.VoucherID)}</td><td>${esc(v.Date)}</td><td>${who(v.Person, v.PersonEmpID || pid(v.Person))}</td>
      <td>${esc(vTitle(v))}</td><td class="right">${inr(v.Amount)}</td><td class="right">${inr(v.Spent)}</td><td class="right">${inr(v.Returned)}</td>
      <td class="right"><b class="${num(v.Balance) < 0 ? 'neg' : ''}">${inr(v.Balance)}</b></td><td>${badge(v.Status, v.Overdue)}</td></tr>`).join('') ||
      '<tr><td colspan="9">' + emptyBox('No entries found') + '</td></tr>'}</tbody></table></div></div>${pager(r)}`;
  $$('[data-v]', body).forEach(tr => tr.onclick = () => openVoucher(tr.dataset.v));
  bindPager(body, p => { f.page = p; viewVouchers(el); });
  }, $('#vBody', el));
}

/* =========================== Voucher detail =========================== */
async function openVoucher(id, pre) {
  const box = openModal(`<div class="m-head"><div><div class="m-title">Loading…</div></div><button class="x" data-close>&times;</button></div>${skel(4)}`, true);
  if (pre) { memoSet('voucherDetail', { id }, pre); box._tok = (box._tok || 0) + 1; return renderVoucher(box, pre, id); }
  load('voucherDetail', { id }, r => renderVoucher(box, r, id), box);
}

function renderVoucher(box, r, id) {
  if ($('#modal').classList.contains('hidden')) return;
  if (!r || !r.ok || !r.voucher) {
    box.innerHTML = `<div class="m-head"><div><div class="m-title">${esc(id)}</div></div><button class="x" data-close>&times;</button></div>${errBox()}`;
    const b = $('[data-retry]', box); if (b) b.onclick = () => openVoucher(id);
    return;
  }
  const v = r.voucher;
  const own = v.Person === S.me.name;
  const isOpen = v.Status === 'Open', isPending = v.Status === 'Pending Confirm';
  const pendRet = r.returns.filter(x => x.Status === 'Pending Confirm');
  const autoClosed = v.Status === 'Closed' && String(v.ClosedBy || '').indexOf('Auto') === 0;
  const canDelExp = (isOpen || autoClosed) && (own || isAdmin());

  const actions = [];
  if (isOwner() && isPending) actions.push('<button class="btn btn-danger" data-a="reject">Reject</button>', '<button class="btn btn-ok" data-a="confirm">Confirm cash given</button>');
  if (isOwner() && isOpen) actions.push('<button class="btn btn-ghost" data-a="close">Settle &amp; Close</button>');
  if ((own || isAdmin()) && isPending) actions.push('<button class="btn btn-danger" data-a="cancel">Cancel entry</button>');
  if (own && isOpen) actions.push('<button class="btn btn-ghost" data-a="return">Return Cash</button>', '<button class="btn btn-primary btn-auto" data-a="expense">+ Add Expense</button>');

  box.innerHTML = `
    <div class="m-head"><div><div class="m-title">${esc(vTitle(v))} · ${esc(v.VoucherID)}</div>
      <div class="muted sm">${esc(v.Person)}${(v.PersonEmpID || pid(v.Person)) ? ' (' + esc(v.PersonEmpID || pid(v.Person)) + ')' : ''} · ${esc(v.Date)} · ${esc(v.Mode)} · ${v.Days} day${v.Days === 1 ? '' : 's'} old</div></div>
      ${badge(v.Status, v.Overdue)}<button class="x" data-close>&times;</button></div>
    <div class="stat-row">
      <div class="stat"><span>Received</span><b>${inr(v.Amount)}</b></div>
      <div class="stat"><span>Spent</span><b>${inr(v.Spent)}</b></div>
      <div class="stat"><span>Returned</span><b>${inr(v.Returned)}</b></div>
      <div class="stat"><span>Balance</span><b class="${num(v.Balance) < 0 ? 'neg' : ''}">${inr(v.Balance)}</b></div>
    </div>
    ${v.Remarks ? `<div class="note">${esc(v.Remarks)}</div>` : ''}
    ${isPending ? '<div class="note">Waiting for Owner to confirm this cash was given.</div>' : ''}
    ${v.Status === 'Rejected' ? `<div class="note bad">Rejected by ${esc(v.ConfirmedBy)}: ${esc(v.RejectReason)}</div>` : ''}
    ${v.GivenBy ? `<div class="note">Cash given by <b>${esc(v.GivenBy)}</b></div>` : ''}
    ${num(v.Balance) < 0 ? `<div class="note bad">Spent ${inr(-num(v.Balance))} more than received — payable by Owner.</div>` : ''}
    ${v.Status === 'Closed' ? `<div class="note">Closed by ${esc(v.ClosedBy)} on ${esc(v.ClosedAt)}${v.CloseNote ? ' — ' + esc(v.CloseNote) : ''}</div>` : ''}

    <div class="m-section"><h4>Expenses (${r.expenses.length})</h4>
      <div class="table-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Purpose</th><th>Paid to</th><th>Description</th>
        <th class="right">Amount</th><th>Bill</th>${canDelExp ? '<th></th>' : ''}</tr></thead>
      <tbody>${r.expenses.map(e => `<tr><td>${esc(e.Date)}</td><td><span class="tx ${e.AdvanceID ? 'tx-adv' : 'tx-pur'}">${esc(e.Purpose)}${e.SubPurpose ? ' › ' + esc(e.SubPurpose) : ''}</span></td><td>${esc(e.PaidTo)}${e.AdvanceID ? ` <span class="muted sm">${esc(e.AdvanceID)}</span>` : ''}</td>
        <td class="wrap">${esc(e.Description)}</td><td class="right">${inr(e.Amount)}</td><td>${billLink(e.BillURL)}</td>
        ${canDelExp ? `<td class="right"><button class="icon-btn" title="Remove" data-del="${esc(e.ExpenseID)}">&times;</button></td>` : ''}</tr>`).join('') ||
        `<tr><td colspan="7">${emptyBox('No expenses added yet')}</td></tr>`}</tbody></table></div></div></div>

    ${r.returns.length ? `<div class="m-section"><h4>Cash returned (${r.returns.length})</h4>
      <div class="table-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th class="right">Amount</th><th>Mode</th><th>Remarks</th><th>Status</th>${isOwner() ? '<th></th>' : ''}</tr></thead>
      <tbody>${r.returns.map(x => `<tr><td>${esc(x.Date)}</td><td class="right">${inr(x.Amount)}</td><td>${esc(x.Mode)}</td>
        <td class="wrap">${esc(x.Remarks)}${x.RejectReason ? ' — <span class="neg">' + esc(x.RejectReason) + '</span>' : ''}</td><td>${badge(x.Status)}</td>
        ${isOwner() ? `<td class="right">${x.Status === 'Pending Confirm' ? `<button class="btn btn-ok btn-sm" data-rok="${esc(x.ReturnID)}">Confirm</button>
          <button class="btn btn-danger btn-sm" data-rrej="${esc(x.ReturnID)}">Reject</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div></div></div>` : ''}

    ${actions.length ? `<div class="m-actions" style="margin-top:20px">${actions.join('')}</div>` : ''}`;

  const done = (msg, res) => { if (msg) toast(msg); refreshView(); refreshBadge(); openVoucher(id, res && res.detail); };
  const A = a => $(`[data-a="${a}"]`, box);

  if (A('confirm')) A('confirm').onclick = async e => {
    const btn = e.currentTarget, g = await askGivenBy(); if (!g) return;
    const x = await act(btn, 'confirmVoucher', { id, decision: 'confirm', givenBy: g }); if (x) done('Cash entry confirmed', x);
  };
  if (A('reject')) A('reject').onclick = async e => {
    const btn = e.currentTarget;
    const reason = await askText('Reject cash entry', 'Reason', true, 'Reject');
    if (reason !== null) { const x = await act(btn, 'confirmVoucher', { id, decision: 'reject', reason }); if (x) done('Entry rejected', x); }
  };
  if (A('close')) A('close').onclick = async e => {
    const btn = e.currentTarget;
    const bal = num(v.Balance);
    if (pendRet.length) return toast('Confirm or reject the pending cash return first', false);
    const msg = bal === 0 ? 'Close this entry?' : bal > 0
      ? `Balance ${inr(bal)} is still with ${v.Person}. It will be marked as settled. Add a note.`
      : `${inr(-bal)} was spent extra. Closing means the Owner has paid it back. Add a note.`;
    let note = '';
    if (bal === 0) { if (!(await confirmBox('Settle & Close', msg, 'Close'))) return; }
    else { note = await askText('Settle & Close', 'Note (' + msg + ')', true, 'Close entry'); if (note === null) return; }
    { const x = await act(btn, 'closeVoucher', { id, note }); if (x) done('Entry closed', x); }
  };
  if (A('cancel')) A('cancel').onclick = async e => {
    const btn = e.currentTarget;
    if (!(await confirmBox('Cancel entry', 'This entry will be removed. Continue?', 'Cancel entry', true))) return;
    if (await act(btn, 'cancelVoucher', { id })) { toast('Entry cancelled'); closeModal(); refreshView(); refreshBadge(); }
  };
  if (A('expense')) A('expense').onclick = () => formExpense(null);     // overall cash in hand
  if (A('return')) A('return').onclick = () => formReturn(null);
  $$('[data-del]', box).forEach(b => b.onclick = async () => {
    if (!(await confirmBox('Remove expense', 'This expense will be removed (agar ye 2 entries mein bata tha toh dono hissa).', 'Remove', true))) return;
    { const x = await act(b, 'deleteExpense', { id: b.dataset.del }); if (x) done('Expense removed', x); }
  });
  $$('[data-rok]', box).forEach(b => b.onclick = async () => {
    { const x = await act(b, 'confirmReturn', { id: b.dataset.rok, decision: 'confirm' }); if (x) done('Return confirmed', x); }
  });
  $$('[data-rrej]', box).forEach(b => b.onclick = async () => {
    const reason = await askText('Reject cash return', 'Reason', true, 'Reject');
    if (reason !== null) { const x = await act(b, 'confirmReturn', { id: b.dataset.rrej, decision: 'reject', reason }); if (x) done('Return rejected', x); }
  });
}

/* =========================== Forms: cash / expense / return =========================== */
function formVoucher() {
  const key = 'voucher', d = getDraft(key), ref = d.ClientRef || uid();
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">Cash Received from Owner</div></div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label>Date<input class="input" type="date" name="Date" max="${today()}" value="${esc(d.Date || today())}" /></label>
      <label>Amount (₹)<input class="input" type="number" name="Amount" inputmode="decimal" min="1" step="0.01" value="${esc(d.Amount || '')}" placeholder="0" /></label>
      <label class="full">Payment mode<select class="input" name="Mode">${opts(S.cfg.PaymentMode, d.Mode || S.cfg.PaymentMode[0], 'Select mode')}</select></label>
      <label class="full">Note <span class="muted sm">(optional)</span><textarea class="input" name="Remarks" rows="2" maxlength="300" placeholder="e.g. Cash for site visit, petty expenses">${esc(d.Remarks || '')}</textarea></label>
      <p class="hint full">The Owner will confirm this entry. Then add each expense with its purpose.</p>
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-auto">Submit</button></div>
    </form>`);
  const form = $('form', box);
  trackDraft(form, key, ref);
  form.onsubmit = async e => {
    e.preventDefault();
    const rec = formData(form); rec.ClientRef = ref;
    const err = vDate(rec.Date) || vMoney(rec.Amount) || vReq(rec.Mode, 'Payment mode');
    if (err) return toast(err, false);
    const r = await submit(form, 'createVoucher', { record: JSON.stringify(rec) });
    if (!r) return;
    clearDraft(key); closeModal(); toast('Sent to Owner for confirmation'); refreshView(); refreshBadge();
  };
}

function formExpense(v, opt = {}) {              // v = null → overall cash in hand (pool) · opt.ticket → ticket ka kharch
  const tk = opt.ticket;
  const key = v ? 'exp_' + v.VoucherID : tk ? 'exp_tk_' + tk.TicketID : 'exp_pool', d = getDraft(key);
  if (tk && !d.Purpose && opt.purpose) d.Purpose = opt.purpose;
  let ref = d.ClientRef || uid(), bal = v ? num(v.Balance) : num(S.myCash && S.myCash.cashInHand) - num(S.myCash && S.myCash.payable), up = null, more = false;
  const adv = S.settings.advancePurpose;
  const purposes = S.cfg.Purpose.filter(p => p !== adv || isAdvMgr());
  const empOpts = S.employees.map(e => `<option value="${esc(e.id)}" ${e.id === d.EmpID ? 'selected' : ''}>${esc(e.name)}${e.id.indexOf('ROW-') ? ' · ' + esc(e.id) : ''}${e.dept ? ' — ' + esc(e.dept) : ''}</option>`).join('');
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">Add Expense</div>
      <div class="muted sm">${tk ? 'Ticket ' + esc(tk.TicketID) + ' · ' + esc(tk.CustomerName) + ' · ' : ''}${v ? esc(v.VoucherID) + ' · ' + esc(vTitle(v)) + ' · Balance' : 'Cash in hand'} <b id="expBal">${inr(bal)}</b></div></div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label>Date<input class="input" type="date" name="Date" max="${today()}" value="${esc(d.Date || today())}" /></label>
      <label>Amount (₹)<input class="input" type="number" name="Amount" inputmode="decimal" min="1" step="0.01" value="${esc(d.Amount || '')}" placeholder="0" /></label>
      <label class="full">Purpose<select class="input" name="Purpose">${opts(purposes, d.Purpose, 'Select purpose')}</select></label>
      <label class="full hidden" id="subWrap">Sub-category<select class="input" name="SubPurpose"></select></label>
      <label class="full" id="empWrap">Employee<select class="input" name="EmpID"><option value="">Select employee</option>${empOpts}</select>
        ${S.employees.length ? '<span class="hint">This amount will be added to the employee\'s advance khata.</span>' : '<span class="hint">No employees found in the Employee Master.</span>'}</label>
      <label class="full" id="paidWrap">Paid to<input class="input" name="PaidTo" maxlength="120" value="${esc(d.PaidTo || '')}" placeholder="Vendor / shop / person" /></label>
      <label class="full">Description<textarea class="input" name="Description" rows="2" maxlength="300" placeholder="What was bought / paid for">${esc(d.Description || '')}</textarea></label>
      <label class="full file-pick" id="pick"><input type="file" accept="image/*,application/pdf" /><span id="pickTxt">Attach bill photo (optional)</span></label>
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Close</button>
        <button type="submit" class="btn btn-ghost" data-more>Save &amp; add another</button>
        <button type="submit" class="btn btn-primary btn-auto">Save</button></div>
    </form>`);
  const isAdv = () => $('[name=Purpose]', box).value === adv;
  const subsOf = p => (S.cfg.SubPurpose || {})[p] || [];
  const syncPurpose = () => {
    $('#empWrap', box).classList.toggle('hidden', !isAdv()); $('#paidWrap', box).classList.toggle('hidden', isAdv());
    const list = isAdv() ? [] : subsOf($('[name=Purpose]', box).value), sel = $('[name=SubPurpose]', box), keep = sel.value || d.SubPurpose;
    sel.innerHTML = opts(list, list.includes(keep) ? keep : '', 'Select sub-category');
    $('#subWrap', box).classList.toggle('hidden', !list.length);
  };
  $('[name=Purpose]', box).addEventListener('change', syncPurpose); syncPurpose();
  const form = $('form', box), fileIn = $('input[type=file]', box), pick = $('#pick', box), pickTxt = $('#pickTxt', box);
  trackDraft(form, key, () => ref);
  $('[data-more]', form).addEventListener('click', () => { more = true; });
  $('button.btn-primary', form).addEventListener('click', () => { more = false; });

  const resetPick = () => { up = null; fileIn.value = ''; pick.classList.remove('has'); pickTxt.textContent = 'Attach bill photo (optional)'; };
  // upload starts the moment a photo is chosen, while the user is still typing
  const startUpload = file => {
    const job = { file, url: null, err: null };
    pick.classList.add('has');
    pickTxt.innerHTML = '<span class="spinner dark"></span>Uploading ' + esc(file.name) + '…';
    job.promise = uploadBill(file).then(url => {
      job.url = url;
      if (up === job) pickTxt.textContent = '✓ Bill uploaded — ' + file.name;
      return url;
    }).catch(er => {
      job.err = er;
      if (up === job) { pick.classList.remove('has'); pickTxt.textContent = 'Upload failed: ' + er.message + ' — tap to choose again'; }
      throw er;
    });
    job.promise.catch(() => {});
    up = job;
  };
  fileIn.onchange = () => { const f = fileIn.files[0]; if (f) startUpload(f); else resetPick(); };

  form.onsubmit = async e => {
    e.preventDefault();
    if (form.dataset.busy === '1') return;
    const rec = formData(form); if (v) rec.VoucherID = v.VoucherID; if (tk) rec.TicketID = tk.TicketID; rec.ClientRef = ref;
    const advance = rec.Purpose === adv;
    if (advance) rec.PaidTo = ''; else rec.EmpID = '';
    const needSub = !advance && subsOf(rec.Purpose).length > 0;
    if (!needSub) rec.SubPurpose = '';
    const err = vDate(rec.Date) || vMoney(rec.Amount) || vReq(rec.Purpose, 'Purpose') || (needSub ? vReq(rec.SubPurpose, 'Sub-category') : null) ||
      (advance ? vReq(rec.EmpID, 'Employee') : vReq(rec.PaidTo, 'Paid to'));
    if (err) return toast(err, false);
    if (num(rec.Amount) > bal) {
      const ok = await confirmBox('More than balance', `This is ${inr(num(rec.Amount) - bal)} more than your balance. The extra will show as payable by the Owner. Continue?`, 'Continue');
      if (!ok) return;
    }
    if (up) {
      if (up.err) startUpload(up.file);
      if (!up.url) {
        const btns = $$('button[type=submit]', form);
        btns.forEach(b => { b.disabled = true; });
        try { rec.BillURL = await up.promise; }
        catch (er) { toast('Bill upload failed: ' + er.message + '. Choose the photo again or remove it.', false); return; }
        finally { btns.forEach(b => { b.disabled = false; }); }
      } else rec.BillURL = up.url;
    }
    const r = await submit(form, 'addExpense', { record: JSON.stringify(rec) });
    if (!r) return;
    clearDraft(key);
    toast(advance ? 'Advance recorded in employee khata' : 'Expense saved');
    refreshView();
    if (v && r.detail) memoSet('voucherDetail', { id: v.VoucherID }, r.detail);
    if (!more) return v ? openVoucher(v.VoucherID, r.detail) : opt.onSaved ? opt.onSaved(r) : closeModal();
    // keep the form open for the next expense
    bal = num(r.balance != null ? r.balance : bal - num(rec.Amount));
    if (!v && S.myCash) { S.myCash.cashInHand = Math.max(0, bal); S.myCash.payable = Math.max(0, -bal); }
    $('#expBal', box).textContent = inr(bal);
    ref = uid();
    ['Amount', 'PaidTo', 'Description', 'EmpID'].forEach(n => { const f = $(`[name=${n}]`, form); if (f) f.value = ''; });   // purpose stays for the next one
    resetPick();
    $('[name=Amount]', form).focus();
  };
}

function formReturn(v, pendingAmt) {               // v = null → overall cash in hand (pool)
  const key = v ? 'ret_' + v.VoucherID : 'ret_pool', d = getDraft(key), ref = d.ClientRef || uid();
  if (!v) pendingAmt = num(S.myCash && S.myCash.pendingReturn);
  const max = Math.round(((v ? num(v.Balance) : num(S.myCash && S.myCash.cashInHand)) - pendingAmt) * 100) / 100;
  if (max <= 0) return toast(pendingAmt ? 'A return is already waiting for confirmation' : 'No balance left to return', false);
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">Return Cash to Owner</div>
      <div class="muted sm">${v ? esc(v.VoucherID) + ' · ' : 'Cash in hand · '}You can return up to ${inr(max)}</div></div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label>Date<input class="input" type="date" name="Date" max="${today()}" value="${esc(d.Date || today())}" /></label>
      <label>Amount (₹)<input class="input" type="number" name="Amount" inputmode="decimal" min="1" max="${max}" step="0.01" value="${esc(d.Amount || max)}" /></label>
      <label class="full">Mode<select class="input" name="Mode">${opts(S.cfg.PaymentMode, d.Mode || S.cfg.PaymentMode[0], 'Select mode')}</select></label>
      <label class="full">Remarks<textarea class="input" name="Remarks" rows="2" maxlength="300">${esc(d.Remarks || '')}</textarea></label>
      <p class="hint full">The Owner will confirm that the cash was received back.</p>
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-auto">Submit Return</button></div>
    </form>`);
  const form = $('form', box);
  trackDraft(form, key, ref);
  form.onsubmit = async e => {
    e.preventDefault();
    const rec = formData(form); if (v) rec.VoucherID = v.VoucherID; rec.ClientRef = ref;
    const err = vDate(rec.Date) || vMoney(rec.Amount) || (num(rec.Amount) > max ? 'Amount cannot be more than ' + inr(max) : null) || vReq(rec.Mode, 'Mode');
    if (err) return toast(err, false);
    const r = await submit(form, 'addReturn', { record: JSON.stringify(rec) });
    if (!r) return;
    clearDraft(key); toast('Return sent to Owner for confirmation'); refreshView(); refreshBadge();
    if (v) openVoucher(v.VoucherID, r.detail); else closeModal();
  };
}

/* =========================== Expenses (Owner/Admin) =========================== */
async function viewExpenses(el) {
  const f = S.f.expenses = S.f.expenses || { page: 1, q: '', person: '', purpose: '', from: monthStart(), to: today(), noBill: false };
  el.innerHTML = `<div class="toolbar">
      <input class="input search" id="q" placeholder="Search paid to, description…" value="${esc(f.q)}" />
      <select class="input" id="fPerson">${opts(S.persons, f.person, 'All persons')}</select>
      <select class="input" id="fPurpose">${opts(S.cfg.Purpose, f.purpose, 'All purposes')}</select>
      ${((S.cfg.SubPurpose || {})[f.purpose] || []).length ? `<select class="input" id="fSub">${opts(S.cfg.SubPurpose[f.purpose].concat('Not set'), f.sub || '', 'All sub-categories')}</select>` : ''}
      <input class="input" type="date" id="fFrom" value="${esc(f.from)}" />
      <input class="input" type="date" id="fTo" value="${esc(f.to)}" />
      <label class="check"><input type="checkbox" id="fNoBill" ${f.noBill ? 'checked' : ''}/> Without bill</label>
      <span class="spacer"></span><button class="btn btn-ghost" id="exp">Export CSV</button>
    </div><div id="eBody">${skel(6)}</div>`;
  const reload = () => { f.page = 1; viewExpenses(el); };
  $('#q', el).oninput = debounce(e => { f.q = e.target.value; reload(); });
  $('#fPerson', el).onchange = e => { f.person = e.target.value; reload(); };
  $('#fPurpose', el).onchange = e => { f.purpose = e.target.value; f.sub = ''; reload(); };
  if ($('#fSub', el)) $('#fSub', el).onchange = e => { f.sub = e.target.value; reload(); };
  $('#fFrom', el).onchange = e => { f.from = e.target.value; reload(); };
  $('#fTo', el).onchange = e => { f.to = e.target.value; reload(); };
  $('#fNoBill', el).onchange = e => { f.noBill = e.target.checked; reload(); };
  const p = () => ({ q: f.q, person: f.person, purpose: f.purpose, sub: f.sub || '', from: f.from, to: f.to, noBill: f.noBill ? '1' : '' });
  $('#exp', el).onclick = async e => {
    const r = await act(e.currentTarget, 'listExpenses', Object.assign(p(), { all: '1' }));
    if (r) exportCSV('expenses', [['ExpenseID', 'Expense'], ['VoucherID', 'Entry'], ['Date', 'Date'], ['Person', 'Person'], ['PersonEmpID', 'Emp ID'], ['Purpose', 'Purpose'],
      ['SubPurpose', 'Sub-category'], ['PaidTo', 'Paid To'], ['Description', 'Description'], ['Amount', 'Amount'], ['BillURL', 'Bill'], ['EmpName', 'Employee (advance)']], r.rows);
  };

  load('listExpenses', Object.assign(p(), { page: f.page }), r => {
  const body = $('#eBody', el);
  if (!body) return;
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  body.innerHTML = `<div class="table-card"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Date</th><th>Person</th><th>Purpose</th><th>Paid to</th><th>Description</th><th class="right">Amount</th><th>Bill</th><th>Entry</th></tr></thead>
    <tbody>${r.rows.map(e => `<tr><td>${esc(e.Date)}</td><td>${who(e.Person, e.PersonEmpID || pid(e.Person))}</td><td>${esc(e.Purpose)}${e.SubPurpose ? ` <span class="muted sm">› ${esc(e.SubPurpose)}</span>` : ''}</td><td>${esc(e.PaidTo)}</td>
      <td class="wrap">${esc(e.Description)}</td><td class="right">${inr(e.Amount)}</td><td>${billLink(e.BillURL)}</td>
      <td><a href="#" data-v="${esc(e.VoucherID)}">${esc(e.VoucherID)}</a></td></tr>`).join('') ||
      '<tr><td colspan="8">' + emptyBox('No expenses found') + '</td></tr>'}</tbody>
    ${r.total ? `<tfoot><tr><td colspan="5">Total (${r.total} expenses)</td><td class="right">${inr(r.sum)}</td><td colspan="2"></td></tr></tfoot>` : ''}
    </table></div></div>${pager(r)}`;
  $$('[data-v]', body).forEach(a => a.onclick = e => { e.preventDefault(); openVoucher(a.dataset.v); });
  bindPager(body, pg => { f.page = pg; viewExpenses(el); });
  }, $('#eBody', el));
}

/* =========================== Ledger =========================== */
async function viewLedger(el, params = {}) {
  const f = S.f.ledger = S.f.ledger || { person: '', from: monthStart(), to: today() };
  if (params.person) { f.person = params.person; S.params = {}; }
  if (!isMgr()) f.person = S.me.name;
  el.innerHTML = `<div class="toolbar">
      ${isMgr() ? `<select class="input" id="fPerson"><option value="">Select person</option>${S.persons.map(n => `<option value="${esc(n)}" ${n === f.person ? 'selected' : ''}>${esc(n)}${pid(n) ? ' · ' + esc(pid(n)) : ''}</option>`).join('')}</select>` : `<b>${esc(S.me.name)}</b>`}
      <input class="input" type="date" id="fFrom" value="${esc(f.from)}" />
      <input class="input" type="date" id="fTo" value="${esc(f.to)}" />
      <span class="spacer"></span>
      <button class="btn btn-ghost" id="exp">Export CSV</button><button class="btn btn-ghost" id="prn">Print</button>
    </div><div id="lBody">${f.person ? skel(6) : emptyBox('Select a person to see their ledger')}</div>`;
  if ($('#fPerson', el)) $('#fPerson', el).onchange = e => { f.person = e.target.value; viewLedger(el); };
  $('#fFrom', el).onchange = e => { f.from = e.target.value; viewLedger(el); };
  $('#fTo', el).onchange = e => { f.to = e.target.value; viewLedger(el); };
  $('#prn', el).onclick = () => window.print();
  if (!f.person) return;

  load('ledger', { person: f.person, from: f.from, to: f.to }, r => {
  const body = $('#lBody', el);
  if (!body) return;
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  $('#exp', el).onclick = () => exportCSV('ledger_' + r.person.replace(/\s+/g, '_'),
    [['date', 'Date'], ['particulars', 'Particulars'], ['ref', 'Ref'], ['inAmt', 'Received'], ['outAmt', 'Spent / Returned'], ['balance', 'Cash in hand']],
    [{ date: r.from, particulars: 'Opening balance', balance: r.opening }].concat(r.entries));
  body.innerHTML = `<div class="kpis">
      ${kpi('Opening', inr(r.opening), 'as on ' + r.from)}
      ${kpi('Received', inr(r.totalIn), 'from Owner')}
      ${kpi('Spent / Returned', inr(r.totalOut), 'expenses + returns')}
      ${kpi('Cash in hand', inr(r.closing), 'as on ' + r.to, { hl: true })}
    </div>
    <div class="table-card"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Date</th><th>Particulars</th><th>Ref</th><th class="right">Received</th><th class="right">Spent / Returned</th><th class="right">Cash in hand</th></tr></thead>
      <tbody><tr><td>${esc(r.from)}</td><td colspan="4"><b>Opening balance</b></td><td class="right"><b>${inr(r.opening)}</b></td></tr>
      ${r.entries.map(e => `<tr><td>${esc(e.date)}</td><td class="wrap">${esc(e.particulars)}${e.ord === 1 ? ' · ' + billLink(e.bill) : ''}</td>
        <td class="muted sm">${esc(e.ref)}</td><td class="right pos">${e.inAmt ? inr(e.inAmt) : ''}</td><td class="right">${e.outAmt ? inr(e.outAmt) : ''}</td>
        <td class="right"><b class="${e.balance < 0 ? 'neg' : ''}">${inr(e.balance)}</b></td></tr>`).join('') ||
        '<tr><td colspan="6">' + emptyBox('No transactions in this period') + '</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">Closing</td><td class="right">${inr(r.totalIn)}</td><td class="right">${inr(r.totalOut)}</td><td class="right">${inr(r.closing)}</td></tr></tfoot>
    </table></div></div>`;
  }, $('#lBody', el));
}

/* =========================== Settings (Admin) =========================== */
async function viewSettings(el) {
  const f = S.f.settings = S.f.settings || { tab: 'users' };
  el.innerHTML = `<div class="tabs">
      <button class="tab ${f.tab === 'users' ? 'on' : ''}" data-tab="users">Users &amp; PINs</button>
      <button class="tab ${f.tab === 'roles' ? 'on' : ''}" data-tab="roles">Roles</button>
      <button class="tab ${f.tab === 'lists' ? 'on' : ''}" data-tab="lists">Dropdown Lists</button>
      <button class="tab ${f.tab === 'general' ? 'on' : ''}" data-tab="general">General</button>
    </div><div id="sBody">${skel(5)}</div>`;
  $$('[data-tab]', el).forEach(t => t.onclick = () => { f.tab = t.dataset.tab; viewSettings(el); });
  const body = $('#sBody', el);
  if (f.tab === 'users') return settingsUsers(body);
  if (f.tab === 'roles') return settingsRoles(body);
  const r = await call('configAll');
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  S.cfgRows = r.rows;
  if (f.tab === 'lists') settingsLists(body); else settingsGeneral(body);
}

async function settingsUsers(body) {
  const r = await call('listUsers');
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  body.innerHTML = `<div class="toolbar"><span class="muted">Every person who takes cash from the Owner needs a user with a PIN.</span>
      <span class="spacer"></span><button class="btn btn-primary btn-auto" id="add">+ Add User</button></div>
    <div class="table-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Emp ID</th><th>Role</th><th>PIN</th><th>Status</th></tr></thead>
    <tbody>${r.rows.map((u, i) => `<tr class="click" data-i="${i}"><td>${who(u.Name)}</td>
      <td>${u.EmpID ? esc(u.EmpID) : (EMP_ROLES.includes(u.Role) ? '<span class="badge b-rejected">Not linked</span>' : '<span class="muted">—</span>')}</td>
      <td>${esc(u.Role)}</td><td>${u.HasPin
        ? `<span class="pin-cell"><b data-pinv>••••</b><button class="icon-btn pin-eye" title="PIN dekho" aria-label="Show PIN of ${esc(u.Name)}" data-pin="${esc(u.Name)}"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button></span>`
        : '<span class="muted sm">Agle login pe</span>'}</td><td>${badge(u.Active ? 'Active' : 'Inactive')}</td></tr>`).join('')}</tbody>
    </table></div></div>
    <div class="note" style="margin-top:14px"><b>Roles:</b> Owner — confirms cash and sees everything ·
      Admin — sees everything, manages settings · HR — takes cash, manages employee advances ·
      Employee — takes cash and records expenses.</div>`;
  $('#add', body).onclick = () => formUser(null, r.roles);
  $$('[data-i]', body).forEach(tr => tr.onclick = () => formUser(r.rows[tr.dataset.i], r.roles));
  // Admin: show a PIN for 15 s (each look is logged on the server)
  $$('[data-pin]', body).forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const cell = b.closest('.pin-cell'), v = $('[data-pinv]', cell);
    if (cell.classList.contains('on')) { v.textContent = '••••'; cell.classList.remove('on'); clearTimeout(cell._t); return; }
    const x = await act(b, 'revealPin', { name: b.dataset.pin });
    if (!x) return;
    v.textContent = x.pin; cell.classList.add('on');
    cell._t = setTimeout(() => { v.textContent = '••••'; cell.classList.remove('on'); }, 15000);
  });
}

const EMP_ROLES = ['HR', 'Employee', 'Technician'];   // must be linked to the Employee Master
const PIN_ROLES = ['Owner', 'Admin', 'HR'];     // approvers: Emp ID / Login ID + PIN

/* Self-register request approve: role chuno (HR ho toh PIN optional — warna pehle login pe khud set karega) */
function approveReq(p) {
  const box = dialog(`<div class="m-head"><div><div class="m-title">Approve user</div><div class="muted sm">${esc(p.Name)} · ${esc(p.EmpID)}</div></div></div>
    <div class="form">
      <label class="full">Role<select class="input" data-role>${opts(EMP_ROLES, 'Employee')}</select></label>
      <label class="full hidden" data-pinrow>PIN <span class="muted sm">(optional)</span><input class="input" data-pin inputmode="numeric" maxlength="4" placeholder="Khaali chhodo — pehle login pe khud set karega" /></label>
    </div>
    <div class="m-actions"><button class="btn btn-ghost" data-no>Cancel</button><button class="btn btn-primary btn-auto" data-yes>Approve</button></div>`);
  const sel = $('[data-role]', box), pinRow = $('[data-pinrow]', box), pin = $('[data-pin]', box);
  sel.onchange = () => pinRow.classList.toggle('hidden', !PIN_ROLES.includes(sel.value));
  $('[data-no]', box).onclick = closeDialog;
  $('[data-yes]', box).onclick = async e => {
    const v = PIN_ROLES.includes(sel.value) ? pin.value.trim() : '';
    if (v && !/^\d{4}$/.test(v)) return toast('PIN must be 4 digits', false);
    const r = await act(e.currentTarget, 'approveUser', { empId: p.EmpID, role: sel.value, pin: v }, 'User approved');
    if (!r) return;
    closeDialog();
    const b = await call('bootstrap', {}, true);
    if (b && b.ok) { S.persons = b.persons; S.personIds = b.personIds || {}; }
    refreshView();
  };
}

function formUser(u, roles) {
  const isNew = !u, u0 = u || { Name: '', Role: 'Employee', Active: true, EmpID: '', LoginID: '' };
  const empOpts = S.employees.map(e => `<option value="${esc(e.id)}" ${e.id === u0.EmpID ? 'selected' : ''}>${esc(e.name)} · ${esc(e.id)}${e.dept ? ' — ' + esc(e.dept) : ''}</option>`).join('');
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">${isNew ? 'Add User' : 'Edit User'}</div>${isNew ? '' : `<div class="muted sm">${esc(u0.Name)}</div>`}</div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label class="full">Role<select class="input" name="Role">${opts(roles || ROLES, u0.Role)}</select></label>
      <label class="full" id="empRow">Employee <span class="muted sm">(from Employee Master)</span>
        <select class="input" name="EmpID"><option value="">Select employee</option>${empOpts}</select>
        <span class="hint">${isNew ? 'Name and Emp ID are taken from the Employee Master.' : 'Links this user to the employee; old entries get the Emp ID too.'}</span></label>
      <label class="full" id="nameRow">Name<input class="input" name="Name" maxlength="60" value="${esc(u0.Name)}" ${isNew ? '' : 'readonly'} />
        ${isNew ? '<span class="hint">Owner / Admin are not in the Employee Master — just type the name.</span>' : ''}</label>
      <label class="full" id="loginIdRow">Login ID<input class="input" name="LoginID" maxlength="30" value="${esc(u0.LoginID || '')}" placeholder="e.g. OWNER1, ADMIN" autocapitalize="characters" />
        <span class="hint">Owner / Admin isi ID + PIN se login karenge (Emp ID ki jagah).</span></label>
      <label class="full" id="pinRow">PIN<input class="input" name="PIN" inputmode="numeric" maxlength="4" placeholder="${isNew ? '4 digits' : 'Leave blank to keep'}" />
        <span class="hint" id="pinHint"></span></label>
      ${isNew ? '' : `<label class="check full"><input type="checkbox" name="Active" ${u0.Active ? 'checked' : ''}/> Active (can log in)</label>`}
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-auto">Save</button></div>
    </form>`);
  const form = $('form', box), roleSel = $('[name=Role]', form);
  const needsEmp = () => EMP_ROLES.includes(roleSel.value);
  const needsPin = () => PIN_ROLES.includes(roleSel.value);
  const sync = () => {
    $('#empRow', box).classList.toggle('hidden', !needsEmp());
    $('#nameRow', box).classList.toggle('hidden', isNew && needsEmp());
    $('#loginIdRow', box).classList.toggle('hidden', needsEmp());
    $('#pinRow', box).classList.toggle('hidden', !needsPin());
    $('#pinHint', box).textContent = needsPin() && !['Owner', 'Admin'].includes(roleSel.value) ? 'Optional — khaali chhodo toh pehle login pe khud set karega.' : '';
  };
  roleSel.onchange = sync; sync();
  form.onsubmit = async e => {
    e.preventDefault();
    const rec = formData(form); rec.isNew = isNew;
    if (isNew) rec.Active = true;
    if (!needsEmp()) rec.EmpID = ''; else rec.LoginID = '';
    if (needsEmp() && isNew) rec.Name = '';
    if (!needsPin()) rec.PIN = '';
    rec.LoginID = String(rec.LoginID || '').trim().toUpperCase();
    if (!isNew) rec.Name = u0.Name;
    const ownerAdmin = !needsEmp();
    const err = (needsEmp() ? vReq(rec.EmpID, 'Employee') : vReq(rec.Name, 'Name') || vReq(rec.LoginID, 'Login ID')) ||
      (isNew && ownerAdmin ? vReq(rec.PIN, 'PIN') : null) || (rec.PIN && !/^\d{4}$/.test(rec.PIN) ? 'PIN must be 4 digits' : null);
    if (err) return toast(err, false);
    const r = await submit(form, 'saveUser', { record: JSON.stringify(rec) });
    if (!r) return;
    closeModal(); toast('User saved');
    const b = await call('bootstrap', {}, true);
    if (b && b.ok) { S.persons = b.persons; S.personIds = b.personIds || {}; }
    refreshView();
  };
}

function settingsLists(body) {
  const labels = { Purpose: 'Purposes', PaymentMode: 'Payment modes', RecoveryMode: 'Recovery modes' };
  const subsOf = p => S.cfgRows.map((r, i) => ({ r, i })).filter(x => x.r.type === 'SubPurpose' && x.r.value === p);
  const sw = (it, i) => `<label class="switch"><input type="checkbox" data-i="${i}" ${it.active ? 'checked' : ''} aria-label="Active"/><i></i></label>`;
  const cfgRow = (it, i) => {
    const canSub = it.type === 'Purpose' && it.key !== (S.settings && S.settings.advancePurpose), subs = canSub ? subsOf(it.key) : [], open = canSub && S.subOpen === it.key;
    return `<div class="cfg-item ${it.active ? '' : 'off'}"><span>${esc(it.key)}</span><span class="cfg-r">
        ${canSub ? `<button type="button" class="btn btn-ghost btn-sm sub-btn ${open ? 'on' : ''}" data-subs="${i}">Sub${subs.length ? ' · ' + subs.length : ' +'}</button>` : ''}${sw(it, i)}</span></div>
      ${open ? `<div class="cfg-subs">${subs.map(x => `<div class="cfg-item ${x.r.active ? '' : 'off'}"><span>› ${esc(x.r.key)}</span>${sw(x.r, x.i)}</div>`).join('') ||
        '<div class="muted sm">Abhi koi sub-category nahi</div>'}
        <div class="cfg-add"><input class="input" placeholder="New sub-category…" maxlength="60" data-newsub /><button type="button" class="btn btn-ghost btn-sm" data-addsub="${i}">Add</button></div></div>` : ''}`;
  };
  const draw = () => {
    body.innerHTML = `<div class="cfg-grid">${Object.keys(labels).map(type => `
      <div class="card"><div class="card-h">${labels[type]}</div><div class="card-b">
        ${S.cfgRows.map((it, i) => it.type !== type ? '' : cfgRow(it, i)).join('')}
        <div class="cfg-add"><input class="input" placeholder="Add new…" maxlength="60" data-new="${type}" /><button class="btn btn-ghost btn-sm" data-add="${type}">Add</button></div>
      </div></div>`).join('')}</div>
      <p class="hint">Items cannot be renamed (old records use the name). Switch an item off to hide it from new entries.
        Kisi Purpose ke aage <b>Sub</b> dabao to uski sub-categories (jaise Office Expense › Kitchen) bana sakte ho.</p>
      <div class="m-actions"><button class="btn btn-primary btn-auto" id="saveCfg">Save changes</button></div>`;
    $$('[data-i]', body).forEach(c => c.onchange = () => { S.cfgRows[c.dataset.i].active = c.checked; draw(); });
    $$('[data-add]', body).forEach(b => b.onclick = () => {
      const type = b.dataset.add, inp = $(`[data-new="${type}"]`, body), key = inp.value.trim();
      if (!key) return;
      if (S.cfgRows.some(r => r.type === type && r.key.toLowerCase() === key.toLowerCase())) return toast('Already exists', false);
      S.cfgRows.push({ type, key, value: '', active: true }); draw();
    });
    $$('[data-new]', body).forEach(inp => inp.onkeydown = e => { if (e.key === 'Enter') $(`[data-add="${inp.dataset.new}"]`, body).click(); });
    $$('[data-subs]', body).forEach(b => b.onclick = () => { const k = S.cfgRows[b.dataset.subs].key; S.subOpen = S.subOpen === k ? '' : k; draw(); });
    $$('[data-addsub]', body).forEach(b => {
      const inp = b.parentElement.querySelector('[data-newsub]');
      b.onclick = () => {
        const parent = S.cfgRows[b.dataset.addsub].key, key = inp.value.trim();
        if (!key) return;
        if (subsOf(parent).some(x => x.r.key.toLowerCase() === key.toLowerCase())) return toast('Already exists', false);
        S.cfgRows.push({ type: 'SubPurpose', key, value: parent, active: true }); draw();
        const again = $('.cfg-subs [data-newsub]', body); if (again) again.focus();
      };
      inp.onkeydown = e => { if (e.key === 'Enter') b.click(); };
    });
    $('#saveCfg', body).onclick = e => saveCfg(e.target);
  };
  draw();
}

/* Settings → Roles: naya role + module access (dono Google Sheet ke "Role List" / "Roles" tab mein save) */
const ROLE_TYPE_TXT = { Owner: 'Owner (fixed)', Admin: 'Admin (fixed)', Approver: 'Approver — Emp ID + PIN', Employee: 'Employee — sirf Emp ID' };
async function settingsRoles(body) {
  const r = await call('listRoles');
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  const active = r.roles.filter(x => x.active).map(x => x.role);
  body.innerHTML = `<div class="toolbar"><span class="muted">Naya role yahan se ya Google Sheet ke "Role List" tab se bana sakte ho.</span>
      <span class="spacer"></span><button class="btn btn-primary btn-auto" id="addRole">+ Naya role</button></div>
    <div class="table-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Role</th><th>Type</th><th>Cash leta hai</th><th class="right">Users</th><th>Status</th></tr></thead>
    <tbody>${r.roles.map((x, i) => `<tr ${x.fixed ? '' : `class="click" data-ri="${i}"`}><td><b>${esc(x.role)}</b>${x.fixed ? ' <span class="muted sm">fixed</span>' : ''}</td>
      <td>${esc(ROLE_TYPE_TXT[x.type] || x.type)}</td><td>${x.cash ? '✓' : '—'}</td><td class="right">${x.users}</td><td>${badge(x.active ? 'Active' : 'Inactive')}</td></tr>`).join('')}</tbody>
    </table></div></div>
    <div class="card ov-sec"><div class="card-h">Module access <span class="muted">kaunsa module kis role ko dikhe · sheet ka "Roles" tab</span></div><div class="card-b">
      <div class="tbl-wrap"><table class="tbl role-tbl"><thead><tr><th>Module</th>${active.map(x => `<th class="center">${esc(x)}</th>`).join('')}</tr></thead>
      <tbody>${r.modules.map(m => `<tr><td><b>${esc(m.label)}</b></td>${active.map(x => `<td class="center"><input type="checkbox" data-mr="${esc(m.key)}" value="${esc(x)}"
        aria-label="${esc(m.label)} · ${esc(x)}" ${m.roles.includes(x) ? 'checked' : ''}/></td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="m-actions"><button class="btn btn-primary btn-auto" id="saveMr">Save module access</button></div>
      <span class="hint">Owner ke core screens (Overview, Approvals) aur Admin ka Settings hamesha rahenge.</span></div></div>`;
  $('#addRole', body).onclick = () => formRole(null, r.types);
  $$('[data-ri]', body).forEach(tr => tr.onclick = () => formRole(r.roles[tr.dataset.ri], r.types));
  $('#saveMr', body).onclick = async e => {
    const map = {};
    r.modules.forEach(m => { map[m.key] = $$(`[data-mr="${m.key}"]`, body).filter(c => c.checked).map(c => c.value); });
    if (await act(e.currentTarget, 'saveModuleRoles', { map: JSON.stringify(map) }, 'Module access saved')) refreshRoles();
  };
}

/* role / module badle → is user ka nav + role lists turant naye */
async function refreshRoles() {
  const b = await call('bootstrap', {}, true);
  if (b && b.ok) { setRoles(b.roles); S.mods = b.modules || S.mods; buildNav(); }
  refreshView();
}

function formRole(x, types) {
  const isNew = !x, x0 = x || { role: '', type: 'Employee', cash: true, active: true, users: 0 };
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">${isNew ? 'Naya role' : 'Edit role'}</div>${isNew ? '' : `<div class="muted sm">${esc(x0.role)} · ${x0.users} user</div>`}</div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label class="full">Role ka naam<input class="input" name="Role" maxlength="20" value="${esc(x0.role)}" ${isNew ? '' : 'readonly'} placeholder="e.g. Store, Accounts" />
        ${isNew ? '<span class="hint">2–20 letters. Baad mein naam nahi badlega.</span>' : ''}</label>
      <label class="full">Type<select class="input" name="Type">${(types || ['Approver', 'Employee']).map(t => `<option value="${t}" ${t === x0.type ? 'selected' : ''}>${
        t === 'Approver' ? 'Approver — Emp ID + PIN se login (HR jaisa)' : 'Employee — sirf Emp ID se login'}</option>`).join('')}</select></label>
      <label class="check full"><input type="checkbox" name="Cash" ${x0.cash ? 'checked' : ''}/> Cash leta hai (My Cash, Cash Received, Expense)</label>
      ${isNew ? '' : `<label class="check full"><input type="checkbox" name="Active" ${x0.active ? 'checked' : ''}/> Active (band karne se pehle iske users ka role badlo)</label>`}
      <p class="hint full">Kaunsa module dikhe (Tickets, Advances…) — neeche "Module access" table se.</p>
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-auto">Save</button></div>
    </form>`);
  const form = $('form', box);
  form.onsubmit = async e => {
    e.preventDefault();
    const rec = { Role: $('[name=Role]', form).value.trim().replace(/\s+/g, ' '), Type: $('[name=Type]', form).value,
      Cash: $('[name=Cash]', form).checked, Active: isNew ? true : $('[name=Active]', form).checked, isNew };
    if (!/^[A-Za-z][A-Za-z ]{1,19}$/.test(rec.Role)) return toast('Role ka naam 2–20 letters ka ho (sirf A–Z aur space)', false);
    if (/^(owner|admin)$/i.test(rec.Role)) return toast('Owner / Admin fixed roles hain', false);
    const r = await submit(form, 'saveRole', { record: JSON.stringify(rec) });
    if (!r) return;
    closeModal(); toast(isNew ? 'Role "' + rec.Role + '" ban gaya' : 'Role saved'); refreshRoles();
  };
}

function settingsGeneral(body) {
  const get = k => (S.cfgRows.find(r => r.type === 'Setting' && r.key === k) || {}).value || '';
  const purposes = S.cfgRows.filter(r => r.type === 'Purpose' && r.active).map(r => r.key);
  body.innerHTML = `<div class="card" style="max-width:560px"><div class="card-b"><form class="form" novalidate>
      <label class="full">Overdue after (days)<input class="input" type="number" min="1" max="365" name="OverdueDays" value="${esc(get('OverdueDays') || 7)}" />
        <span class="hint">An Open entry with balance older than this is marked Overdue.</span></label>
      <label class="full">Employee advance purpose<select class="input" name="AdvancePurpose">${opts(purposes, get('AdvancePurpose'))}</select>
        <span class="hint">Cash taken for this purpose is given to employees as advance; only HR/Admin can use it.</span></label>
      <div class="m-actions full"><button type="submit" class="btn btn-primary btn-auto">Save</button></div>
    </form></div></div>`;
  const form = $('form', body);
  form.onsubmit = e => {
    e.preventDefault();
    const v = formData(form);
    const od = Number(v.OverdueDays);
    if (!(od >= 1 && od <= 365)) return toast('Overdue days must be 1–365', false);
    ['OverdueDays', 'AdvancePurpose'].forEach(k => {
      const row = S.cfgRows.find(r => r.type === 'Setting' && r.key === k);
      if (row) row.value = String(v[k]); else S.cfgRows.push({ type: 'Setting', key: k, value: String(v[k]), active: true });
    });
    saveCfg($('button[type=submit]', form));
  };
}

async function saveCfg(btn) {
  const r = await act(btn, 'saveConfig', { items: JSON.stringify(S.cfgRows) }, 'Settings saved');
  if (!r) return;
  const b = await call('bootstrap', {}, true);
  if (b && b.ok) { S.cfg = b.config; S.settings = b.settings; S.mods = b.modules || S.mods; buildNav(); }
}

/* =========================== Wire up =========================== */
$('#loginBtn').onclick = doLogin;
$('#loginId').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('#loginId').addEventListener('input', () => { $('#loginErr').textContent = ''; });
$('#lgBack').onclick = e => { e.preventDefault(); showIdStep(); };
$('#regLink').onclick = e => { e.preventDefault(); showReg(true); };
$('#regBack').onclick = e => { e.preventDefault(); showReg(false); };
$('#regBtn').onclick = doRegister;
$('#regId').addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
$('#pin').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('#pin').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  $('#loginErr').textContent = '';
  drawPin();
  if (e.target.value.length === 4) doLogin();              // 4 digits typed: sign in straight away
});
['focus', 'blur', 'keyup', 'click'].forEach(ev => $('#pin').addEventListener(ev, drawPin));
$('#pinEye').onclick = () => {
  const i = $('#pin'), show = i.dataset.reveal !== '1';
  i.dataset.reveal = show ? '1' : '';
  $('#pinEye').classList.toggle('on', show);
  i.focus(); drawPin();
};
$('#logoutBtn').onclick = logout;
$('#refreshBtn').onclick = () => { markStale(); refreshView(); refreshBadge(); };
document.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#dialog').classList.contains('hidden')) return;
  if (!$('#modal').classList.contains('hidden')) closeModal();
});

// start after every script (app.js + modules/*.js) has loaded, so modules are in the nav
document.addEventListener('DOMContentLoaded', function init() {
  const sess = store.get('session');
  // Litpax Suite ke andar (Admin login): PIN ke bina seedha Owner
  let suiteTok = '';
  try { if (window.parent !== window) suiteTok = sessionStorage.getItem('suite_token') || ''; } catch (e) {}
  if (suiteTok && !(sess && sess.token && sess.me && sess.me.role === 'Owner')) return suiteSso_(suiteTok);
  if (!sess || !sess.token) return showLogin();
  S.token = sess.token; S.me = sess.me;
  const boot = store.get('boot');
  if (boot && boot.me && boot.me.name === sess.me.name) {
    applyStartup(boot); enterApp();
    call('bootstrap', {}, true).then(r => {
      if (!r || !r.ok) return;
      const before = JSON.stringify(S.mods);
      store.set('boot', r); applyStartup(r);
      if (JSON.stringify(S.mods) !== before) { buildNav(); go(S.view, S.params); }   // module access changed
    });
  } else startApp();
});

// register after the page is up, so it never slows the first load
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
