'use strict';
/* HR Employee Advances + Employees master — module of the Owner Cash Ledger (needs app.js loaded first)
   Kaun dekhe: Settings → General → Role access → "Employee Advances" (default HR) */

(function registerAdvances() {
  const at = NAV.findIndex(n => n.id === 'settings');
  const see = () => !!(S.mods && S.mods.advances && S.mods.advances.see);
  NAV.splice(at, 0,
    { id: 'advances', label: 'Employee Advances', roles: ROLES, render: viewAdvances, show: see },
    { id: 'employees', label: 'Employees', roles: ROLES, render: viewEmployees, show: see });
  TOP.advances = 'Advances'; SHORT.advances = 'Advances';
  TOP.employees = 'Employees'; SHORT.employees = 'Employees';
  ICONS.advances = '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M17 11h5M19.5 8.5v5"/>';
  ICONS.employees = '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 16.5c.6-1.6 2-2.5 3.5-2.5s2.9.9 3.5 2.5M15 10h3M15 14h3"/>';
})();

/* =========================== Employee Advances =========================== */
async function viewAdvances(el) {
  const f = S.f.advances = S.f.advances || { tab: 'emp', page: 1, status: '', empId: '', q: '' };
  el.innerHTML = skel(6);
  load('listAdvances', { page: f.page, status: f.status, empId: f.empId, q: f.q }, r => {
  if (!r || !r.ok) { el.innerHTML = errBox(); return bindRetry(el); }
  const s = r.summary;
  el.innerHTML = `<div class="kpis">
      ${kpi('Total outstanding', inr(s.totalOut), 'to be recovered', { hl: true })}
      ${kpi('Employees with advance', s.empCount, 'outstanding > 0')}
      ${kpi('Recovered this month', inr(s.recMonth), 'salary + cash')}
    </div>
    <p class="hint" style="margin:-6px 0 14px">Click an employee to see the full khata: every advance, every recovery and the balance.</p>
    <div class="tabs"><button class="tab ${f.tab === 'emp' ? 'on' : ''}" data-tab="emp">By Employee</button>
      <button class="tab ${f.tab === 'list' ? 'on' : ''}" data-tab="list">All Advances</button></div>
    <div id="aBody"></div>`;
  $$('[data-tab]', el).forEach(t => t.onclick = () => { f.tab = t.dataset.tab; viewAdvances(el); });
  const body = $('#aBody', el);

  if (f.tab === 'emp') {
    const emps = r.byEmployee.filter(e => !f.q || (e.EmpName + ' ' + e.EmpID).toLowerCase().includes(f.q.toLowerCase()));
    body.innerHTML = `<div class="toolbar">
        <input class="input search" id="q" placeholder="Search employee…" value="${esc(f.q)}" />
        <span class="spacer"></span><button class="btn btn-ghost" id="exp">Export CSV</button></div>
      <div class="table-card"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Employee</th><th class="right">Times taken</th><th class="right">Total taken</th><th class="right">Recovered</th>
        <th class="right">To recover</th><th>Last advance</th><th>Last recovery</th></tr></thead>
      <tbody>${emps.map(e => `<tr class="click" data-emp="${esc(e.EmpID)}">
        <td>${who(e.EmpName, e.EmpID)}</td>
        <td class="right">${e.count}</td><td class="right">${inr(e.total)}</td><td class="right pos">${inr(e.recovered)}</td>
        <td class="right"><b class="${e.outstanding > 0 ? 'acc-t' : 'muted'}">${inr(e.outstanding)}</b></td>
        <td>${esc(e.lastAdvance || '—')}</td><td>${esc(e.lastRecovery || '—')}</td></tr>`).join('') ||
        '<tr><td colspan="7">' + emptyBox('No advances yet') + '</td></tr>'}</tbody></table></div></div>`;
    $('#q', body).oninput = debounce(e => { f.q = e.target.value; viewAdvances(el); }, 250);
    $('#exp', body).onclick = () => exportCSV('advances_by_employee', [['EmpID', 'Emp ID'], ['EmpName', 'Employee'], ['count', 'Times taken'],
      ['total', 'Total taken'], ['recovered', 'Recovered'], ['outstanding', 'To recover'], ['lastAdvance', 'Last advance'], ['lastRecovery', 'Last recovery']], emps);
    $$('[data-emp]', body).forEach(tr => tr.onclick = () => openEmpAdvance(tr.dataset.emp));
    return;
  }

  body.innerHTML = `<div class="toolbar">
      <input class="input search" id="q" placeholder="Search…" value="${esc(f.q)}" />
      <select class="input" id="fEmp"><option value="">All employees</option>${r.byEmployee.map(e => `<option value="${esc(e.EmpID)}" ${e.EmpID === f.empId ? 'selected' : ''}>${esc(e.EmpName)}</option>`).join('')}</select>
      <select class="input" id="fStatus">${opts(['Outstanding', 'Partly Recovered', 'Recovered'], f.status, 'All statuses')}</select>
      <span class="spacer"></span><button class="btn btn-ghost" id="exp">Export CSV</button></div>
    <div class="table-card"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Advance</th><th>Date</th><th>Employee</th><th class="right">Amount</th><th class="right">Recovered</th><th class="right">Outstanding</th><th>Status</th><th>Given by</th></tr></thead>
      <tbody>${r.rows.map(a => `<tr class="click" data-emp="${esc(a.EmpID)}"><td>${esc(a.AdvanceID)}</td><td>${esc(a.Date)}</td><td>${esc(a.EmpName)}</td>
        <td class="right">${inr(a.Amount)}</td><td class="right">${inr(a.Recovered)}</td><td class="right"><b>${inr(a.Outstanding)}</b></td>
        <td>${badge(a.Status)}</td><td>${esc(a.GivenBy)}</td></tr>`).join('') ||
        '<tr><td colspan="8">' + emptyBox('No advances found') + '</td></tr>'}</tbody></table></div></div>${pager(r)}`;
  const reload = () => { f.page = 1; viewAdvances(el); };
  $('#q', body).oninput = debounce(e => { f.q = e.target.value; reload(); });
  $('#fEmp', body).onchange = e => { f.empId = e.target.value; reload(); };
  $('#fStatus', body).onchange = e => { f.status = e.target.value; reload(); };
  $('#exp', body).onclick = async e => {
    const x = await act(e.currentTarget, 'listAdvances', { status: f.status, empId: f.empId, q: f.q, all: '1' });
    if (x) exportCSV('advances', [['AdvanceID', 'Advance'], ['Date', 'Date'], ['EmpID', 'Emp ID'], ['EmpName', 'Employee'], ['Amount', 'Amount'],
      ['Recovered', 'Recovered'], ['Outstanding', 'Outstanding'], ['Status', 'Status'], ['GivenBy', 'Given By'], ['VoucherID', 'Cash Entry']], x.rows);
  };
  $$('[data-emp]', body).forEach(tr => tr.onclick = () => openEmpAdvance(tr.dataset.emp));
  bindPager(body, p => { f.page = p; viewAdvances(el); });
  }, el);
}

/* Employee advance khata: totals + every advance and recovery with running balance */
function openEmpAdvance(empId, pre) {
  const box = openModal(`<div class="m-head"><div><div class="m-title">Loading…</div></div><button class="x" data-close>&times;</button></div>${skel(4)}`, true);
  if (pre) { memoSet('employeeAdvances', { empId }, pre); box._tok = (box._tok || 0) + 1; return renderEmpAdvance(box, pre, empId); }
  load('employeeAdvances', { empId }, r => renderEmpAdvance(box, r, empId), box);
}

function renderEmpAdvance(box, r, empId) {
  if ($('#modal').classList.contains('hidden')) return;
  if (!r || !r.ok) {
    box.innerHTML = `<div class="m-head"><div><div class="m-title">Employee advance</div></div><button class="x" data-close>&times;</button></div>${emptyBox((r && r.message) || 'Could not load')}`;
    return;
  }
  const t = r.totals, e = r.emp, mgr = isAdvMgr();
  const line = x => x.type === 'Advance'
    ? `<tr><td>${esc(x.date)}</td><td><span class="tx tx-adv">Advance given</span><div class="muted sm">${esc(x.ref)} · by ${esc(x.by)} · ${esc(x.note)}</div></td>
         <td class="right">${inr(x.amount)}</td><td class="right"></td><td class="right"><b>${inr(x.balance)}</b></td>${mgr ? '<td></td>' : ''}</tr>`
    : `<tr><td>${esc(x.date)}</td><td><span class="tx tx-rec">Recovered</span><div class="muted sm">${esc(x.mode)}${x.month ? ' · ' + esc(monthName(x.month)) : ''}${x.note ? ' · ' + esc(x.note) : ''} · by ${esc(x.by)}</div></td>
         <td class="right"></td><td class="right pos">${inr(x.amount)}</td><td class="right"><b>${inr(x.balance)}</b></td>
         ${mgr ? `<td class="right"><button class="icon-btn" title="Remove recovery" data-del="${esc(x.key)}">&times;</button></td>` : ''}</tr>`;
  box.innerHTML = `
    <div class="m-head">${avatar(e.EmpName, 'lg')}<div><div class="m-title">${esc(e.EmpName)}</div>
      <div class="muted sm">${esc(e.EmpID)} · Advance khata</div></div>
      ${t.outstanding > 0 ? badge(t.recovered > 0 ? 'Partly Recovered' : 'Outstanding') : badge('Recovered')}<button class="x" data-close>&times;</button></div>
    <div class="stat-row" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><span>Total taken</span><b>${inr(t.taken)}</b><small class="muted sm">${t.times} time${t.times === 1 ? '' : 's'}</small></div>
      <div class="stat"><span>Recovered</span><b class="pos">${inr(t.recovered)}</b><small class="muted sm">${t.recoveries} time${t.recoveries === 1 ? '' : 's'}</small></div>
      <div class="stat hl"><span>To recover</span><b>${inr(t.outstanding)}</b><small class="muted sm">${t.outstanding > 0 ? 'still pending' : 'fully settled'}</small></div>
    </div>
    <div class="progress" style="margin-bottom:6px"><span style="width:${t.taken ? Math.min(100, t.recovered / t.taken * 100).toFixed(1) : 0}%"></span></div>
    <div class="muted sm" style="text-align:right">${t.taken ? Math.round(t.recovered / t.taken * 100) : 0}% recovered</div>
    <div class="m-section"><h4>History</h4>
      <div class="table-card"><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Date</th><th>Details</th><th class="right">Advance</th><th class="right">Recovered</th><th class="right">Balance</th>${mgr ? '<th></th>' : ''}</tr></thead>
        <tbody>${r.entries.map(line).join('')}</tbody>
        <tfoot><tr><td colspan="2">Total</td><td class="right">${inr(t.taken)}</td><td class="right">${inr(t.recovered)}</td><td class="right">${inr(t.outstanding)}</td>${mgr ? '<td></td>' : ''}</tr></tfoot>
      </table></div></div></div>
    <div class="m-actions" style="margin-top:18px">
      <button class="btn btn-ghost" data-exp>Export CSV</button>
      ${mgr && t.outstanding > 0 ? '<button class="btn btn-primary btn-auto" data-add>+ Add Recovery</button>' : ''}
    </div>`;
  $('[data-exp]', box).onclick = () => exportCSV('advance_' + e.EmpName.replace(/\s+/g, '_'),
    [['date', 'Date'], ['type', 'Type'], ['ref', 'Ref'], ['mode', 'Mode'], ['month', 'Salary month'], ['note', 'Details'], ['by', 'By'], ['amount', 'Amount'], ['balance', 'Balance']], r.entries);
  const add = $('[data-add]', box);
  if (add) add.onclick = () => formEmpRecovery(e, t.outstanding);
  $$('[data-del]', box).forEach(b => b.onclick = async () => {
    if (!(await confirmBox('Remove recovery', 'This recovery will be removed and the balance will go up again. Continue?', 'Remove', true))) return;
    const x = await act(b, 'deleteEmpRecovery', { empId, key: b.dataset.del }, 'Recovery removed');
    if (x) { refreshView(); openEmpAdvance(empId, x.statement); }
  });
}

function monthName(ym) {
  const [y, m] = String(ym).split('-');
  return y && m ? new Date(+y, +m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : ym;
}

function formEmpRecovery(emp, out) {
  const key = 'rec_' + emp.EmpID, d = getDraft(key), ref = d.ClientRef || uid();
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">Add Recovery</div><div class="muted sm">${esc(emp.EmpName)} · To recover ${inr(out)}</div></div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label>Date<input class="input" type="date" name="Date" max="${today()}" value="${esc(d.Date || today())}" /></label>
      <label>Amount (₹)<input class="input" type="number" name="Amount" inputmode="decimal" min="1" max="${out}" step="0.01" value="${esc(d.Amount || '')}" />
        <span class="hint"><a href="#" data-full>Recover full ${inr(out)}</a></span></label>
      <label>Recovery mode<select class="input" name="Mode">${opts(S.cfg.RecoveryMode, d.Mode || S.cfg.RecoveryMode[0], 'Select mode')}</select></label>
      <label id="smWrap">Salary month<input class="input" type="month" name="SalaryMonth" value="${esc(d.SalaryMonth || today().slice(0, 7))}" /></label>
      <label class="full">Remarks<textarea class="input" name="Remarks" rows="2" maxlength="300">${esc(d.Remarks || '')}</textarea></label>
      <p class="hint full">Adjusted against the oldest advance first.</p>
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-back>Back</button><button type="submit" class="btn btn-primary btn-auto">Save Recovery</button></div>
    </form>`);
  const form = $('form', box), mode = $('[name=Mode]', form);
  const syncMonth = () => $('#smWrap', box).classList.toggle('hidden', !/salary/i.test(mode.value));
  mode.onchange = syncMonth; syncMonth();
  $('[data-full]', box).onclick = ev => { ev.preventDefault(); $('[name=Amount]', form).value = out; };
  $('[data-back]', box).onclick = () => openEmpAdvance(emp.EmpID);
  trackDraft(form, key, ref);
  form.onsubmit = async ev => {
    ev.preventDefault();
    const rec = formData(form); rec.EmpID = emp.EmpID; rec.ClientRef = ref;
    if (!/salary/i.test(rec.Mode)) rec.SalaryMonth = '';
    const err = vDate(rec.Date) || vMoney(rec.Amount) || (num(rec.Amount) > out ? 'Amount cannot be more than ' + inr(out) : null) ||
      vReq(rec.Mode, 'Recovery mode') || (/salary/i.test(rec.Mode) ? vReq(rec.SalaryMonth, 'Salary month') : null);
    if (err) return toast(err, false);
    const r = await submit(form, 'addEmpRecovery', { record: JSON.stringify(rec) });
    if (!r) return;
    clearDraft(key); toast('Recovery saved'); refreshView(); openEmpAdvance(emp.EmpID, r.statement);
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
