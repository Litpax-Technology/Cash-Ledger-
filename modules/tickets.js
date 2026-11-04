'use strict';
/* Field Tickets — module of the Owner Cash Ledger (needs app.js loaded first)
   Technician site pe jata hai → ticket → kharch (Travel / Food / Parts / Other) usi cash in hand se.
   Open → (help: Pending Assignment → Assigned) → Done → Closed (final submit, edit band)
   Kaun dekhe: Settings → General → Role access → "Field Tickets" */

(function registerTickets() {
  const at = NAV.findIndex(n => n.id === 'mycash');
  NAV.splice(at, 0, { id: 'tickets', label: 'Field Tickets', roles: ROLES, render: viewTickets,
    show: () => !!(S.mods && S.mods.tickets && S.mods.tickets.see) });
  TOP.tickets = 'Tickets'; SHORT.tickets = 'Tickets';
  ICONS.tickets = '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 5v12" stroke-dasharray="2 2"/>';
})();

const TK_STATUSES = ['Open', 'Pending Assignment', 'Assigned', 'Done', 'Closed'];
const TK_BADGE = { 'Open': 'b-open', 'Pending Assignment': 'b-pending', 'Assigned': 'b-open', 'Done': 'b-done', 'Closed': 'b-closed' };
const tkBadge = s => `<span class="badge ${TK_BADGE[s] || 'b-closed'}">${esc(s)}</span>`;
const tkAcc = () => (S.mods && S.mods.tickets) || {};

async function viewTickets(el) {
  const f = S.f.tickets = S.f.tickets || { status: '', tech: '', q: '', page: 1 };
  const a = tkAcc();
  el.innerHTML = `<div class="toolbar">
      <input class="input search" id="tkQ" placeholder="Search ticket, customer, location, serial…" value="${esc(f.q)}" />
      <span id="tkTech"></span>
      <span class="spacer"></span>
      ${a.create ? '<button class="btn btn-primary btn-auto" id="tkNew">+ Naya Ticket</button>' : ''}
    </div><div id="tkBody">${skel(5)}</div>`;
  $('#tkQ', el).oninput = debounce(e => { f.q = e.target.value.trim(); f.page = 1; viewTickets(el); }, 400);
  if ($('#tkNew', el)) $('#tkNew', el).onclick = () => formTicket();

  load('ticketList', { status: f.status, tech: f.tech, q: f.q, page: f.page }, r => {
    const body = $('#tkBody', el);
    if (!r || !r.ok) { body.innerHTML = errBox(); return bindRetry(body); }
    S.tk = r;
    const c = r.counts || {};
    if (r.access.manage && r.technicians.length) {
      $('#tkTech', el).innerHTML = `<select class="input" id="tkTechSel">${opts(r.technicians.map(t => t.name), f.tech, 'All technicians')}</select>`;
      $('#tkTechSel', el).onchange = e => { f.tech = e.target.value; f.page = 1; viewTickets(el); };
    }
    body.innerHTML = `
      <div class="chips tk-chips">${[''].concat(TK_STATUSES).map(s => `<button class="chip ${f.status === s ? 'on' : ''}" data-st="${esc(s)}">
        ${esc(s || 'All')} <b>${s ? (c[s] || 0) : (c.all || 0)}</b></button>`).join('')}</div>
      ${r.access.manage && c['Pending Assignment'] ? `<div class="note tk-note"><b>${c['Pending Assignment']}</b> ticket mein company technician assign karna baaki hai.
        <a href="#" data-st-go="Pending Assignment">Dekho →</a></div>` : ''}
      <div class="table-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ticket</th><th>Date</th><th>Customer</th><th>Location</th>
        <th>Battery</th><th>Technician</th><th>Status</th><th class="right">Kharch</th></tr></thead>
      <tbody>${r.rows.map(t => `<tr class="click" data-tk="${esc(t.TicketID)}">
        <td><b>${esc(t.TicketID)}</b>${t.Priority && t.Priority !== 'Normal' ? ` <span class="badge b-rejected">${esc(t.Priority)}</span>` : ''}</td>
        <td>${esc(t.Date)}</td><td>${esc(t.CustomerName)}<div class="muted sm">${esc(t.ProblemType)}</div></td>
        <td class="wrap">${esc(t.Location)}</td><td>${esc(t.BatteryModel || '—')}<div class="muted sm">${esc(t.SerialNumber || '')}</div></td>
        <td>${esc(t.Technician)}${t.AssignedTo ? `<div class="muted sm">→ ${esc(t.AssignedTo)}</div>` : ''}</td>
        <td>${tkBadge(t.Status)}</td><td class="right"><b>${inr(t.Expense)}</b></td></tr>`).join('') ||
        `<tr><td colspan="8">${emptyBox(a.create ? 'Koi ticket nahi. Site pe jaane se pehle "+ Naya Ticket" banao.' : 'Koi ticket nahi')}</td></tr>`}</tbody>
      </table></div></div>${pager(r)}`;
    $$('[data-st]', body).forEach(b => b.onclick = () => { f.status = b.dataset.st; f.page = 1; viewTickets(el); });
    $$('[data-st-go]', body).forEach(b => b.onclick = e => { e.preventDefault(); f.status = b.dataset.stGo; f.page = 1; viewTickets(el); });
    $$('[data-tk]', body).forEach(tr => tr.onclick = () => openTicket(tr.dataset.tk));
    bindPager(body, p => { f.page = p; viewTickets(el); });
  }, $('#tkBody', el));
}

/* ---- naya ticket ---- */
function formTicket() {
  const key = 'tk_new', d = getDraft(key), ref = d.ClientRef || uid();
  const probs = (S.tk && S.tk.problems) || ['Other'], pri = (S.tk && S.tk.priorities) || ['Normal'];
  const box = openModal(`
    <div class="m-head"><div><div class="m-title">Naya Ticket</div><div class="muted sm">${esc(S.me.name)} · ${esc(today())}</div></div><button class="x" data-close>&times;</button></div>
    <form class="form" novalidate>
      <label>Customer name<input class="input" name="CustomerName" maxlength="80" value="${esc(d.CustomerName || '')}" /></label>
      <label>Customer mobile<input class="input" name="CustomerMobile" inputmode="numeric" maxlength="10" value="${esc(d.CustomerMobile || '')}" placeholder="10 digit (optional)" /></label>
      <label class="full">Location<input class="input" name="Location" maxlength="120" value="${esc(d.Location || '')}" placeholder="Village / city / site" /></label>
      <label>Battery model<input class="input" name="BatteryModel" maxlength="60" value="${esc(d.BatteryModel || '')}" /></label>
      <label>Serial number<input class="input" name="SerialNumber" maxlength="60" value="${esc(d.SerialNumber || '')}" /></label>
      <label>Problem type<select class="input" name="ProblemType">${opts(probs, d.ProblemType, 'Select problem')}</select></label>
      <label>Priority<select class="input" name="Priority">${opts(pri, d.Priority || pri[0])}</select></label>
      <label class="full">Problem details<textarea class="input" name="ProblemDetails" rows="2" maxlength="500">${esc(d.ProblemDetails || '')}</textarea></label>
      <label class="check full"><input type="checkbox" name="HelpNeeded" value="Yes" ${d.HelpNeeded === 'Yes' ? 'checked' : ''}/> Company technician ki help chahiye</label>
      <p class="hint full">Help chahiye tick kiya toh ticket "Pending Assignment" mein jayega — Owner / Admin technician assign karenge.</p>
      <div class="m-actions full"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-auto">Ticket banao</button></div>
    </form>`);
  const form = $('form', box);
  trackDraft(form, key, ref);
  form.onsubmit = async e => {
    e.preventDefault();
    const rec = formData(form); rec.ClientRef = ref;
    rec.HelpNeeded = $('[name=HelpNeeded]', form).checked ? 'Yes' : 'No';
    const err = vReq(rec.CustomerName, 'Customer name') || vReq(rec.Location, 'Location') || vReq(rec.ProblemType, 'Problem type') ||
      (rec.CustomerMobile && !/^\d{10}$/.test(rec.CustomerMobile) ? 'Customer mobile 10 digit ka hona chahiye' : null);
    if (err) return toast(err, false);
    const r = await submit(form, 'ticketSave', { record: JSON.stringify(rec) });
    if (!r) return;
    clearDraft(key); toast('Ticket ' + r.id + ' ban gaya'); refreshView(); openTicket(r.id);
  };
}

/* ---- ticket detail ---- */
async function openTicket(id, pre) {
  const box = openModal(`<div class="m-head"><div><div class="m-title">${esc(id)}</div></div><button class="x" data-close>&times;</button></div>${skel(4)}`, true);
  const r = pre || await call('ticketDetail', { id });
  if (!document.body.contains(box)) return;
  if (!r || !r.ok) { box.innerHTML = `<div class="m-head"><div class="m-title">${esc(id)}</div><button class="x" data-close>&times;</button></div>${errBox()}`; return; }
  const t = r.ticket, a = tkAcc(), mine = t.Technician === S.me.name || t.AssignedTo === S.me.name;
  const closed = t.Status === 'Closed', canWork = mine && !closed;
  const photos = String(t.PartsPhotos || '').split('|').filter(Boolean);
  const kv = (k, v) => v ? `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>` : '';

  const actions = [];
  if (a.manage && !closed && t.Status !== 'Done') actions.push(`<button class="btn btn-ghost" data-a="assign">${t.AssignedTo ? 'Re-assign' : 'Assign technician'}</button>`);
  if (canWork && a.create) actions.push('<button class="btn btn-ghost" data-a="exp">+ Kharch</button>');
  if ((mine || a.manage) && (t.Status === 'Open' || t.Status === 'Assigned')) actions.push('<button class="btn btn-ok" data-a="done">Kaam ho gaya</button>');
  if ((mine || a.manage) && t.Status === 'Done') actions.push('<button class="btn btn-primary btn-auto" data-a="close">Final Submit</button>');

  box.innerHTML = `
    <div class="m-head"><div><div class="m-title">${esc(t.TicketID)} · ${esc(t.CustomerName)}</div>
      <div class="muted sm">${esc(t.Date)} · ${esc(t.Technician)}${t.AssignedTo ? ' → ' + esc(t.AssignedTo) : ''}${t.ResponseTime ? ' · Response ' + esc(t.ResponseTime) : ''}</div></div>
      ${tkBadge(t.Status)}<button class="x" data-close>&times;</button></div>
    <div class="tk-kv">${kv('Mobile', t.CustomerMobile)}${kv('Location', t.Location)}${kv('Battery model', t.BatteryModel)}${kv('Serial no', t.SerialNumber)}
      ${kv('Problem', t.ProblemType)}${kv('Priority', t.Priority)}${kv('Help needed', t.HelpNeeded)}</div>
    ${t.ProblemDetails ? `<p class="tk-det">${esc(t.ProblemDetails)}</p>` : ''}

    <div class="m-section"><h4>Kharch · ${inr(r.total)}</h4>
      ${Object.keys(r.bySub).length ? `<div class="chips tk-sub">${Object.keys(r.bySub).map(k => `<span class="chip">${esc(k)} <b>${inr(r.bySub[k])}</b></span>`).join('')}</div>` : ''}
      ${r.expenses.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Kya</th><th>Paid to</th><th class="right">Amount</th><th>Bill</th></tr></thead>
        <tbody>${r.expenses.map(e => `<tr><td>${esc(e.Date)}</td><td>${esc(e.SubPurpose || e.Purpose)}<div class="muted sm">${esc(e.Description || '')}</div></td>
          <td>${esc(e.PaidTo)}</td><td class="right">${inr(e.Amount)}</td><td>${billLink(e.BillURL)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="muted sm">Abhi koi kharch nahi${canWork ? ' — "+ Kharch" se daalo (cash in hand se katega)' : ''}.</div>`}
    </div>

    <div class="m-section"><h4>Parts &amp; remarks</h4>
      <form class="form" id="tkUpd" novalidate>
        <label class="full">Parts changed<textarea class="input" name="PartsChanged" rows="2" maxlength="300" ${canWork ? '' : 'readonly'}>${esc(t.PartsChanged || '')}</textarea></label>
        <label class="full">Remarks<textarea class="input" name="Remarks" rows="2" maxlength="300" ${canWork ? '' : 'readonly'}>${esc(t.Remarks || '')}</textarea></label>
        <div class="full tk-photos">${photos.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener" class="chip">Photo ${i + 1}</a>`).join('')}
          ${canWork ? '<label class="chip tk-add-ph"><input type="file" accept="image/*" hidden /><span>+ Parts photo</span></label>' : ''}</div>
        ${canWork ? '<div class="m-actions full"><button type="submit" class="btn btn-ghost">Save parts / remarks</button></div>' : ''}
      </form>
    </div>
    ${actions.length ? `<div class="m-actions">${actions.join('')}</div>` : ''}`;

  const again = () => { refreshView(); openTicket(id); };
  const A = k => $(`[data-a="${k}"]`, box);
  const upd = $('#tkUpd', box);
  if (canWork) {
    upd.onsubmit = async e => {
      e.preventDefault();
      const rec = formData(upd); rec.TicketID = t.TicketID; rec.PartsPhotos = photos.join('|'); rec.ClientRef = uid();
      if (await submit(upd, 'ticketSave', { record: JSON.stringify(rec) })) { toast('Saved'); again(); }
    };
    const ph = $('.tk-add-ph input', box);
    if (ph) ph.onchange = async () => {
      const file = ph.files[0]; if (!file) return;
      const lbl = $('.tk-add-ph span', box); lbl.textContent = 'Uploading…';
      try {
        const url = await uploadBill(file);
        const rec = formData(upd); rec.TicketID = t.TicketID; rec.PartsPhotos = photos.concat(url).join('|'); rec.ClientRef = uid();
        const x = await call('ticketSave', { record: JSON.stringify(rec) });
        if (x && x.ok) { toast('Photo added'); again(); } else lbl.textContent = '+ Parts photo';
      } catch (er) { lbl.textContent = '+ Parts photo'; toast('Upload failed: ' + er.message, false); }
    };
  }
  if (A('exp')) A('exp').onclick = () => {
    if (!S.openList || !S.openList.length) {
      // My Cash ka data abhi load nahi hua ho — ek baar le aao
      return call('listVouchers', { page: 1, status: '', mine: '1' }, true).then(m => {
        if (m && m.ok) { S.myCash = m.summary; S.openList = m.openList || []; }
        if (!S.openList || !S.openList.length) return toast('Pehle "Cash Received" add karo aur Owner se confirm karwao', false);
        tkExpense(t, id);
      });
    }
    tkExpense(t, id);
  };
  if (A('assign')) A('assign').onclick = () => {
    const list = (r.technicians || []).map(x => x.name);
    if (!list.length) return toast('Koi technician user nahi — Settings → Users mein Technician role do', false);
    const d = dialog(`<div class="m-head"><div class="m-title">Assign technician</div></div>
      <div class="form"><label class="full">Technician<select class="input" data-to>${opts(list, t.AssignedTo, 'Select technician')}</select></label></div>
      <div class="m-actions"><button class="btn btn-ghost" data-no>Cancel</button><button class="btn btn-primary btn-auto" data-yes>Assign</button></div>`);
    $('[data-no]', d).onclick = closeDialog;
    $('[data-yes]', d).onclick = async e => {
      const to = $('[data-to]', d).value; if (!to) return toast('Select a technician', false);
      if (await act(e.currentTarget, 'ticketAssign', { id, to }, 'Assigned to ' + to)) { closeDialog(); again(); }
    };
  };
  if (A('done')) A('done').onclick = async e => {
    const btn = e.currentTarget;
    if (!(await confirmBox('Kaam ho gaya?', 'Ticket "Done" ho jayega aur response time save ho jayega.', 'Done'))) return;
    if (await act(btn, 'ticketDone', { id }, 'Ticket done ✓')) again();
  };
  if (A('close')) A('close').onclick = async e => {
    const btn = e.currentTarget;
    if (!(await confirmBox('Final Submit', 'Iske baad ticket edit nahi hoga aur naya kharch nahi judega. Pakka?', 'Final Submit'))) return;
    if (await act(btn, 'ticketClose', { id }, 'Ticket closed')) again();
  };
}

/* kharch: normal Cash Ledger expense, purpose "Field Service", TicketID ke saath */
async function tkExpense(t, id) {
  const purpose = (S.tk && S.tk.access && S.tk.access.purpose) || 'Field Service';
  if (!S.cfg.Purpose.includes(purpose)) {           // "Field Service" abhi bana ho toh list refresh
    const b = await call('bootstrap', {}, true);
    if (b && b.ok) { S.cfg = b.config; S.settings = b.settings; }
  }
  formExpense(null, { ticket: t, purpose, onSaved: () => { refreshView(); openTicket(id); } });
}
