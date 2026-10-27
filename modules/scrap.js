'use strict';
/* Scrap Khata — module of the Owner Cash Ledger (needs app.js loaded first)
   Khata: Pichhla Baaki + Bana − Mila = Ab Baaki
   Bana = scrap value (qty × rate of every line) · Mila = paisa party se mila */

(function registerScrap() {
  const at = NAV.findIndex(n => n.id === 'expenses');
  NAV.splice(at + 1, 0, { id: 'scrap', label: 'Scrap Khata', roles: ROLES, render: viewScrap,
    show: () => !!(S.mods && S.mods.scrap && S.mods.scrap.see) });
  TOP.scrap = 'Scrap'; SHORT.scrap = 'Scrap';
  ICONS.scrap = '<path d="M4 7h16l-1.5 12.5a2 2 0 0 1-2 1.5h-9a2 2 0 0 1-2-1.5z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/><path d="M9.5 12l1.5 4M14.5 12L13 16"/>';
})();

const SK_UNIT = { kg: 'Kg', pcs: 'Pcs' };
const skLineText = l => `${l.material} ${+l.qty} ${SK_UNIT[l.unit] || l.unit} @${inr(l.rate)}`;
function skBaakiState(b) {
  return b > 0 ? { label: 'Abhi Baaki', sub: 'Party ko dena hai', cls: 'due', amt: b }
    : b < 0 ? { label: 'Advance', sub: 'Party ka paisa humare paas jama hai', cls: 'ok', amt: -b }
    : { label: 'Abhi Baaki', sub: 'Sab clear ✓', cls: 'ok', amt: 0 };
}

async function viewScrap(el) {
  const f = S.f.scrap = S.f.scrap || { tab: '', party: '', page: 1, from: '', to: '', month: today().slice(0, 7) };
  el.innerHTML = `<div class="dh">${skel(2)}</div>${skel(5)}`;
  load('scrapBoot', { party: f.party }, r => {
    if (!r || !r.ok) { el.innerHTML = errBox(); return bindRetry(el); }
    const a = r.access;
    f.party = r.party;
    S.sk = r;
    const tabs = [a.enter && ['entry', 'Nayi Entry'], ['khata', 'Khata'], ['summary', 'Summary'], a.admin && ['materials', 'Materials']].filter(Boolean);
    if (!tabs.some(t => t[0] === f.tab)) f.tab = tabs[0][0];
    const st = skBaakiState(r.baaki);
    const pend = r.pendingCash || [], pendSum = pend.reduce((s, o) => s + num(o.Mila), 0);
    const parties = r.parties.filter(p => p.active !== false);

    el.innerHTML = `
      <div class="dh sk-hero ${st.cls}">
        <div>
          <div class="dh-k">Scrap Khata${parties.length > 1
            ? ` · <select class="input sk-party" aria-label="Party">${opts(parties.map(p => p.name), f.party)}</select>`
            : (f.party ? ' · ' + esc(f.party) : '')}</div>
          <div class="kpi-v">${inr(st.amt)}</div>
          <div class="dh-s"><b>${st.label}</b> · ${st.sub}</div>
        </div>
        ${pend.length ? `<div class="sk-pend"><span class="cnt" aria-hidden="true"></span>
          ${a.owner ? `<b>${inr(pendSum)}</b> scrap cash aapke paas aana baaki` : `<b>${inr(pendSum)}</b> scrap cash ${a.admin ? 'logon' : 'aap'} ke paas · Owner ko dena hai`}</div>` : ''}
      </div>
      ${a.owner && pend.length ? skPendingList(pend) : ''}
      <div class="tabs">${tabs.map(t => `<button class="tab ${f.tab === t[0] ? 'on' : ''}" data-tab="${t[0]}">${t[1]}</button>`).join('')}</div>
      <div id="skBody"></div>`;

    const sel = $('.sk-party', el);
    if (sel) sel.onchange = e => { f.party = e.target.value; f.page = 1; viewScrap(el); };
    $$('[data-tab]', el).forEach(t => t.onclick = () => { f.tab = t.dataset.tab; viewScrap(el); });
    $$('[data-skok]', el).forEach(b => b.onclick = async () => {
      if (await act(b, 'scrapCashConfirm', { id: b.dataset.skok }, 'Scrap cash received ✓')) { viewScrap(el); refreshBadge(); }
    });
    animateNums(el, 'scrap');

    const body = $('#skBody', el);
    if (f.tab === 'entry') skEntry(body, r, el);
    else if (f.tab === 'khata') skKhata(body, f);
    else if (f.tab === 'summary') skSummary(body, f);
    else skMaterials(body, r, el);
  }, el);
}

function skPendingList(pend) {
  return `<div class="card sk-cash"><div class="card-h">Scrap ka cash — Owner tak pahuncha?<span class="muted">Confirm tabhi karo jab paisa haath mein aa jaye</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Kiske paas</th><th>Entry</th><th class="right">Amount</th><th></th></tr></thead>
    <tbody>${pend.map(o => `<tr><td>${esc(o.Date)}</td><td>${who(o.Kisne)}</td><td class="muted sm">${esc(o.EntryID)}</td>
      <td class="right"><b>${inr(o.Mila)}</b></td><td class="right"><button class="btn btn-ok btn-sm" data-skok="${esc(o.EntryID)}">Mil gaya</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
}

/* ---------------- Nayi Entry ---------------- */
function skEntry(body, r, root) {
  const f = S.f.scrap, mats = r.materials.filter(m => m.active !== false);
  let ref = uid();
  if (!mats.length) {
    body.innerHTML = emptyBox(r.access.admin ? 'Pehle "Materials" tab mein scrap materials aur rate add karo.' : 'Admin ne abhi materials add nahi kiye hain.');
    return;
  }
  body.innerHTML = `<form class="card sk-form" novalidate><div class="card-b">
      <div class="form">
        <label>Date<input class="input" type="date" name="Date" max="${today()}" value="${today()}" /></label>
        <label>Kisne<input class="input" value="${esc(S.me.name)}" readonly /></label>
      </div>
      <div class="sk-sec"><h4>Scrap <span class="hint">(agar liya ho)</span></h4>
        <div class="sk-head" aria-hidden="true"><span>Material</span><span>Qty</span><span>Rate</span><span class="right">Price</span><span></span></div>
        <div class="sk-lines"></div>
        <button type="button" class="btn btn-ghost btn-sm" data-addline>+ Aur material</button>
      </div>
      <div class="sk-sec form">
        <label>Paisa Mila (₹)<input class="input" type="number" name="Mila" inputmode="decimal" min="0" step="0.01" placeholder="0" /></label>
        <label>Kaise<select class="input" name="Kaise">${opts(S.cfg.PaymentMode, '', 'Chuno')}</select></label>
        <label class="full">Note <span class="muted sm">(optional)</span><input class="input" name="Note" maxlength="300" placeholder="Kuch likhna ho to" /></label>
      </div>
      <div class="sk-total"><span>Bana <b data-bana>₹0</b></span><span>Mila <b data-mila>₹0</b></span></div>
      <p class="sk-after" data-after></p>
      <div class="m-actions"><button type="submit" class="btn btn-primary btn-auto">Save</button></div>
    </div></form>`;
  const form = $('form', body), lines = $('.sk-lines', body);
  const matOpts = mats.map(m => `<option value="${esc(m.name)}">${esc(m.name)} (${SK_UNIT[m.unit] || m.unit})</option>`).join('');

  const addLine = () => {
    const row = document.createElement('div');
    row.className = 'sk-line';
    row.innerHTML = `<select class="input" data-m aria-label="Material"><option value="">Material chuno</option>${matOpts}</select>
      <input class="input" data-q type="number" inputmode="decimal" min="0" step="0.01" placeholder="Qty" aria-label="Quantity" />
      <input class="input" data-r type="number" inputmode="decimal" min="0" step="0.01" placeholder="Rate" aria-label="Rate" />
      <b class="right" data-a>₹0</b>
      <button type="button" class="icon-btn" aria-label="Line hatao" data-del>&times;</button>`;
    $('[data-m]', row).onchange = e => {
      const m = mats.find(x => x.name === e.target.value);
      if (m) { $('[data-r]', row).value = m.rate || ''; $('[data-q]', row).placeholder = SK_UNIT[m.unit] || 'Qty'; }
      update();
    };
    $('[data-del]', row).onclick = () => { row.remove(); if (!lines.children.length) addLine(); update(); };
    lines.appendChild(row);
    return row;
  };

  const read = () => {
    const out = []; let err = null;
    $$('.sk-line', lines).forEach(row => {
      const m = $('[data-m]', row).value, q = $('[data-q]', row).value, rt = $('[data-r]', row).value;
      $('[data-a]', row).textContent = inr(num(q) * num(rt));
      if (!m && !q && !rt) return;
      if (!m || !(num(q) > 0) || !(num(rt) > 0)) { err = err || 'Har line mein material, qty aur rate teeno bharo'; return; }
      out.push({ material: m, qty: num(q), rate: num(rt) });
    });
    return { out, err };
  };

  const update = () => {
    const bana = read().out.reduce((s, l) => s + Math.round(l.qty * l.rate * 100) / 100, 0);
    const mila = num($('[name=Mila]', form).value);
    $('[data-bana]', form).textContent = inr(bana);
    $('[data-mila]', form).textContent = inr(mila);
    const p = $('[data-after]', form);
    if (!bana && !mila) { p.textContent = ''; p.className = 'sk-after'; return; }
    const after = Math.round((num(r.baaki) + bana - mila) * 100) / 100;
    p.textContent = after > 0 ? 'Save ke baad baaki: ' + inr(after) : after < 0 ? 'Save ke baad advance: ' + inr(-after) : 'Save ke baad sab clear ✓';
    p.className = 'sk-after ' + (after > 0 ? 'due' : 'ok');
  };

  addLine();
  $('[data-addline]', body).onclick = () => $('[data-m]', addLine()).focus();
  form.addEventListener('input', update);

  form.onsubmit = async e => {
    e.preventDefault();
    const { out, err } = read();
    if (err) return toast(err, false);
    const rec = formData(form);
    const mila = num(rec.Mila);
    const e2 = vDate(rec.Date) || (rec.Mila !== '' && mila < 0 ? 'Paisa minus mein nahi ho sakta' : null) ||
      (!out.length && !(mila > 0) ? 'Scrap ya paisa, kam se kam ek bharo' : null) ||
      (mila > 0 && !rec.Kaise ? 'Paisa kaise mila, ye chuno' : null);
    if (e2) return toast(e2, false);
    const res = await submit(form, 'scrapSave', { record: JSON.stringify({
      Date: rec.Date, Party: S.f.scrap.party, lines: out, Mila: mila, Kaise: mila > 0 ? rec.Kaise : '', Note: rec.Note, ClientRef: ref }) });
    if (!res) return;
    ref = uid();
    toast('Save ho gaya ✓' + (mila > 0 && /cash/i.test(rec.Kaise) && !isOwner() ? ' · Cash Owner ko dena hai' : ''));
    refreshBadge();
    viewScrap(root);
  };
}

/* ---------------- Khata ---------------- */
function skKhata(body, f) {
  body.innerHTML = `<div class="toolbar">
      <input class="input" type="date" id="skFrom" value="${esc(f.from)}" aria-label="From" />
      <input class="input" type="date" id="skTo" value="${esc(f.to)}" aria-label="To" />
      <span class="spacer"></span><button class="btn btn-ghost" id="skExp">Export CSV</button><button class="btn btn-ghost" id="skPrn">Print</button>
    </div><div id="skTbl">${skel(5)}</div>`;
  $('#skFrom', body).onchange = e => { f.from = e.target.value; f.page = 1; skKhata(body, f); };
  $('#skTo', body).onchange = e => { f.to = e.target.value; f.page = 1; skKhata(body, f); };
  $('#skPrn', body).onclick = () => window.print();
  const p = { party: f.party, from: f.from, to: f.to };
  $('#skExp', body).onclick = async e => {
    const x = await act(e.currentTarget, 'scrapKhata', Object.assign({ all: '1' }, p));
    if (x) exportCSV('scrap_khata', [['Date', 'Date'], ['ScrapText', 'Scrap'], ['Bana', 'Bana'], ['Mila', 'Mila'], ['Baaki', 'Baaki'],
      ['Kaise', 'Kaise'], ['Kisne', 'Kisne'], ['Note', 'Note'], ['CashStatus', 'Cash']],
      x.rows.map(o => Object.assign({ ScrapText: o.lines.map(skLineText).join('; ') }, o)));
  };
  const host = $('#skTbl', body);
  load('scrapKhata', Object.assign({ page: f.page }, p), r => {
    if (!r || !r.ok) { host.innerHTML = errBox(); return bindRetry(host); }
    const admin = S.sk && S.sk.access.admin;
    const st = o => o.CashStatus === 'With person' ? '<span class="badge b-pending">Owner ko dena hai</span>'
      : o.CashStatus === 'Given to Owner' ? '<span class="badge b-done">Owner ko mila</span>' : '';
    host.innerHTML = `<div class="table-card"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Date</th><th>Scrap</th><th class="right">Bana</th><th class="right">Mila</th><th class="right">Baaki</th><th>Kaise · Kisne</th>${admin ? '<th></th>' : ''}</tr></thead>
      <tbody>${f.from ? `<tr><td>${esc(f.from)}</td><td colspan="3"><b>Pichhla Baaki</b></td><td class="right"><b>${inr(r.opening)}</b></td><td></td>${admin ? '<td></td>' : ''}</tr>` : ''}
      ${r.rows.map(o => `<tr><td>${esc(o.Date)}</td>
        <td class="wrap">${o.lines.length ? o.lines.map(l => `<div>${esc(skLineText(l))} = <b>${inr(l.amount)}</b></div>`).join('') : '<span class="muted">Sirf paisa</span>'}
          ${o.Note ? `<div class="muted sm">${esc(o.Note)}</div>` : ''}</td>
        <td class="right">${num(o.Bana) ? inr(o.Bana) : ''}</td><td class="right pos">${num(o.Mila) ? inr(o.Mila) : ''}</td>
        <td class="right"><b class="${o.Baaki < 0 ? 'pos' : ''}">${o.Baaki < 0 ? inr(-o.Baaki) + ' adv' : inr(o.Baaki)}</b></td>
        <td>${esc(o.Kaise || '—')} · ${esc(o.Kisne)} ${st(o)}</td>
        ${admin ? `<td class="right">${o.CashStatus === 'Given to Owner' ? '' : `<button class="icon-btn" title="Entry hatao" data-skdel="${esc(o.EntryID)}">&times;</button>`}</td>` : ''}</tr>`).join('') ||
        `<tr><td colspan="7">${emptyBox('Is time mein koi entry nahi')}</td></tr>`}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="right">${inr(r.totBana)}</td><td class="right">${inr(r.totMila)}</td>
        <td class="right">${r.closing < 0 ? inr(-r.closing) + ' adv' : inr(r.closing)}</td><td colspan="${admin ? 2 : 1}"></td></tr></tfoot>
    </table></div></div>${pager(r)}`;
    bindPager(host, pg => { f.page = pg; skKhata(body, f); });
    $$('[data-skdel]', host).forEach(b => b.onclick = async () => {
      const reason = await askText('Entry hatao', 'Kyun hata rahe ho? (reason)', true, 'Hatao');
      if (reason === null) return;
      if (await act(b, 'scrapCancel', { id: b.dataset.skdel, reason }, 'Entry hata di')) refreshView();
    });
  }, host);
}

/* ---------------- Summary ---------------- */
function skSummary(body, f) {
  body.innerHTML = `<div class="toolbar"><input class="input" type="month" id="skMonth" value="${esc(f.month)}" aria-label="Month" /></div><div id="skSum">${skel(4)}</div>`;
  $('#skMonth', body).onchange = e => { f.month = e.target.value; skSummary(body, f); };
  const host = $('#skSum', body);
  load('scrapSummary', { month: f.month, party: f.party }, r => {
    if (!r || !r.ok) { host.innerHTML = errBox(); return bindRetry(host); }
    host.innerHTML = `<div class="kstrip sk-strip">
        <div class="ks"><div class="ks-l">Scrap gaya (Bana)</div><div class="kpi-v">${inr(r.bana)}</div><div class="ks-s">${r.entries} entries</div></div>
        <div class="ks"><div class="ks-l">Paisa mila</div><div class="kpi-v">${inr(r.mila)}</div><div class="ks-s">${esc(monthName(r.month))}</div></div>
        <div class="ks"><div class="ks-l">Is mahine ka farak</div><div class="kpi-v">${inr(Math.abs(r.bana - r.mila))}</div>
          <div class="ks-s">${r.bana >= r.mila ? 'Baaki bada' : 'Purana baaki ghata'}</div></div>
      </div>
      <div class="table-card"><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Material</th><th class="right">Qty</th><th class="right">Avg rate</th><th class="right">Amount</th></tr></thead>
        <tbody>${r.rows.map(o => `<tr><td>${esc(o.material)}</td><td class="right">${+o.qty} ${esc(SK_UNIT[o.unit] || o.unit)}</td>
          <td class="right">${inr(o.avgRate)}</td><td class="right"><b>${inr(o.amount)}</b></td></tr>`).join('') ||
          `<tr><td colspan="4">${emptyBox('Is mahine koi scrap nahi gaya')}</td></tr>`}</tbody>
      </table></div></div>`;
  }, host);
}

/* ---------------- Materials + Parties (Admin) ---------------- */
function skMaterials(body, r, root) {
  const mats = r.materials.map(m => Object.assign({}, m));
  const parties = r.parties.map(p => Object.assign({}, p));
  const draw = () => {
    body.innerHTML = `<div class="grid2 sk-admin">
      <div class="card"><div class="card-h">Materials <span class="muted">Rate yahan se form mein apne aap aata hai</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Material</th><th>Unit</th><th class="right">Rate (₹)</th><th>Active</th></tr></thead>
        <tbody>${mats.map((m, i) => `<tr><td><input class="input" data-mn="${i}" value="${esc(m.name)}" maxlength="60" aria-label="Material name" /></td>
          <td><select class="input" data-mu="${i}" aria-label="Unit">${r.units.map(u => `<option value="${u}" ${u === m.unit ? 'selected' : ''}>${SK_UNIT[u]}</option>`).join('')}</select></td>
          <td><input class="input right" data-mr="${i}" type="number" min="0" step="0.01" value="${esc(m.rate)}" aria-label="Rate" /></td>
          <td><label class="switch"><input type="checkbox" data-ma="${i}" ${m.active !== false ? 'checked' : ''} aria-label="Active" /><i></i></label></td></tr>`).join('') ||
          `<tr><td colspan="4">${emptyBox('Abhi koi material nahi')}</td></tr>`}</tbody></table></div>
        <div class="card-b m-actions"><button class="btn btn-ghost" data-addm>+ Material</button><button class="btn btn-primary btn-auto" data-savem>Save materials</button></div></div>
      <div class="card"><div class="card-h">Parties</div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Party</th><th>Phone</th><th>Active</th></tr></thead>
        <tbody>${parties.map((p, i) => `<tr><td><input class="input" data-pn="${i}" value="${esc(p.name)}" maxlength="60" aria-label="Party name" /></td>
          <td><input class="input" data-pp="${i}" value="${esc(p.phone)}" maxlength="20" inputmode="tel" aria-label="Phone" /></td>
          <td><label class="switch"><input type="checkbox" data-pa="${i}" ${p.active !== false ? 'checked' : ''} aria-label="Active" /><i></i></label></td></tr>`).join('')}</tbody></table></div>
        <div class="card-b m-actions"><button class="btn btn-ghost" data-addp>+ Party</button><button class="btn btn-primary btn-auto" data-savep>Save parties</button></div></div>
    </div>
    <p class="hint">Naam badalne se purani entries nahi badalti. Material band (switch off) karoge to wo naye form mein nahi dikhega.</p>`;
    const sync = () => {
      mats.forEach((m, i) => { m.name = $(`[data-mn="${i}"]`, body).value.trim(); m.unit = $(`[data-mu="${i}"]`, body).value;
        m.rate = num($(`[data-mr="${i}"]`, body).value); m.active = $(`[data-ma="${i}"]`, body).checked; });
      parties.forEach((p, i) => { p.name = $(`[data-pn="${i}"]`, body).value.trim(); p.phone = $(`[data-pp="${i}"]`, body).value.trim();
        p.active = $(`[data-pa="${i}"]`, body).checked; });
    };
    $('[data-addm]', body).onclick = () => { sync(); mats.push({ name: '', unit: 'kg', rate: '', active: true }); draw(); $(`[data-mn="${mats.length - 1}"]`, body).focus(); };
    $('[data-addp]', body).onclick = () => { sync(); parties.push({ name: '', phone: '', active: true }); draw(); $(`[data-pn="${parties.length - 1}"]`, body).focus(); };
    $('[data-savem]', body).onclick = async e => {
      sync();
      const list = mats.filter(m => m.name);
      if (await act(e.currentTarget, 'scrapSaveMaterials', { items: JSON.stringify(list) }, 'Materials saved')) viewScrap(root);
    };
    $('[data-savep]', body).onclick = async e => {
      sync();
      const list = parties.filter(p => p.name);
      if (await act(e.currentTarget, 'scrapSaveParties', { items: JSON.stringify(list) }, 'Parties saved')) viewScrap(root);
    };
  };
  draw();
}
