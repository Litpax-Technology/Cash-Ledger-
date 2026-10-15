'use strict';
/* Owner Cash Ledger — frontend logic (JSONP to Google Apps Script) */

const ROLES = ['Owner', 'Admin', 'HR', 'Employee'];
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
const isAdvMgr = () => ['Admin', 'HR'].includes(role());
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
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, CONFIG.TIMEOUT_MS);
    function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = res => { cleanup(); resolve(res); };
    const qs = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== null)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    s.src = CONFIG.API_URL + '?action=' + action + '&callback=' + cb +
      (S.token ? '&token=' + encodeURIComponent(S.token) : '') + (qs ? '&' + qs : '');
    s.onerror = () => { cleanup(); reject(new Error('network')); };
    document.body.appendChild(s);
  });
}

/* returns: response object (check .ok) or null on network failure */
async function call(action, params = {}, quiet = false) {
  try {
    const r = await jsonp(action, params);
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
function markStale() { MEMO.forEach(v => { v.t = 0; }); }   // after any save, next view refetches
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
    if (r && r.ok) markStale();
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
  if (r && r.ok) { markStale(); if (okMsg) toast(okMsg); return r; }
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
const emptyBox = msg => `<div class="empty">${esc(msg)}</div>`;
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

/* =========================== Auth / boot =========================== */
async function doLogin() {
  const pin = $('#pin').value.trim();
  const err = $('#loginErr');
  if (!/^\d{4}$/.test(pin)) { err.textContent = 'Enter your 4 digit PIN'; return; }
  const btn = $('#loginBtn'), label = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Checking…'; err.textContent = '';
  try {
    const r = await jsonp('login', { pin });
    if (!r.ok) { err.textContent = r.message || 'Login failed'; shakeLogin(); return; }
    S.token = r.token; S.me = { name: r.name, role: r.role };
    store.set('session', { token: S.token, me: S.me });
    $('#pin').value = '';
    await startApp(r.startup);
  } catch (e) {
    err.textContent = 'Could not connect. Check internet and try again.';
  } finally { btn.disabled = false; btn.innerHTML = label; }
}

function shakeLogin() {
  const box = $('#lgBox');
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
  $('#pin').value = ''; $('#pin').focus(); drawPin();
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
  if (r.dash) { memoSet('dashboard', {}, r.dash); setBadge(r.dash.kpi.pending); }
  if (r.mine) memoSet('listVouchers', { page: 1, status: '', mine: '1' }, r.mine);
}

function enterApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#who').innerHTML = `${esc(S.me.name)}<small>${esc(S.me.role)}</small>`;
  buildNav();
  if (S.badge !== undefined) setBadge(S.badge);
  go(isMgr() ? 'dashboard' : 'mycash');
}

function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  initLoginScreen();
  setTimeout(() => $('#pin').focus(), 50);
}

function logout() {
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
  { id: 'mycash', label: 'My Cash', roles: ['Admin', 'HR', 'Employee'], render: viewMyCash },
  { id: 'vouchers', label: 'All Cash Entries', roles: ['Owner', 'Admin'], render: viewVouchers },
  { id: 'expenses', label: 'Expenses', roles: ['Owner', 'Admin'], render: viewExpenses },
  { id: 'ledger', label: 'Ledger', roles: ROLES, render: viewLedger },
  { id: 'advances', label: 'Employee Advances', roles: ['Owner', 'Admin', 'HR'], render: viewAdvances },
  { id: 'employees', label: 'Employees', roles: ['Admin', 'HR'], render: viewEmployees },
  { id: 'settings', label: 'Settings', roles: ['Admin'], render: viewSettings }
];

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  approvals: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  mycash: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M16 13.5h2"/>',
  vouchers: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  expenses: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  ledger: '<path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z"/><path d="M4 17a3 3 0 0 1 3-3h11"/>',
  advances: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M17 11h5M19.5 8.5v5"/>',
  employees: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 16.5c.6-1.6 2-2.5 3.5-2.5s2.9.9 3.5 2.5M15 10h3M15 14h3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'
};

function buildNav() {
  $('#nav').innerHTML = NAV.filter(n => n.roles.includes(role()))
    .map(n => `<a class="nav-item" data-id="${n.id}"><span class="ni"><svg viewBox="0 0 24 24">${ICONS[n.id] || ''}</svg>${n.label}</span>${n.id === 'approvals' ? '<span class="count hidden" id="apprCount"></span>' : ''}</a>`).join('');
  $$('.nav-item').forEach(a => a.onclick = () => go(a.dataset.id));
  $('#todayTxt').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function go(id, params = {}) {
  const allowed = NAV.filter(n => n.roles.includes(role()));
  const item = allowed.find(n => n.id === id) || allowed[0];
  S.view = item.id; S.params = params;
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.id === item.id));
  $('#pageTitle').textContent = item.label;
  const page = $('#page'), host = document.createElement('div');
  page.replaceChildren(host);
  page.classList.remove('fade-in'); void page.offsetWidth; page.classList.add('fade-in');
  window.scrollTo(0, 0);
  item.render(host, params);
}
function refreshView() { if (S.view) go(S.view, S.params); }

function setBadge(n) {
  S.badge = n;
  const el = $('#apprCount');
  if (!el) return;
  el.textContent = n;
  el.classList.toggle('hidden', !n);
}
async function refreshBadge() {
  if (!isMgr()) return;
  const r = await call('approvals', {}, true);
  if (r && r.ok) setBadge(r.count);
}

/* =========================== Dashboard =========================== */
async function viewDashboard(el) {
  el.innerHTML = `<div class="kpis">${skel(1).repeat(4)}</div>${skel(6)}`;
  load('dashboard', {}, r => {
  if (!r || !r.ok) { el.innerHTML = errBox(); return bindRetry(el); }
  setBadge(r.kpi.pending);
  const k = r.kpi;
  const maxP = Math.max(1, ...r.byPurpose.map(p => p.amount));
  el.innerHTML = `
    <div class="kpis">
      ${kpi('Cash with people', inr(k.cashOut), 'Given, not yet accounted', { hl: true })}
      ${kpi('Pending confirmations', k.pending, 'Cash given / returns to confirm', { go: 'approvals' })}
      ${kpi('Overdue entries', k.overdue, `Open for more than ${r.overdueDays} days`, { go: 'vouchers' })}
      ${kpi('Payable by Owner', inr(k.ownerOwes), 'Spent more than given')}
      ${kpi('Given this month', inr(k.givenMonth), 'Confirmed cash entries')}
      ${kpi('Spent this month', inr(k.spentMonth), k.noBill + ' expenses without bill', { go: 'expenses' })}
      ${kpi('Advance outstanding', inr(k.advOut), k.advEmp + ' employees', { go: 'advances' })}
    </div>
    <div class="grid2">
      <div class="card"><div class="card-h">Who holds how much <span class="muted">Open entries · click for ledger</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Person</th><th class="right">Open</th><th class="right">Given</th><th class="right">Spent</th><th class="right">Balance</th><th class="right">Oldest</th></tr></thead>
        <tbody>${r.persons.map(p => `<tr class="click" data-person="${esc(p.person)}"><td>${esc(p.person)}${p.overdue ? ' <span class="badge b-rejected">' + p.overdue + ' overdue</span>' : ''}</td>
          <td class="right">${p.open}</td><td class="right">${inr(p.given)}</td><td class="right">${inr(p.spent)}</td>
          <td class="right"><b class="${p.balance < 0 ? 'neg' : ''}">${inr(p.balance)}</b></td><td class="right">${p.oldestDays}d</td></tr>`).join('') ||
          '<tr><td colspan="6">' + emptyBox('Nobody is holding cash right now') + '</td></tr>'}</tbody></table></div></div>
      <div class="card"><div class="card-h">Spend by purpose <span class="muted">${esc(r.month)}</span></div>
        <div class="card-b">${r.byPurpose.map(p => `<div class="bar-row"><span class="lbl">${esc(p.purpose)}</span>
          <div class="bar"><span style="width:${(p.amount / maxP * 100).toFixed(1)}%"></span></div><b class="right">${inr(p.amount)}</b></div>`).join('') ||
          emptyBox('No expenses this month')}</div></div>
    </div>
    <div class="grid2" style="margin-top:18px">
      <div class="card"><div class="card-h">Overdue entries <span class="muted">older than ${r.overdueDays} days with balance</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Entry</th><th>Person</th><th>Purpose</th><th class="right">Balance</th><th class="right">Days</th></tr></thead>
        <tbody>${r.overdue.map(v => `<tr class="click" data-v="${esc(v.VoucherID)}"><td>${esc(v.VoucherID)}</td><td>${esc(v.Person)}</td><td>${esc(v.Purpose)}</td>
          <td class="right"><b>${inr(v.Balance)}</b></td><td class="right neg">${v.Days}</td></tr>`).join('') ||
          '<tr><td colspan="5">' + emptyBox('No overdue entries') + '</td></tr>'}</tbody></table></div></div>
      <div class="card"><div class="card-h">Expenses without bill <span class="muted">this month</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Person</th><th>Paid to</th><th class="right">Amount</th></tr></thead>
        <tbody>${r.noBill.map(e => `<tr class="click" data-v="${esc(e.VoucherID)}"><td>${esc(e.Date)}</td><td>${esc(e.Person)}</td><td>${esc(e.PaidTo)}</td>
          <td class="right">${inr(e.Amount)}</td></tr>`).join('') ||
          '<tr><td colspan="4">' + emptyBox('All expenses have bills') + '</td></tr>'}</tbody></table></div></div>
    </div>`;
  $$('[data-go]', el).forEach(c => c.onclick = () => go(c.dataset.go, c.dataset.go === 'vouchers' ? { overdue: true } : {}));
  $$('[data-person]', el).forEach(tr => tr.onclick = () => go('ledger', { person: tr.dataset.person }));
  $$('[data-v]', el).forEach(tr => tr.onclick = () => openVoucher(tr.dataset.v));
  }, el);
}

/* =========================== Approvals =========================== */
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
      <tbody>${r.vouchers.map(v => `<tr><td>${esc(v.Date)}</td><td><b>${esc(v.Person)}</b></td><td>${esc(v.Purpose)}</td>
        <td class="right"><b>${inr(v.Amount)}</b></td><td>${esc(v.Mode)}</td><td class="wrap">${esc(v.Remarks)}</td><td class="right">${btns('V', v.VoucherID)}</td></tr>`).join('') ||
        '<tr><td colspan="7">' + emptyBox('Nothing to confirm') + '</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="card-h">Cash returned — waiting for confirmation <span class="muted">${r.returns.length}</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Person</th><th>Entry</th><th class="right">Amount</th><th>Mode</th><th>Remarks</th><th></th></tr></thead>
      <tbody>${r.returns.map(x => `<tr><td>${esc(x.Date)}</td><td><b>${esc(x.Person)}</b></td><td><a href="#" data-v="${esc(x.VoucherID)}">${esc(x.VoucherID)}</a> · ${esc(x.Purpose)}</td>
        <td class="right"><b>${inr(x.Amount)}</b></td><td>${esc(x.Mode)}</td><td class="wrap">${esc(x.Remarks)}</td><td class="right">${btns('R', x.ReturnID)}</td></tr>`).join('') ||
        '<tr><td colspan="7">' + emptyBox('Nothing to confirm') + '</td></tr>'}</tbody></table></div></div>`;

  $$('[data-v]', el).forEach(a => a.onclick = e => { e.preventDefault(); openVoucher(a.dataset.v); });
  $$('[data-ok]', el).forEach(b => b.onclick = async () => {
    const [type, id] = b.dataset.ok.split('|');
    const r2 = await act(b, type === 'V' ? 'confirmVoucher' : 'confirmReturn', { id, decision: 'confirm' }, 'Confirmed');
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
      <span class="spacer"></span><button class="btn btn-ghost" id="quickExp">+ Expense</button>
      <button class="btn btn-primary btn-auto" id="newCash">+ Cash Received</button>
    </div><div id="mcBody">${skel(4)}</div>`;
  $$('[data-status]', el).forEach(c => c.onclick = () => { f.status = c.dataset.status; f.page = 1; viewMyCash(el); });
  $('#newCash', el).onclick = formVoucher;
  $('#quickExp', el).onclick = () => quickExpense(S.openList);

  load('listVouchers', { page: f.page, status: f.status, mine: '1' }, r => {
  const body = $('#mcBody', el);
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  const s = r.summary;
  S.openList = r.openList || [];
  body.innerHTML = `<div class="kpis">
      ${kpi('Cash in hand', inr(s.cashInHand), 'Received but not yet accounted', { hl: true })}
      ${kpi('Open entries', s.open, s.overdue ? s.overdue + ' overdue' : 'Add expenses or return cash')}
      ${kpi('Waiting for Owner', s.pending, 'Not yet confirmed')}
      ${s.payable ? kpi('Payable by Owner', inr(s.payable), 'You spent more than received') : ''}
    </div>
    <div class="vlist">${r.rows.map(vCard).join('') || emptyBox('No entries yet. Tap "Cash Received" when the Owner gives you cash.')}</div>
    ${pager(r)}`;
  $$('[data-v]', body).forEach(c => c.onclick = () => openVoucher(c.dataset.v));
  $$('[data-add]', body).forEach(b => b.onclick = e => {
    e.stopPropagation();
    const v = r.rows.find(x => x.VoucherID === b.dataset.add);
    formExpense(v, v.Purpose === S.settings.advancePurpose);
  });
  bindPager(body, p => { f.page = p; viewMyCash(el); });
  }, $('#mcBody', el));
}

function vCard(v) {
  const amt = num(v.Amount);
  const used = amt ? Math.min(100, (num(v.Spent) + num(v.Returned)) / amt * 100) : 0;
  return `<div class="vcard fade-in" data-v="${esc(v.VoucherID)}">
    <div class="vc-top"><div><div class="vc-title">${esc(v.Purpose)}</div>
      <div class="muted sm">${esc(v.VoucherID)} · ${esc(v.Date)} · ${esc(v.Mode)}</div></div>${badge(v.Status, v.Overdue)}</div>
    <div class="vc-nums"><div><span>Received</span><b>${inr(amt)}</b></div><div><span>Spent</span><b>${inr(v.Spent)}</b></div>
      <div><span>Returned</span><b>${inr(v.Returned)}</b></div><div><span>Balance</span><b class="${num(v.Balance) < 0 ? 'neg' : ''}">${inr(v.Balance)}</b></div></div>
    <div class="progress"><span style="width:${used.toFixed(1)}%"></span></div>
    ${v.Status === 'Rejected' && v.RejectReason ? `<div class="note bad" style="margin:10px 0 0">Rejected: ${esc(v.RejectReason)}</div>` : ''}
    ${v.Status === 'Open' && v.Person === S.me.name ? `<div class="vc-foot"><button class="btn btn-ghost btn-sm" data-add="${esc(v.VoucherID)}">+ Expense</button></div>` : ''}
  </div>`;
}

/* "+ Expense" from the toolbar: pick the open entry (or go straight in if there is one) */
function quickExpense(list) {
  if (!list || !list.length) return toast('No open entry yet. Add "Cash Received" and wait for Owner confirmation.', false);
  const go1 = v => formExpense(v, v.Purpose === S.settings.advancePurpose);
  if (list.length === 1) return go1(list[0]);
  const box = openModal(`<div class="m-head"><div><div class="m-title">Add expense to</div>
      <div class="muted sm">Choose the cash entry this expense was paid from</div></div><button class="x" data-close>&times;</button></div>
    <div class="pick-list">${list.map(v => `<button class="pick" data-v="${esc(v.VoucherID)}">
      <span><b>${esc(v.Purpose)}</b><small>${esc(v.VoucherID)} · ${esc(v.Date)}</small></span>
      <span class="right"><small>Balance</small><b>${inr(v.Balance)}</b></span></button>`).join('')}</div>`);
  $$('[data-v]', box).forEach(b => b.onclick = () => go1(list.find(x => x.VoucherID === b.dataset.v)));
}

/* =========================== All cash entries (Owner/Admin) =========================== */
async function viewVouchers(el, params = {}) {
  const f = S.f.vouchers = S.f.vouchers || { page: 1, q: '', status: '', person: '', purpose: '', overdue: false };
  if (params.overdue) { f.overdue = true; f.status = ''; f.page = 1; S.params = {}; }
  el.innerHTML = `<div class="toolbar">
      <input class="input search" id="q" placeholder="Search entry, person, remarks…" value="${esc(f.q)}" />
      <select class="input" id="fStatus">${opts(['Pending Confirm', 'Open', 'Closed', 'Rejected'], f.status, 'All statuses')}</select>
      <select class="input" id="fPerson">${opts(S.persons, f.person, 'All persons')}</select>
      <select class="input" id="fPurpose">${opts(S.cfg.Purpose, f.purpose, 'All purposes')}</select>
      <label class="check"><input type="checkbox" id="fOver" ${f.overdue ? 'checked' : ''}/> Overdue only</label>
      <span class="spacer"></span><button class="btn btn-ghost" id="exp">Export CSV</button>
    </div><div id="vBody">${skel(6)}</div>`;
  const reload = () => { f.page = 1; viewVouchers(el); };
  $('#q', el).oninput = debounce(e => { f.q = e.target.value; reload(); });
  $('#fStatus', el).onchange = e => { f.status = e.target.value; reload(); };
  $('#fPerson', el).onchange = e => { f.person = e.target.value; reload(); };
  $('#fPurpose', el).onchange = e => { f.purpose = e.target.value; reload(); };
  $('#fOver', el).onchange = e => { f.overdue = e.target.checked; reload(); };
  const params2 = () => ({ q: f.q, status: f.status, person: f.person, purpose: f.purpose, overdue: f.overdue ? '1' : '' });
  $('#exp', el).onclick = async e => {
    const r = await act(e.target, 'listVouchers', Object.assign(params2(), { all: '1' }));
    if (r) exportCSV('cash_entries', [['VoucherID', 'Entry'], ['Date', 'Date'], ['Person', 'Person'], ['Purpose', 'Purpose'], ['Amount', 'Amount'],
      ['Mode', 'Mode'], ['Spent', 'Spent'], ['Returned', 'Returned'], ['Balance', 'Balance'], ['Status', 'Status'], ['Days', 'Days'],
      ['Remarks', 'Remarks'], ['ConfirmedBy', 'Confirmed By'], ['ClosedBy', 'Closed By'], ['CloseNote', 'Close Note']], r.rows);
  };

  load('listVouchers', Object.assign(params2(), { page: f.page }), r => {
  const body = $('#vBody', el);
  if (!body) return;
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  body.innerHTML = `<div class="table-card"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Entry</th><th>Date</th><th>Person</th><th>Purpose</th><th class="right">Amount</th><th class="right">Spent</th>
      <th class="right">Returned</th><th class="right">Balance</th><th>Status</th></tr></thead>
    <tbody>${r.rows.map(v => `<tr class="click" data-v="${esc(v.VoucherID)}"><td>${esc(v.VoucherID)}</td><td>${esc(v.Date)}</td><td>${esc(v.Person)}</td>
      <td>${esc(v.Purpose)}</td><td class="right">${inr(v.Amount)}</td><td class="right">${inr(v.Spent)}</td><td class="right">${inr(v.Returned)}</td>
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
  if (!r || !r.ok) {
    box.innerHTML = `<div class="m-head"><div><div class="m-title">${esc(id)}</div></div><button class="x" data-close>&times;</button></div>${errBox()}`;
    const b = $('[data-retry]', box); if (b) b.onclick = () => openVoucher(id);
    return;
  }
  const v = r.voucher;
  const own = v.Person === S.me.name;
  const isOpen = v.Status === 'Open', isPending = v.Status === 'Pending Confirm';
  const pendRet = r.returns.filter(x => x.Status === 'Pending Confirm');
  const canDelExp = isOpen && (own || isAdmin());

  const actions = [];
  if (isOwner() && isPending) actions.push('<button class="btn btn-danger" data-a="reject">Reject</button>', '<button class="btn btn-ok" data-a="confirm">Confirm cash given</button>');
  if (isOwner() && isOpen) actions.push('<button class="btn btn-ghost" data-a="close">Settle &amp; Close</button>');
  if ((own || isAdmin()) && isPending) actions.push('<button class="btn btn-danger" data-a="cancel">Cancel entry</button>');
  if (own && isOpen) actions.push('<button class="btn btn-ghost" data-a="return">Return Cash</button>', '<button class="btn btn-primary btn-auto" data-a="expense">+ Add Expense</button>');

  box.innerHTML = `
    <div class="m-head"><div><div class="m-title">${esc(v.Purpose)} · ${esc(v.VoucherID)}</div>
      <div class="muted sm">${esc(v.Person)} · ${esc(v.Date)} · ${esc(v.Mode)} · ${v.Days} day${v.Days === 1 ? '' : 's'} old</div></div>
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
    ${num(v.Balance) < 0 ? `<div class="note bad">Spent ${inr(-num(v.Balance))} more than received — payable by Owner.</div>` : ''}
    ${v.Status === 'Closed' ? `<div class="note">Closed by ${esc(v.ClosedBy)} on ${esc(v.ClosedAt)}${v.CloseNote ? ' — ' + esc(v.CloseNote) : ''}</div>` : ''}

    <div class="m-section"><h4>Expenses (${r.expenses.length})</h4>
      <div class="table-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>${r.isAdvance ? 'Employee' : 'Paid to'}</th><th>Description</th>
        <th class="right">Amount</th><th>Bill</th>${canDelExp ? '<th></th>' : ''}</tr></thead>
      <tbody>${r.expenses.map(e => `<tr><td>${esc(e.Date)}</td><td>${esc(e.PaidTo)}${e.AdvanceID ? ` <span class="muted sm">${esc(e.AdvanceID)}</span>` : ''}</td>
        <td class="wrap">${esc(e.Description)}</td><td class="right">${inr(e.Amount)}</td><td>${billLink(e.BillURL)}</td>
        ${canDelExp ? `<td class="right"><button class="icon-btn" title="Remove" data-del="${esc(e.ExpenseID)}">&times;</button></td>` : ''}</tr>`).join('') ||
        `<tr><td colspan="6">${emptyBox('No expenses added yet')}</td></tr>`}</tbody></table></div></div></div>

    ${r.returns.length ? `<div class="m-section"><h4>Cash returned (${r.returns.length})</h4>
      <div class="table-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th class="right">Amount</th><th>Mode</th><th>Remarks</th><th>Status</th>${isOwner() ? '<th></th>' : ''}</tr></thead>
      <tbody>${r.returns.map(x => `<tr><td>${esc(x.Date)}</td><td class="right">${inr(x.Amount)}</td><td>${esc(x.Mode)}</td>
        <td class="wrap">${esc(x.Remarks)}${x.RejectReason ? ' — <span class="neg">' + esc(x.RejectReason) + '</span>' : ''}</td><td>${badge(x.Status)}</td>
        ${isOwner() ? `<td class="right">${x.Status === 'Pending Confirm' ? `<button class="btn btn-ok btn-sm" data-rok="${esc(x.ReturnID)}">Confirm</button>
          <button class="btn btn-danger btn-sm" data-rrej="${esc(x.ReturnID)}">Reject</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div></div></div>` : ''}

    ${actions.length ? `<div class="m-actions" style="margin-top:20px">${actions.join('')}</div>` : ''}`;

  const done = (msg, res) => { if (msg) toast(msg); refreshView(); refreshBadge(); openVoucher(id, res && res.detail); };
  const A = a => $(`[data-a="${a}"]`, box);

  if (A('confirm')) A('confirm').onclick = async e => { { const x = await act(e.currentTarget, 'confirmVoucher', { id, decision: 'confirm' }); if (x) done('Cash entry confirmed', x); } };
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
  if (A('expense')) A('expense').onclick = () => formExpense(v, r.isAdvance);
  if (A('return')) A('return').onclick = () => formReturn(v, sum(pendRet, 'Amount'));
  $$('[data-del]', box).forEach(b => b.onclick = async () => {
    if (!(await confirmBox('Remove expense', 'This expense will be removed from the entry.', 'Remove', true))) return;
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
  const purposes = S.cfg.Purpose.filter(p => p !== S.settings.advancePurpose || isAdvMgr());
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">Cash Received from Owner</div></div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label>Date<input class="input" type="date" name="Date" max="${today()}" value="${esc(d.Date || today())}" /></label>
      <label>Amount (₹)<input class="input" type="number" name="Amount" inputmode="decimal" min="1" step="0.01" value="${esc(d.Amount || '')}" placeholder="0" /></label>
      <label>Purpose<select class="input" name="Purpose">${opts(purposes, d.Purpose, 'Select purpose')}</select></label>
      <label>Payment mode<select class="input" name="Mode">${opts(S.cfg.PaymentMode, d.Mode || S.cfg.PaymentMode[0], 'Select mode')}</select></label>
      <label class="full">Remarks<textarea class="input" name="Remarks" rows="2" maxlength="300" placeholder="What is this cash for?">${esc(d.Remarks || '')}</textarea></label>
      <p class="hint full">The Owner will confirm this entry. You can add expenses after confirmation.</p>
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-auto">Submit</button></div>
    </form>`);
  const form = $('form', box);
  trackDraft(form, key, ref);
  form.onsubmit = async e => {
    e.preventDefault();
    const rec = formData(form); rec.ClientRef = ref;
    const err = vDate(rec.Date) || vMoney(rec.Amount) || vReq(rec.Purpose, 'Purpose') || vReq(rec.Mode, 'Payment mode');
    if (err) return toast(err, false);
    const r = await submit(form, 'createVoucher', { record: JSON.stringify(rec) });
    if (!r) return;
    clearDraft(key); closeModal(); toast('Sent to Owner for confirmation'); refreshView(); refreshBadge();
  };
}

function formExpense(v, isAdvance) {
  const key = 'exp_' + v.VoucherID, d = getDraft(key);
  let ref = d.ClientRef || uid(), bal = num(v.Balance), up = null, more = false;
  const empOpts = S.employees.map(e => `<option value="${esc(e.id)}" ${e.id === d.EmpID ? 'selected' : ''}>${esc(e.name)}${e.dept ? ' — ' + esc(e.dept) : ''}</option>`).join('');
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">${isAdvance ? 'Advance Given to Employee' : 'Add Expense'}</div>
      <div class="muted sm">${esc(v.VoucherID)} · ${esc(v.Purpose)} · Balance <b id="expBal">${inr(bal)}</b></div></div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label>Date<input class="input" type="date" name="Date" max="${today()}" value="${esc(d.Date || today())}" /></label>
      <label>Amount (₹)<input class="input" type="number" name="Amount" inputmode="decimal" min="1" step="0.01" value="${esc(d.Amount || '')}" placeholder="0" /></label>
      ${isAdvance
        ? `<label class="full">Employee<select class="input" name="EmpID"><option value="">Select employee</option>${empOpts}</select>
            ${S.employees.length ? '' : '<span class="hint">No employees found in the Employee Master.</span>'}</label>`
        : `<label class="full">Paid to<input class="input" name="PaidTo" maxlength="120" value="${esc(d.PaidTo || '')}" placeholder="Vendor / shop / person" /></label>`}
      <label class="full">Description<textarea class="input" name="Description" rows="2" maxlength="300" placeholder="${isAdvance ? 'Reason for advance (optional)' : 'What was bought / paid for'}">${esc(d.Description || '')}</textarea></label>
      <label class="full file-pick" id="pick"><input type="file" accept="image/*,application/pdf" /><span id="pickTxt">Attach bill photo (optional)</span></label>
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Close</button>
        <button type="submit" class="btn btn-ghost" data-more>Save &amp; add another</button>
        <button type="submit" class="btn btn-primary btn-auto">Save</button></div>
    </form>`);
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
      if (up === job) { pick.classList.remove('has'); pickTxt.textContent = 'Upload failed — tap to choose again'; }
      throw er;
    });
    job.promise.catch(() => {});
    up = job;
  };
  fileIn.onchange = () => { const f = fileIn.files[0]; if (f) startUpload(f); else resetPick(); };

  form.onsubmit = async e => {
    e.preventDefault();
    if (form.dataset.busy === '1') return;
    const rec = formData(form); rec.VoucherID = v.VoucherID; rec.ClientRef = ref;
    const err = vDate(rec.Date) || vMoney(rec.Amount) || (isAdvance ? vReq(rec.EmpID, 'Employee') : vReq(rec.PaidTo, 'Paid to'));
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
    toast(isAdvance ? 'Advance recorded' : 'Expense saved');
    refreshView();
    if (r.detail) memoSet('voucherDetail', { id: v.VoucherID }, r.detail);
    if (!more) return openVoucher(v.VoucherID, r.detail);
    // keep the form open for the next expense
    bal = num(r.balance != null ? r.balance : bal - num(rec.Amount));
    $('#expBal', box).textContent = inr(bal);
    ref = uid();
    ['Amount', 'PaidTo', 'Description', 'EmpID'].forEach(n => { const f = $(`[name=${n}]`, form); if (f) f.value = ''; });
    resetPick();
    $('[name=Amount]', form).focus();
  };
}

function formReturn(v, pendingAmt) {
  const key = 'ret_' + v.VoucherID, d = getDraft(key), ref = d.ClientRef || uid();
  const max = Math.round((num(v.Balance) - pendingAmt) * 100) / 100;
  if (max <= 0) return toast(pendingAmt ? 'A return is already waiting for confirmation' : 'No balance left to return', false);
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">Return Cash to Owner</div>
      <div class="muted sm">${esc(v.VoucherID)} · You can return up to ${inr(max)}</div></div><button class="x" data-close>&times;</button></div>
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
    const rec = formData(form); rec.VoucherID = v.VoucherID; rec.ClientRef = ref;
    const err = vDate(rec.Date) || vMoney(rec.Amount) || (num(rec.Amount) > max ? 'Amount cannot be more than ' + inr(max) : null) || vReq(rec.Mode, 'Mode');
    if (err) return toast(err, false);
    const r = await submit(form, 'addReturn', { record: JSON.stringify(rec) });
    if (!r) return;
    clearDraft(key); toast('Return sent to Owner for confirmation'); refreshView(); refreshBadge(); openVoucher(v.VoucherID, r.detail);
  };
}

/* =========================== Expenses (Owner/Admin) =========================== */
async function viewExpenses(el) {
  const f = S.f.expenses = S.f.expenses || { page: 1, q: '', person: '', purpose: '', from: monthStart(), to: today(), noBill: false };
  el.innerHTML = `<div class="toolbar">
      <input class="input search" id="q" placeholder="Search paid to, description…" value="${esc(f.q)}" />
      <select class="input" id="fPerson">${opts(S.persons, f.person, 'All persons')}</select>
      <select class="input" id="fPurpose">${opts(S.cfg.Purpose, f.purpose, 'All purposes')}</select>
      <input class="input" type="date" id="fFrom" value="${esc(f.from)}" />
      <input class="input" type="date" id="fTo" value="${esc(f.to)}" />
      <label class="check"><input type="checkbox" id="fNoBill" ${f.noBill ? 'checked' : ''}/> Without bill</label>
      <span class="spacer"></span><button class="btn btn-ghost" id="exp">Export CSV</button>
    </div><div id="eBody">${skel(6)}</div>`;
  const reload = () => { f.page = 1; viewExpenses(el); };
  $('#q', el).oninput = debounce(e => { f.q = e.target.value; reload(); });
  $('#fPerson', el).onchange = e => { f.person = e.target.value; reload(); };
  $('#fPurpose', el).onchange = e => { f.purpose = e.target.value; reload(); };
  $('#fFrom', el).onchange = e => { f.from = e.target.value; reload(); };
  $('#fTo', el).onchange = e => { f.to = e.target.value; reload(); };
  $('#fNoBill', el).onchange = e => { f.noBill = e.target.checked; reload(); };
  const p = () => ({ q: f.q, person: f.person, purpose: f.purpose, from: f.from, to: f.to, noBill: f.noBill ? '1' : '' });
  $('#exp', el).onclick = async e => {
    const r = await act(e.target, 'listExpenses', Object.assign(p(), { all: '1' }));
    if (r) exportCSV('expenses', [['ExpenseID', 'Expense'], ['VoucherID', 'Entry'], ['Date', 'Date'], ['Person', 'Person'], ['Purpose', 'Purpose'],
      ['PaidTo', 'Paid To'], ['Description', 'Description'], ['Amount', 'Amount'], ['BillURL', 'Bill'], ['EmpName', 'Employee (advance)']], r.rows);
  };

  load('listExpenses', Object.assign(p(), { page: f.page }), r => {
  const body = $('#eBody', el);
  if (!body) return;
  if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
  body.innerHTML = `<div class="table-card"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Date</th><th>Person</th><th>Purpose</th><th>Paid to</th><th>Description</th><th class="right">Amount</th><th>Bill</th><th>Entry</th></tr></thead>
    <tbody>${r.rows.map(e => `<tr><td>${esc(e.Date)}</td><td>${esc(e.Person)}</td><td>${esc(e.Purpose)}</td><td>${esc(e.PaidTo)}</td>
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
      ${isMgr() ? `<select class="input" id="fPerson">${opts(S.persons, f.person, 'Select person')}</select>` : `<b>${esc(S.me.name)}</b>`}
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

/* =========================== Employee Advances =========================== */
async function viewAdvances(el) {
  const f = S.f.advances = S.f.advances || { tab: 'emp', page: 1, status: '', empId: '', q: '' };
  el.innerHTML = skel(6);
  load('listAdvances', { page: f.page, status: f.status, empId: f.empId, q: f.q }, r => {
  if (!r || !r.ok) { el.innerHTML = errBox(); return bindRetry(el); }
  const s = r.summary;
  const empName = id => (r.byEmployee.find(e => e.EmpID === id) || {}).EmpName || id;
  el.innerHTML = `<div class="kpis">
      ${kpi('Total outstanding', inr(s.totalOut), 'to be recovered', { hl: true })}
      ${kpi('Employees with advance', s.empCount, 'outstanding > 0')}
      ${kpi('Recovered this month', inr(s.recMonth), 'salary + cash')}
    </div>
    <p class="hint" style="margin:-6px 0 14px">Advances are created when HR adds an expense on an "${esc(S.settings.advancePurpose)}" cash entry.</p>
    <div class="tabs"><button class="tab ${f.tab === 'emp' ? 'on' : ''}" data-tab="emp">By Employee</button>
      <button class="tab ${f.tab === 'list' ? 'on' : ''}" data-tab="list">All Advances</button></div>
    <div id="aBody"></div>`;
  $$('[data-tab]', el).forEach(t => t.onclick = () => { f.tab = t.dataset.tab; viewAdvances(el); });
  const body = $('#aBody', el);

  if (f.tab === 'emp') {
    body.innerHTML = `<div class="table-card"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Employee</th><th class="right">Advances</th><th class="right">Total given</th><th class="right">Recovered</th><th class="right">Outstanding</th></tr></thead>
      <tbody>${r.byEmployee.map(e => `<tr class="click" data-emp="${esc(e.EmpID)}"><td>${esc(e.EmpName)} <span class="muted sm">${esc(e.EmpID)}</span></td>
        <td class="right">${e.count}</td><td class="right">${inr(e.total)}</td><td class="right">${inr(e.recovered)}</td>
        <td class="right"><b>${inr(e.outstanding)}</b></td></tr>`).join('') ||
        '<tr><td colspan="5">' + emptyBox('No advances yet') + '</td></tr>'}</tbody></table></div></div>`;
    $$('[data-emp]', body).forEach(tr => tr.onclick = () => { f.tab = 'list'; f.empId = tr.dataset.emp; f.page = 1; viewAdvances(el); });
    return;
  }

  body.innerHTML = `<div class="toolbar">
      <input class="input search" id="q" placeholder="Search…" value="${esc(f.q)}" />
      <select class="input" id="fEmp"><option value="">All employees</option>${r.byEmployee.map(e => `<option value="${esc(e.EmpID)}" ${e.EmpID === f.empId ? 'selected' : ''}>${esc(e.EmpName)}</option>`).join('')}</select>
      <select class="input" id="fStatus">${opts(['Outstanding', 'Partly Recovered', 'Recovered'], f.status, 'All statuses')}</select>
      <span class="spacer"></span><button class="btn btn-ghost" id="exp">Export CSV</button></div>
    <div class="table-card"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Advance</th><th>Date</th><th>Employee</th><th class="right">Amount</th><th class="right">Recovered</th><th class="right">Outstanding</th><th>Status</th><th>Given by</th></tr></thead>
      <tbody>${r.rows.map(a => `<tr class="click" data-adv="${esc(a.AdvanceID)}"><td>${esc(a.AdvanceID)}</td><td>${esc(a.Date)}</td><td>${esc(a.EmpName)}</td>
        <td class="right">${inr(a.Amount)}</td><td class="right">${inr(a.Recovered)}</td><td class="right"><b>${inr(a.Outstanding)}</b></td>
        <td>${badge(a.Status)}</td><td>${esc(a.GivenBy)}</td></tr>`).join('') ||
        '<tr><td colspan="8">' + emptyBox(f.empId ? 'No advances for ' + empName(f.empId) : 'No advances found') + '</td></tr>'}</tbody></table></div></div>${pager(r)}`;
  const reload = () => { f.page = 1; viewAdvances(el); };
  $('#q', body).oninput = debounce(e => { f.q = e.target.value; reload(); });
  $('#fEmp', body).onchange = e => { f.empId = e.target.value; reload(); };
  $('#fStatus', body).onchange = e => { f.status = e.target.value; reload(); };
  $('#exp', body).onclick = async e => {
    const x = await act(e.target, 'listAdvances', { status: f.status, empId: f.empId, q: f.q, all: '1' });
    if (x) exportCSV('advances', [['AdvanceID', 'Advance'], ['Date', 'Date'], ['EmpID', 'Emp ID'], ['EmpName', 'Employee'], ['Amount', 'Amount'],
      ['Recovered', 'Recovered'], ['Outstanding', 'Outstanding'], ['Status', 'Status'], ['GivenBy', 'Given By'], ['VoucherID', 'Cash Entry']], x.rows);
  };
  $$('[data-adv]', body).forEach(tr => tr.onclick = () => openAdvance(tr.dataset.adv));
  bindPager(body, p => { f.page = p; viewAdvances(el); });
  }, el);
}

async function openAdvance(id) {
  const box = openModal(`<div class="m-head"><div><div class="m-title">Loading…</div></div><button class="x" data-close>&times;</button></div>${skel(3)}`, true);
  const r = await call('advanceDetail', { id });
  if ($('#modal').classList.contains('hidden')) return;
  if (!r || !r.ok) { box.innerHTML = `<div class="m-head"><div><div class="m-title">${esc(id)}</div></div><button class="x" data-close>&times;</button></div>${emptyBox('Could not load')}`; return; }
  const a = r.advance, out = num(a.Outstanding);
  box.innerHTML = `
    <div class="m-head"><div><div class="m-title">${esc(a.EmpName)} · ${esc(a.AdvanceID)}</div>
      <div class="muted sm">${esc(a.Date)} · Given by ${esc(a.GivenBy)} · Cash entry ${esc(a.VoucherID)}</div></div>${badge(a.Status)}<button class="x" data-close>&times;</button></div>
    <div class="stat-row" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><span>Advance</span><b>${inr(a.Amount)}</b></div>
      <div class="stat"><span>Recovered</span><b>${inr(a.Recovered)}</b></div>
      <div class="stat"><span>Outstanding</span><b>${inr(out)}</b></div>
    </div>
    <div class="m-section"><h4>Recoveries (${r.recoveries.length})</h4>
      <div class="table-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Mode</th><th>Salary month</th><th class="right">Amount</th><th>Remarks</th>${isAdvMgr() ? '<th></th>' : ''}</tr></thead>
      <tbody>${r.recoveries.map(x => `<tr><td>${esc(x.Date)}</td><td>${esc(x.Mode)}</td><td>${esc(x.SalaryMonth)}</td><td class="right">${inr(x.Amount)}</td>
        <td class="wrap">${esc(x.Remarks)}</td>${isAdvMgr() ? `<td class="right"><button class="icon-btn" title="Remove" data-del="${esc(x.RecoveryID)}">&times;</button></td>` : ''}</tr>`).join('') ||
        `<tr><td colspan="6">${emptyBox('No recovery yet')}</td></tr>`}</tbody></table></div></div></div>
    ${isAdvMgr() && out > 0 ? '<div class="m-actions" style="margin-top:20px"><button class="btn btn-primary btn-auto" data-add>+ Add Recovery</button></div>' : ''}`;
  const add = $('[data-add]', box);
  if (add) add.onclick = () => formRecovery(a);
  $$('[data-del]', box).forEach(b => b.onclick = async () => {
    if (!(await confirmBox('Remove recovery', 'Outstanding will increase again. Continue?', 'Remove', true))) return;
    if (await act(b, 'deleteRecovery', { id: b.dataset.del }, 'Recovery removed')) { refreshView(); openAdvance(id); }
  });
}

function formRecovery(a) {
  const key = 'rec_' + a.AdvanceID, d = getDraft(key), ref = d.ClientRef || uid();
  const out = num(a.Outstanding);
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">Add Recovery</div><div class="muted sm">${esc(a.EmpName)} · Outstanding ${inr(out)}</div></div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label>Date<input class="input" type="date" name="Date" max="${today()}" value="${esc(d.Date || today())}" /></label>
      <label>Amount (₹)<input class="input" type="number" name="Amount" inputmode="decimal" min="1" max="${out}" step="0.01" value="${esc(d.Amount || '')}" /></label>
      <label>Recovery mode<select class="input" name="Mode">${opts(S.cfg.RecoveryMode, d.Mode || S.cfg.RecoveryMode[0], 'Select mode')}</select></label>
      <label id="smWrap">Salary month<input class="input" type="month" name="SalaryMonth" value="${esc(d.SalaryMonth || today().slice(0, 7))}" /></label>
      <label class="full">Remarks<textarea class="input" name="Remarks" rows="2" maxlength="300">${esc(d.Remarks || '')}</textarea></label>
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-auto">Save Recovery</button></div>
    </form>`);
  const form = $('form', box), mode = $('[name=Mode]', form);
  const syncMonth = () => $('#smWrap', box).classList.toggle('hidden', !/salary/i.test(mode.value));
  mode.onchange = syncMonth; syncMonth();
  trackDraft(form, key, ref);
  form.onsubmit = async e => {
    e.preventDefault();
    const rec = formData(form); rec.AdvanceID = a.AdvanceID; rec.ClientRef = ref;
    if (!/salary/i.test(rec.Mode)) rec.SalaryMonth = '';
    const err = vDate(rec.Date) || vMoney(rec.Amount) || (num(rec.Amount) > out ? 'Amount cannot be more than ' + inr(out) : null) ||
      vReq(rec.Mode, 'Recovery mode') || (/salary/i.test(rec.Mode) ? vReq(rec.SalaryMonth, 'Salary month') : null);
    if (err) return toast(err, false);
    const r = await submit(form, 'addRecovery', { record: JSON.stringify(rec) });
    if (!r) return;
    clearDraft(key); toast('Recovery saved'); refreshView(); openAdvance(a.AdvanceID);
  };
}

/* =========================== Employees master =========================== */
async function viewEmployees(el, params = {}) {
  const f = S.f.employees = S.f.employees || { q: '', showInactive: false };
  el.innerHTML = skel(6);
  load('listEmployees', params.refresh ? { refresh: '1' } : {}, r => {
  if (!r || !r.ok) { el.innerHTML = errBox(); return bindRetry(el); }
  S.params = {};
  const all = r.rows;
  S.employees = all.filter(e => e.Active).map(e => ({ id: e.EmpID, name: e.Name, dept: e.Department }));
  const render = () => {
    const q = f.q.toLowerCase();
    const rows = all.filter(e => (f.showInactive || e.Active) && (!q || JSON.stringify(e).toLowerCase().includes(q)));
    $('#empBody', el).innerHTML = `<div class="table-card"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Emp ID</th><th>Name</th><th>Department</th><th>Mobile</th><th>Status</th></tr></thead>
      <tbody>${rows.map(e => `<tr><td>${esc(e.EmpID)}</td><td>${esc(e.Name)}</td><td>${esc(e.Department)}</td>
        <td>${esc(e.Mobile)}</td><td>${badge(e.Active ? 'Active' : 'Inactive')}</td></tr>`).join('') ||
        '<tr><td colspan="5">' + emptyBox('No employees found') + '</td></tr>'}</tbody></table></div></div>
      <div class="pager muted sm">${rows.length} employees</div>`;
  };
  el.innerHTML = `<div class="note">Employees come from the company <b>Employee Master</b> sheet. Add or update employees there; changes show here within 5 minutes, or tap Sync now.</div>
    <div class="toolbar">
      <input class="input search" id="q" placeholder="Search employee…" value="${esc(f.q)}" />
      <label class="check"><input type="checkbox" id="inact" ${f.showInactive ? 'checked' : ''}/> Show inactive</label>
      <span class="spacer"></span>
      <button class="btn btn-ghost" id="exp">Export CSV</button>
      <button class="btn btn-primary btn-auto" id="sync">Sync now</button></div><div id="empBody"></div>`;
  $('#q', el).oninput = e => { f.q = e.target.value; render(); };
  $('#inact', el).onchange = e => { f.showInactive = e.target.checked; render(); };
  $('#sync', el).onclick = () => viewEmployees(el, { refresh: true });
  $('#exp', el).onclick = () => exportCSV('employees', [['EmpID', 'Emp ID'], ['Name', 'Name'], ['Department', 'Department'], ['Mobile', 'Mobile'], ['Active', 'Active']], all);
  render();
  }, el);
}

/* =========================== Settings (Admin) =========================== */
async function viewSettings(el) {
  const f = S.f.settings = S.f.settings || { tab: 'users' };
  el.innerHTML = `<div class="tabs">
      <button class="tab ${f.tab === 'users' ? 'on' : ''}" data-tab="users">Users &amp; PINs</button>
      <button class="tab ${f.tab === 'lists' ? 'on' : ''}" data-tab="lists">Dropdown Lists</button>
      <button class="tab ${f.tab === 'general' ? 'on' : ''}" data-tab="general">General</button>
    </div><div id="sBody">${skel(5)}</div>`;
  $$('[data-tab]', el).forEach(t => t.onclick = () => { f.tab = t.dataset.tab; viewSettings(el); });
  const body = $('#sBody', el);
  if (f.tab === 'users') return settingsUsers(body);
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
    <div class="table-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead>
    <tbody>${r.rows.map((u, i) => `<tr class="click" data-i="${i}"><td>${esc(u.Name)}</td><td>${esc(u.Role)}</td><td>${badge(u.Active ? 'Active' : 'Inactive')}</td></tr>`).join('')}</tbody>
    </table></div></div>
    <div class="note" style="margin-top:14px"><b>Roles:</b> Owner — confirms cash and sees everything ·
      Admin — sees everything, manages settings · HR — takes cash, manages employee advances ·
      Employee — takes cash and records expenses.</div>`;
  $('#add', body).onclick = () => formUser(null, r.roles);
  $$('[data-i]', body).forEach(tr => tr.onclick = () => formUser(r.rows[tr.dataset.i], r.roles));
}

function formUser(u, roles) {
  const isNew = !u, u0 = u || { Name: '', Role: 'Employee', Active: true };
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">${isNew ? 'Add User' : 'Edit User'}</div></div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label class="full">Name<input class="input" name="Name" maxlength="60" value="${esc(u0.Name)}" ${isNew ? '' : 'readonly'} />
        ${isNew ? '<span class="hint">Name cannot be changed later (it is used in the ledger).</span>' : ''}</label>
      <label>PIN<input class="input" name="PIN" inputmode="numeric" maxlength="4" placeholder="${isNew ? '4 digits' : 'Leave blank to keep'}" /></label>
      <label>Role<select class="input" name="Role">${opts(roles || ROLES, u0.Role)}</select></label>
      ${isNew ? '' : `<label class="check full"><input type="checkbox" name="Active" ${u0.Active ? 'checked' : ''}/> Active (can log in)</label>`}
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-auto">Save</button></div>
    </form>`);
  const form = $('form', box);
  form.onsubmit = async e => {
    e.preventDefault();
    const rec = formData(form); rec.isNew = isNew;
    if (isNew) rec.Active = true;
    const err = vReq(rec.Name, 'Name') || (isNew ? vReq(rec.PIN, 'PIN') : null) || (rec.PIN && !/^\d{4}$/.test(rec.PIN) ? 'PIN must be 4 digits' : null);
    if (err) return toast(err, false);
    const r = await submit(form, 'saveUser', { record: JSON.stringify(rec) });
    if (!r) return;
    closeModal(); toast('User saved');
    const b = await call('bootstrap', {}, true);
    if (b && b.ok) S.persons = b.persons;
    refreshView();
  };
}

function settingsLists(body) {
  const labels = { Purpose: 'Purposes', PaymentMode: 'Payment modes', RecoveryMode: 'Recovery modes' };
  const draw = () => {
    body.innerHTML = `<div class="cfg-grid">${Object.keys(labels).map(type => `
      <div class="card"><div class="card-h">${labels[type]}</div><div class="card-b">
        ${S.cfgRows.map((it, i) => it.type !== type ? '' : `<div class="cfg-item ${it.active ? '' : 'off'}"><span>${esc(it.key)}</span>
          <label class="switch"><input type="checkbox" data-i="${i}" ${it.active ? 'checked' : ''}/><i></i></label></div>`).join('')}
        <div class="cfg-add"><input class="input" placeholder="Add new…" maxlength="60" data-new="${type}" /><button class="btn btn-ghost btn-sm" data-add="${type}">Add</button></div>
      </div></div>`).join('')}</div>
      <p class="hint">Items cannot be renamed (old records use the name). Switch an item off to hide it from new entries.</p>
      <div class="m-actions"><button class="btn btn-primary btn-auto" id="saveCfg">Save changes</button></div>`;
    $$('[data-i]', body).forEach(c => c.onchange = () => { S.cfgRows[c.dataset.i].active = c.checked; draw(); });
    $$('[data-add]', body).forEach(b => b.onclick = () => {
      const type = b.dataset.add, inp = $(`[data-new="${type}"]`, body), key = inp.value.trim();
      if (!key) return;
      if (S.cfgRows.some(r => r.type === type && r.key.toLowerCase() === key.toLowerCase())) return toast('Already exists', false);
      S.cfgRows.push({ type, key, value: '', active: true }); draw();
    });
    $$('[data-new]', body).forEach(inp => inp.onkeydown = e => { if (e.key === 'Enter') $(`[data-add="${inp.dataset.new}"]`, body).click(); });
    $('#saveCfg', body).onclick = e => saveCfg(e.target);
  };
  draw();
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
  if (b && b.ok) { S.cfg = b.config; S.settings = b.settings; }
}

/* =========================== Wire up =========================== */
$('#loginBtn').onclick = doLogin;
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

(function init() {
  const sess = store.get('session');
  if (!sess || !sess.token) return showLogin();
  S.token = sess.token; S.me = sess.me;
  const boot = store.get('boot');
  if (boot && boot.me && boot.me.name === sess.me.name) {
    applyStartup(boot); enterApp();                       // open instantly from last session
    call('bootstrap', {}, true).then(r => { if (r && r.ok) { store.set('boot', r); applyStartup(r); } });
  } else startApp();
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
