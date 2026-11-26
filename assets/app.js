import { db, DEMO, computeView, effectiveCarrier } from './db.js';
import { t, getLang, setLang, locale, LANGS } from './i18n.js';
import { buildPdfHtml } from './pdf-export.js';

// ---------------------------------------------------------------------
// Constantes et utilitaires
// ---------------------------------------------------------------------
export const STATUS_KEYS = ['non_traitee', 'en_attente', 'en_preparation', 'emballee', 'envoyee', 'nevyzdvihnute', 'livree', 'annulee'];
const statusLabel = s => t('st.' + s);
const OPEN_STATUSES = ['non_traitee', 'en_attente', 'en_preparation', 'emballee', 'nevyzdvihnute'];
const CARRIER_KEYS = ['', 'packeta', 'dpd', 'posta', 'ceska_posta', 'main_propre', 'autre'];
const CARRIER_NAMES = { '': '—', packeta: 'Packeta', dpd: 'DPD', posta: 'Slovenská pošta', ceska_posta: 'Česká pošta' };
// transporteurs ajoutés sur la page Doprava (réglage « carriers » : [{ key, name }])
const customCarriers = () => (state.settings.carriers || []).filter(c => c && c.key);
const carrierKeys = () => [...CARRIER_KEYS.slice(0, -1), ...customCarriers().map(c => c.key).filter(k => !CARRIER_KEYS.includes(k)), 'autre'];
const carrierLabel = k => customCarriers().find(c => c.key === k)?.name ?? CARRIER_NAMES[k] ?? t('carrier.' + k);
const carrierSlug = name => String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
const CUSTOMER_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company', 'street', 'postal_code', 'city', 'country', 'social'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => (Math.round((+v || 0) * 100) / 100).toLocaleString('sk-SK', { maximumFractionDigits: 2 });
const fmtDate = (v, time = false) => v ? new Date(v).toLocaleString(locale(), time
  ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
  : { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const shortShipping = s => /dpd/i.test(s || '') ? 'DPD' : /packeta/i.test(s || '') ? 'Packeta' : (s || '—');
// transporteur choisi dans la fiche, sinon celui du choix fait dans le formulaire
const shipLabel = o => { const k = o.carrier || guessCarrier(o.shipping_method); return k ? carrierLabel(k) : shortShipping(o.shipping_method); };
// transporteur déduit du texte du mode de livraison (« Osobný odber » → remise en main propre)
const guessCarrier = s => /osobn|odber|odovzd|vyzdvihnutie na mieste/i.test(s || '') ? 'main_propre'
  : /dpd/i.test(s || '') ? 'dpd' : /packeta|z-box|zasielkov/i.test(s || '') ? 'packeta' : '';
const statusBadge = s => `<span class="badge st-${esc(s)}">${esc(statusLabel(s))}</span>`;
const statusOptions = sel => STATUS_KEYS.map(k => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(statusLabel(k))}</option>`).join('');
const orderLabel = o => o.order_no ? `N°${o.order_no}` : t('order_label_none', { id: o.id });
// Clients slovaques et tchèques : modèles « _sk » proposés en premier
const prefersSk = o => /slov|česk|cesk|czech|^sk$|^cz$|^cr$/i.test((o.country || '').trim()) || /\.(sk|cz)$/i.test(o.email || '');

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3500);
}

async function guard(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { console.error(e); toast(e.message || String(e), 'error'); throw e; }
}

const EMPTY_FILTER = { status: 'open', q: '', shipping: '', paid: '', from: '', to: '', country: '', pay: '' };
const state = { me: null, settings: {}, products: [], rates: [], cod: [], categories: [], orders: [], filter: { ...EMPTY_FILTER }, selected: new Set() };

const ctx = () => ({ products: state.products, rates: state.rates, cod: state.cod, shipping: state.settings.shipping });
const kg = g => (Math.round((+g || 0) / 10) / 100).toLocaleString('sk-SK');
const activeProducts = () => state.products.filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name));
const productByName = name => state.products.find(p => p.name.toLowerCase() === String(name || '').toLowerCase());

// ---------------------------------------------------------------------
// Mails : remplacement des variables {…}
// ---------------------------------------------------------------------
export function trackingUrl(o, settings) {
  const tpl = (settings.tracking_urls || {})[o.carrier || guessCarrier(o.shipping_method)];
  return tpl && o.tracking_number ? tpl.replace('{tracking}', encodeURIComponent(o.tracking_number)) : '';
}

export function renderTemplate(text, o, items, settings) {
  const lines = items.map(i => `- ${i.product}${i.size ? ' (' + i.size + ')' : ''} × ${i.qty}` +
    (i.unit_eur != null && i.unit_eur !== '' ? ` · ${money(i.qty * i.unit_eur)} €` : '')).join('\n');
  const missing = items.filter(i => i.missing).map(i => `- ${i.product}${i.size ? ' (' + i.size + ')' : ''} × ${i.qty}`).join('\n');
  const vars = {
    order_no: o.order_no ?? '', first_name: o.first_name ?? '', last_name: o.last_name ?? '',
    customer_name: o.customer_name ?? '', email: o.email ?? '', items: lines, missing_items: missing,
    subtotal_eur: money(o.subtotal_eur), discount_eur: money(o.discount_eur_effective),
    shipping_eur: money(o.shipping_eur_effective), shipping_czk: money(o.shipping_czk_effective),
    grand_total_eur: money(o.grand_total_eur), grand_total_czk: money(o.grand_total_czk), weight_kg: kg(o.weight_g),
    total_eur: money(o.total_eur), total_czk: money(o.total_czk),
    shipping_method: o.shipping_method ?? '', pickup_point: o.pickup_point ?? '',
    tracking_number: o.tracking_number ?? '', tracking_url: trackingUrl(o, settings),
    address: [o.street, `${o.postal_code ?? ''} ${o.city ?? ''}`.trim(), o.country].filter(Boolean).join(', '),
    iban: settings?.bank?.iban ?? '', bic: settings?.bank?.bic ?? ''
  };
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => k in vars ? vars[k] : m);
}

// ---------------------------------------------------------------------
// Langue et barre de navigation
// ---------------------------------------------------------------------
function renderChrome() {
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $('#lang').innerHTML = LANGS.map(l => `<button type="button" data-lang="${l}" class="${l === getLang() ? 'on' : ''}" aria-pressed="${l === getLang()}">${l.toUpperCase()}</button>`).join('');
  $$('#lang button').forEach(b => b.onclick = () => {
    setLang(b.dataset.lang);
    renderChrome();
    if (state.me) { refreshSyncInfo(); route(); } else renderLogin();
  });
}

// ---------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------
let loginMessage = '';
function renderLogin(message) {
  if (message !== undefined) loginMessage = message;
  $('#nav-links').hidden = true;
  $('#app').innerHTML = `
    <section class="login card">
      <img src="assets/logo.png" alt="ADACTA" class="logo">
      <h1>${t('login.title')}</h1>
      <p class="muted">${t('login.sub')}</p>
      ${loginMessage ? `<p class="notice">${esc(loginMessage)}</p>` : ''}
      <form id="login-form">
        <label>${t('login.email')}<input id="login-email" type="email" name="email" required autocomplete="email" placeholder="${t('login.placeholder')}"></label>
        <button class="primary" type="submit">${t('login.send')}</button>
      </form>
      ${window.ADACTA_CONFIG?.googleLogin ? `<div class="or">${t('login.or')}</div><button id="google-login" class="ghost wide">${t('login.google')}</button>` : ''}
    </section>`;
  $('#login-form').onsubmit = async e => {
    e.preventDefault();
    const email = new FormData(e.target).get('email');
    await guard(() => db.signInEmail(email));
    $('#app .login').innerHTML = `<h1>${t('login.check')}</h1><p>${t('login.sent', { email: esc(email) })}</p>
      <p class="muted">${t('login.nothing')}</p>`;
  };
  $('#google-login')?.addEventListener('click', () => guard(() => db.signInGoogle()));
}

async function boot() {
  renderChrome();
  if (DEMO) $('#demo-banner').hidden = false;
  const session = await db.session();
  if (!session) return renderLogin('');
  const me = await db.me(session.user.email).catch(() => null);
  if (!me) {
    await db.signOut();
    return renderLogin(t('login.denied', { email: session.user.email }));
  }
  state.me = me;
  $('#me').textContent = me.email;
  $('#nav-links').hidden = false;
  $('#logout').onclick = () => db.signOut().then(() => location.reload());
  $('#sync').onclick = runSync;
  state.settings = await db.settings();
  [state.products, state.rates, state.categories, state.cod] = await Promise.all([db.listProducts(), db.listRates(), db.listCategories(), db.listCod()]);
  window.addEventListener('hashchange', route);
  route();
  refreshSyncInfo();
}

// ---------------------------------------------------------------------
// Synchronisation (exécutée par le script Google, au plus 1 min après)
// ---------------------------------------------------------------------
async function refreshSyncInfo() {
  const s = await db.lastSync().catch(() => null);
  const el = $('#sync-info');
  if (!s) { el.textContent = ''; return; }
  if (!s.done_at) { el.textContent = t('sync.requested'); return; }
  const r = s.result || {};
  el.textContent = t(r.error ? 'sync.last_error' : 'sync.last', { date: fmtDate(s.done_at, true) });
  el.title = r.error || t('sync.detail', { rows: r.rows ?? '?', created: r.created ?? 0, numbers: r.order_numbers ?? 0 });
}

async function runSync() {
  const btn = $('#sync');
  btn.disabled = true;
  await guard(() => db.requestSync(state.me.email));
  $('#sync-info').textContent = t('sync.requested_long');
  const started = Date.now();
  const poll = async () => {
    const s = await db.lastSync();
    if (s?.done_at) {
      btn.disabled = false;
      const r = s.result || {};
      if (r.error) toast(t('sync.error', { error: r.error }), 'error');
      else toast(t('sync.done', { created: r.created ?? 0, numbers: r.order_numbers ?? 0 }));
      refreshSyncInfo();
      route();
    } else if (Date.now() - started < 180000) setTimeout(poll, 4000);
    else { btn.disabled = false; toast(t('sync.noanswer'), 'error'); }
  };
  setTimeout(poll, 3000);
}

// ---------------------------------------------------------------------
// Routage
// ---------------------------------------------------------------------
function route() {
  $$('dialog').forEach(d => { d.close(); d.remove(); });
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  $$('#nav a[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === (page || 'commandes')));
  if (page === 'commande' && arg) return pageOrder(+arg);
  if (page === 'nouvelle') return pageNewOrder();
  if (page === 'preparation') return pagePreparation();
  if (page === 'reglages') return pageSettings();
  if (page === 'katalog') return pageCatalog();
  if (page === 'doprava') return pageTransport();
  return pageOrders();
}

// ---------------------------------------------------------------------
// Liste des commandes
// ---------------------------------------------------------------------
const isCod = o => o.cod_effective ?? (o.cod ?? ['SK', 'CZ'].includes(o.country_code));
const dayOf = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Bratislava' }); };

function filtered() {
  const f = state.filter, q = f.q.trim().toLowerCase();
  return state.orders.filter(o =>
    (!f.from || dayOf(o.submitted_at) >= f.from) && (!f.to || dayOf(o.submitted_at) <= f.to) &&
    (!f.country || (f.country === 'other' ? !['SK', 'CZ'].includes(o.country_code) : o.country_code === f.country)) &&
    (!f.pay || String(isCod(o)) === f.pay) &&
    (f.status === 'all' || (f.status === 'open' ? OPEN_STATUSES.includes(o.status)
      : f.status === 'missing' ? o.missing_count > 0 && o.status !== 'annulee' : o.status === f.status)) &&
    (!f.shipping || shipLabel(o) === f.shipping) &&
    (f.paid === '' || String(!!o.paid) === f.paid) &&
    (!q || [o.order_no, o.customer_name, o.email, o.city, o.country, o.items_summary, o.tracking_number, o.customer_notes]
      .some(v => String(v ?? '').toLowerCase().includes(q))));
}

async function pageOrders() {
  $('#app').innerHTML = `<p class="muted">${t('loading')}</p>`;
  state.orders = await guard(() => db.listOrders());
  const counts = Object.fromEntries(STATUS_KEYS.map(k => [k, 0]));
  state.orders.forEach(o => counts[o.status]++);
  const open = OPEN_STATUSES.reduce((a, k) => a + counts[k], 0);
  const tile = (key, label, n) => `<button class="tile ${state.filter.status === key ? 'on' : ''} st-${key}" data-status="${key}">
      <span class="n">${n}</span><span class="l">${esc(label)}</span></button>`;
  const templates = state.settings.email_templates || {};
  $('#app').innerHTML = `
    <div class="tiles">
      ${tile('open', t('list.open'), open)}
      ${tile('missing', t('miss.tile'), state.orders.filter(o => o.missing_count > 0 && o.status !== 'annulee').length)}
      ${STATUS_KEYS.map(k => tile(k, statusLabel(k), counts[k])).join('')}
      ${tile('all', t('list.all'), state.orders.length)}
    </div>
    <div class="toolbar">
      <input id="q" type="search" placeholder="${t('list.search')}" value="${esc(state.filter.q)}">
      <a class="button ghost" href="#/nouvelle">${t('list.manual')}</a>
      <button id="export-pdf" class="ghost" title="${t('pdf.btn_help')}">${t('pdf.btn')}</button>
      <button id="export" class="ghost">${t('list.export')}</button>
    </div>
    <div class="toolbar filters">
      <label class="f-date">${t('flt.from')} <input id="f-from" type="date" value="${esc(state.filter.from)}"></label>
      <label class="f-date">${t('flt.to')} <input id="f-to" type="date" value="${esc(state.filter.to)}"></label>
      <select id="f-status" aria-label="${t('col.status')}">
        <option value="open">${t('list.open')}</option><option value="all">${t('flt.all_status')}</option>
        <option value="missing">${t('miss.tile')}</option>${statusOptions('')}</select>
      <select id="f-country" aria-label="${t('col.country')}"><option value="">${t('flt.all_countries')}</option>
        <option value="SK">SK</option><option value="CZ">CZ</option><option value="other">${t('flt.other_countries')}</option></select>
      <select id="f-shipping" aria-label="${t('col.shipping')}"><option value="">${t('list.all_shipping')}</option>${[...new Set(['Packeta', 'DPD', ...state.orders.map(shipLabel)])].filter(x => x && x !== '—').map(x => `<option>${esc(x)}</option>`).join('')}</select>
      <select id="f-pay" aria-label="${t('pay.method')}"><option value="">${t('flt.all_pay')}</option>
        <option value="true">${t('pay.cod')}</option><option value="false">${t('pay.prepaid')}</option></select>
      <select id="f-paid" aria-label="${t('col.paid')}"><option value="">${t('list.paid_any')}</option><option value="true">${t('list.paid_yes')}</option><option value="false">${t('list.paid_no')}</option></select>
      <button id="f-reset" class="link" ${Object.keys(EMPTY_FILTER).every(k => state.filter[k] === EMPTY_FILTER[k]) ? 'hidden' : ''}>${t('flt.reset')}</button>
    </div>
    <div id="bulk" class="bulk" hidden>
      <span id="bulk-n"></span>
      <select id="bulk-status"><option value="">${t('list.bulk_status')}</option>${statusOptions('')}</select>
      <button id="bulk-paid" class="ghost">${t('list.bulk_paid')}</button>
      <select id="bulk-mail"><option value="">${t('list.bulk_mail')}</option>${Object.entries(templates).map(([k, tp]) => `<option value="${esc(k)}">${esc(tp.label || k)}</option>`).join('')}</select>
      <button id="bulk-pdf" class="ghost">${t('pdf.btn_sel')}</button>
      <button id="bulk-clear" class="link">${t('list.bulk_clear')}</button>
    </div>
    <div class="table-wrap"><table class="orders">
      <thead><tr><th><input type="checkbox" id="check-all" aria-label="${t('list.select_all')}"></th><th>${t('col.no')}</th><th>${t('col.date')}</th><th>${t('col.customer')}</th>
        <th>${t('col.country')}</th><th>${t('col.shipping')}</th><th>${t('col.items')}</th><th class="num">${t('col.total')}</th><th>${t('col.paid')}</th><th>${t('col.status')}</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
    <p id="count" class="muted"></p>`;
  for (const k of ['shipping', 'paid', 'status', 'country', 'pay']) $('#f-' + k).value = state.filter[k];
  const setF = (k, v) => { state.filter[k] = v; state.selected.clear(); pageOrders(); };
  for (const k of ['from', 'to', 'status', 'country', 'shipping', 'pay', 'paid']) $('#f-' + k).onchange = e => setF(k, e.target.value);
  $('#f-reset').onclick = () => { state.filter = { ...EMPTY_FILTER }; state.selected.clear(); pageOrders(); };
  $$('.tile').forEach(b => b.onclick = () => { state.filter.status = b.dataset.status; state.selected.clear(); pageOrders(); });
  $('#q').oninput = e => { state.filter.q = e.target.value; drawRows(); };
  $('#export').onclick = exportCsv;
  $('#export-pdf').onclick = () => exportPdf(filtered().map(o => o.id));
  $('#bulk-pdf').onclick = () => exportPdf([...state.selected]);
  $('#check-all').onchange = e => { filtered().forEach(o => e.target.checked ? state.selected.add(o.id) : state.selected.delete(o.id)); drawRows(); };
  $('#bulk-clear').onclick = () => { state.selected.clear(); drawRows(); };
  $('#bulk-status').onchange = async e => {
    const st = e.target.value; if (!st) return;
    const ids = [...state.selected];
    await guard(() => db.updateOrders(ids, { status: st }), t('list.status_done', { n: ids.length, status: statusLabel(st) }));
    state.selected.clear(); pageOrders();
  };
  $('#bulk-paid').onclick = async () => {
    const ids = [...state.selected];
    await guard(() => db.updateOrders(ids, { paid: true }), t('list.paid_done', { n: ids.length }));
    state.selected.clear(); pageOrders();
  };
  $('#bulk-mail').onchange = e => { const k = e.target.value; e.target.value = ''; if (k) bulkMail(k); };
  drawRows();
}

function drawRows() {
  const list = filtered();
  $('#rows').innerHTML = list.map(o => `
    <tr data-id="${o.id}" class="${state.selected.has(o.id) ? 'sel' : ''}">
      <td><input type="checkbox" class="pick" ${state.selected.has(o.id) ? 'checked' : ''} aria-label="${t('list.select')}"></td>
      <td class="no"><a href="#/commande/${o.id}">${o.order_no ?? `<span class="warn">${t('no_number')}</span>`}</a></td>
      <td>${fmtDate(o.submitted_at)}</td>
      <td><a href="#/commande/${o.id}">${esc(o.customer_name || o.email)}</a>${o.customer_notes ? ` <span class="note-dot" title="${esc(o.customer_notes)}">✎</span>` : ''}</td>
      <td>${esc(o.country)}</td>
      <td>${esc(shipLabel(o))}${o.carrier && shortShipping(o.shipping_method) !== shipLabel(o) ? `<div class="small muted" title="${esc(o.shipping_method)}">${t('list.form_choice', { v: esc(shortShipping(o.shipping_method)) })}</div>` : ''}${o.tracking_number ? `<div class="small mono">${esc(o.tracking_number)}</div>` : ''}</td>
      <td class="items">${o.missing_count ? `<span class="missing-tag">⚠ ${t('miss.badge', { n: o.missing_count })}</span> ` : ''}${esc(o.items_summary)}</td>
      <td class="num">${money(o.total_eur)} €${+o.shipping_eur_effective ? `<div class="small muted">${t('ship.plus', { amount: money(o.shipping_eur_effective) })}</div>` : ''}</td>
      <td class="pay-cell"><button class="pay-toggle ${o.paid ? 'on' : ''}" aria-pressed="${!!o.paid}"
          title="${t(o.paid ? 'pay.unmark' : 'pay.mark')}" aria-label="${t(o.paid ? 'pay.unmark' : 'pay.mark')}">${o.paid ? '✓' : ''}</button>
        <span class="pay-how ${isCod(o) ? 'cod' : 'pre'}">${t((o.carrier || guessCarrier(o.shipping_method)) === 'main_propre' && isCod(o) ? 'pay.pickup' : isCod(o) ? 'pay.cod' : 'pay.prepaid')}</span></td>
      <td><select class="row-status st-${o.status}" aria-label="${t('col.status')}">${statusOptions(o.status)}</select></td>
    </tr>`).join('') || `<tr><td colspan="10" class="empty">${t('list.empty')}</td></tr>`;
  const tot = list.reduce((a, o) => a + (+o.total_eur || 0), 0);
  const items = list.reduce((a, o) => a + (+o.items_count || 0), 0);
  $('#count').textContent = t('list.count', { orders: list.length, items, total: money(tot) });
  $('#bulk').hidden = state.selected.size === 0;
  $('#bulk-n').textContent = t('list.selected', { n: state.selected.size });
  $$('#rows tr[data-id]').forEach(tr => {
    const id = +tr.dataset.id;
    $('.pick', tr).onchange = e => { e.target.checked ? state.selected.add(id) : state.selected.delete(id); drawRows(); };
    $('.pay-toggle', tr).onclick = async () => {
      const o = state.orders.find(o => o.id === id), paid = !o.paid;
      await guard(() => db.updateOrders([id], { paid }), t(paid ? 'pay.marked' : 'pay.unmarked', { no: o.order_no ?? '' }));
      o.paid = paid; drawRows();
    };
    $('.row-status', tr).onchange = async e => {
      const st = e.target.value;
      await guard(() => db.updateOrders([id], { status: st }), t('list.row_status_done', { status: statusLabel(st) }));
      const o = state.orders.find(o => o.id === id); o.status = st;
      e.target.className = `row-status st-${st}`;
    };
  });
}

const payLabel = o => t((o.carrier || guessCarrier(o.shipping_method)) === 'main_propre' && isCod(o) ? 'pay.pickup' : isCod(o) ? 'pay.cod' : 'pay.prepaid');

// Export PDF : s'ouvre dans un nouvel onglet, prêt à « Enregistrer au format PDF »
async function exportPdf(ids) {
  if (!ids.length) return toast(t('pdf.none'), 'error');
  const w = window.open('', '_blank');
  if (!w) return toast(t('pdf.popup'), 'error');
  w.document.write(`<p style="font:14px system-ui;padding:20px">${esc(t('pdf.loading'))}</p>`);
  try {
    const [orders, items] = await Promise.all([db.ordersFull(ids), db.listItems(ids)]);
    const html = buildPdfHtml(orders, items, { t, fmtDate, shipLabel, payLabel, statusLabel });
    w.document.open(); w.document.write(html); w.document.close();
  } catch (e) { w.close(); toast(e.message, 'error'); }
}

function exportCsv() {
  const cols = ['order_no', 'submitted_at', 'customer_name', 'email', 'country', 'city', 'shipping_method', 'pickup_point',
                'items_summary', 'items_count', 'subtotal_eur', 'discount_eur_effective', 'total_eur', 'total_czk', 'weight_g', 'shipping_eur_effective', 'shipping_czk_effective',
                'grand_total_eur', 'grand_total_czk', 'paid', 'status',
                'carrier', 'tracking_number', 'customer_notes', 'internal_notes'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(';'), ...filtered().map(o => cols.map(c => q(c === 'status' ? statusLabel(o.status) : o[c])).join(';'))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `adacta-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

async function bulkMail(key) {
  const tpl = state.settings.email_templates[key];
  const ids = [...state.selected];
  const orders = state.orders.filter(o => ids.includes(o.id));
  const missing = orders.filter(o => !o.email);
  const noTracking = /\{tracking_(number|url)\}/.test(tpl.body) ? orders.filter(o => !o.tracking_number) : [];
  const noShipping = /\{(shipping_eur|shipping_czk|grand_total_eur|grand_total_czk)\}/.test(tpl.body) ? orders.filter(o => o.shipping_unknown) : [];
  const ok = await confirmDialog(t('bulk.confirm', { label: tpl.label || key, n: orders.length - missing.length }) +
    (noTracking.length ? '\n\n' + t('bulk.no_tracking', { n: noTracking.length, list: noTracking.map(orderLabel).join(', ') }) : '') +
    (noShipping.length ? '\n\n' + t('bulk.no_shipping', { n: noShipping.length, list: noShipping.map(orderLabel).join(', ') }) : '') +
    (missing.length ? '\n\n' + t('bulk.no_email', { n: missing.length }) : ''));
  if (!ok) return;
  const all = await db.listItems(ids);
  const rows = orders.filter(o => o.email).map(o => {
    const its = all.filter(i => i.order_id === o.id);
    return { order_id: o.id, kind: key, to_email: o.email,
             subject: renderTemplate(tpl.subject, o, its, state.settings), body_text: renderTemplate(tpl.body, o, its, state.settings) };
  });
  await guard(() => db.queueEmails(rows), t('bulk.queued', { n: rows.length }));
}

function confirmDialog(text) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.innerHTML = `<p style="white-space:pre-line">${esc(text)}</p><div class="actions"><button class="ghost" value="no">${t('dlg.cancel')}</button><button class="primary" value="yes">${t('dlg.confirm')}</button></div>`;
    document.body.append(d);
    $$('button', d).forEach(b => b.onclick = () => { d.close(); d.remove(); resolve(b.value === 'yes'); });
    d.showModal();
  });
}

// ---------------------------------------------------------------------
// Fiche commande
// ---------------------------------------------------------------------
function defaultTemplate(o, templates) {
  const base = o.missing_count > 0 ? 'missing' : o.status === 'emballee' || o.tracking_number ? 'expedition' : 'confirmation';
  const pick = [prefersSk(o) ? base + '_sk' : base, base, base + '_sk'].find(k => templates[k]);
  return pick || '';
}

async function pageOrder(id) {
  $('#app').innerHTML = `<p class="muted">${t('loading')}</p>`;
  const { order: o, items, history, emails } = await guard(() => db.getOrder(id));
  const editItems = items.map(i => ({ ...i }));
  const removed = [];
  const templates = state.settings.email_templates || {};
  const tUrl = trackingUrl(o, state.settings);
  const mailSt = s => t('mail.st.' + s);

  $('#app').innerHTML = `
    <a href="#/commandes" class="back">${t('order.back')}</a>
    <header class="order-head">
      <div>
        <h1>${t('order.title')} ${o.order_no ? 'N°' + o.order_no : `<span class="warn">${t('no_number')}</span>`} ${statusBadge(o.status)} ${o.paid ? `<span class="badge paid-b">${t('order.paid')}</span>` : ''} ${o.missing_count ? `<span class="badge missing-b">⚠ ${t('miss.badge', { n: o.missing_count })}</span>` : ''}</h1>
        <p class="muted">${t('order.placed', { date: fmtDate(o.submitted_at, true) })} · ${esc(o.email || '')}</p>
      </div>
      <div class="head-actions">
        <button class="ghost print-btn" onclick="window.print()">${t('order.print')}</button>
      </div>
    </header>

    <div class="grid">
      <section class="card">
        <h2>${t('order.tracking')}</h2>
        <form id="f-track" class="form-grid">
          <label>${t('order.status')}<select name="status">${statusOptions(o.status)}</select></label>
          <label class="check"><input type="checkbox" name="paid" ${o.paid ? 'checked' : ''}> ${t('order.payment')}</label>
          <label>${t('order.number')}<input name="order_no" type="number" value="${esc(o.order_no ?? '')}"></label>
          <label>${t('order.carrier')}<select name="carrier">${carrierKeys().map(k => `<option value="${k}" ${k === (o.carrier ?? guessCarrier(o.shipping_method)) ? 'selected' : ''}>${esc(carrierLabel(k))}</option>`).join('')}</select></label>
          <label class="span2">${t('order.tracking_no')}<input name="tracking_number" value="${esc(o.tracking_number ?? '')}" placeholder="${t('order.tracking_ph')}"></label>
          ${tUrl ? `<p class="span2 small"><a href="${esc(tUrl)}" target="_blank" rel="noopener">${t('order.open_tracking')}</a></p>` : ''}
          <label class="span2">${t('order.internal')}<textarea name="internal_notes" rows="3" placeholder="${t('order.internal_ph')}">${esc(o.internal_notes ?? '')}</textarea></label>
          <div class="span2"><button class="primary">${t('save')}</button></div>
        </form>
      </section>

      <section class="card">
        <h2>${t('order.delivery')}</h2>
        <form id="f-ship" class="form-grid">
          <label class="span2">${t('order.method')}<input name="shipping_method" value="${esc(o.shipping_method ?? '')}"></label>
          <label class="span2">${t('order.pickup')}<textarea name="pickup_point" rows="2">${esc(o.pickup_point ?? '')}</textarea></label>
          ${o.customer_notes ? `<div class="span2 client-note"><b>${t('order.note')}</b> ${esc(o.customer_notes)}</div>` : ''}
          <div class="span2"><button class="ghost">${t('save')}</button></div>
        </form>
        <h2>${t('order.customer')}</h2>
        <form id="f-customer" class="form-grid">
          ${CUSTOMER_FIELDS.map(k => `<label>${t('f.' + k)}<input name="${k}" value="${esc(o[k] ?? '')}"></label>`).join('')}
          <div class="span2"><button class="ghost">${t('save')}</button></div>
        </form>
      </section>
    </div>

    <section class="card">
      <h2>${t('items.title')}</h2>
      <div class="table-wrap"><table class="items-edit">
        <thead><tr><th>${t('items.prepared')}</th><th>${t('miss.flag')}</th><th>${t('items.product')}</th><th>${t('items.size')}</th><th class="num">${t('items.qty')}</th><th class="num">${t('items.price_eur')}</th><th class="num">${t('items.price_czk')}</th><th></th></tr></thead>
        <tbody id="items"></tbody>
      </table></div>
      <div class="row-actions"><button id="add-item" class="ghost">${t('items.add')}</button></div>
      <div class="totals">
        <div><span>${t('items.subtotal')}</span><b id="t-sub"></b></div>
        <div><span>${t('items.discount')}</span>
          <span class="inline-inputs"><input id="d-eur" type="number" step="0.5" value="${esc(o.discount_eur ?? '')}"> €
          <input id="d-czk" type="number" step="10" value="${esc(o.discount_czk ?? '')}"> Kč</span></div>
        <div><span>${t('items.total')}</span><b id="t-total"></b></div>
        <p class="small muted">${t('items.discount_help')}</p>
        <div><span>${t('ship.weight')}</span><span id="t-weight"></span></div>
        <div><span>${t('cod.label')}</span>
          <select id="s-cod" aria-label="${t('cod.label')}">
            <option value="" ${o.cod == null ? 'selected' : ''}>${t('cod.auto')}</option>
            <option value="1" ${o.cod === true ? 'selected' : ''}>${t('cod.yes')}</option>
            <option value="0" ${o.cod === false ? 'selected' : ''}>${t('cod.no')}</option></select></div>
        <div><span>${t('ship.cost')}</span>
          <span class="inline-inputs"><input id="s-eur" type="number" step="0.1" value="${esc(o.shipping_eur ?? '')}" aria-label="${t('ship.cost')} €"> €
          <input id="s-czk" type="number" step="5" value="${esc(o.shipping_czk ?? '')}" aria-label="${t('ship.cost')} Kč"> Kč</span></div>
        <p class="small muted" id="t-ship-info"></p>
        <div class="grand"><span>${t('ship.grand')}</span><b id="t-grand"></b></div>
        <p class="small muted">${t('ship.help')}</p>
      </div>
      <button id="save-items" class="primary">${t('items.save')}</button>
      ${o.missing_count ? `<p class="small muted">${t('miss.mail_hint')}</p>` : ''}
    </section>

    <section class="card">
      <h2>${t('mail.title')}</h2>
      ${o.email ? `
      <div class="form-grid">
        <label>${t('mail.template')}<select id="tpl"><option value="">${t('mail.free')}</option>${Object.entries(templates).map(([k, tp]) => `<option value="${esc(k)}">${esc(tp.label || k)}</option>`).join('')}</select></label>
        <label>${t('mail.to')}<input id="m-to" value="${esc(o.email)}"></label>
        <label class="span2">${t('mail.subject')}<input id="m-subject"></label>
        <label class="span2">${t('mail.body')}<textarea id="m-body" rows="12"></textarea></label>
        <label class="span2 check"><input type="checkbox" id="m-ship"> ${t('mail.also_ship')}</label>
        <div class="span2"><button id="send-mail" class="primary">${t('mail.send')}</button>
          <span class="small muted">${t('mail.send_help')}</span></div>
      </div>` : `<p class="muted">${t('mail.no_email')}</p>`}
      ${emails.length ? `<h3>${t('mail.history')}</h3><ul class="log">${emails.map(e => `
        <li><span class="badge em-${e.status}">${mailSt(e.status)}</span>
          <b>${esc(e.subject)}</b> <span class="muted">· ${fmtDate(e.sent_at || e.created_at, true)} · ${esc(e.requested_by || '')}</span>
          ${e.error ? `<div class="small error-text">${esc(e.error)}</div>` : ''}
          ${e.status === 'pending' ? `<button class="link cancel-mail" data-id="${e.id}">${t('mail.cancel')}</button>` : ''}
          <details><summary>${t('mail.view')}</summary><pre>${esc(e.body_text)}</pre></details></li>`).join('')}</ul>` : ''}
    </section>

    <section class="card">
      <h2>${t('history.title')}</h2>
      <ul class="log">${history.map(h => `<li>${fmtDate(h.changed_at, true)} · ${h.old_status ? statusBadge(h.old_status) + ' → ' : ''}${statusBadge(h.new_status)} <span class="muted">${t('history.by', { who: esc(h.changed_by || '?') })}</span></li>`).join('')}</ul>
      ${o.raw ? `<details><summary>${t('history.raw')}</summary><table class="raw">${Object.entries(o.raw).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></details>` : ''}
      ${state.me.role === 'admin' ? `<p><button id="delete-order" class="link danger">${t('order.delete')}</button></p>` : ''}
    </section>`;

  // --- articles
  const num = id => ($(id).value === '' ? null : +$(id).value);
  const codVal = () => $('#s-cod').value === '' ? null : $('#s-cod').value === '1';
  const drawTotals = () => {
    const its = editItems.map(i => ({ ...i, qty: +i.qty || 0 }));
    o.cod = codVal();
    const v = computeView({ ...o, discount_eur: num('#d-eur'), discount_czk: num('#d-czk'), shipping_eur: num('#s-eur'), shipping_czk: num('#s-czk') },
      its, state.settings.discount_rules, ctx());
    const auto = computeView({ ...o, discount_eur: null, discount_czk: null, shipping_eur: null, shipping_czk: null }, its, state.settings.discount_rules, ctx());
    $('#t-sub').textContent = `${money(v.subtotal_eur)} € / ${money(v.subtotal_czk)} Kč`;
    $('#d-eur').placeholder = `${t('items.auto')} (${money(auto.discount_eur_effective)})`;
    $('#d-czk').placeholder = `${t('items.auto')} (${money(auto.discount_czk_effective)})`;
    $('#t-total').textContent = `${money(v.total_eur)} € / ${money(v.total_czk)} Kč`;
    $('#t-weight').innerHTML = `${kg(v.weight_g)} kg${v.weight_unknown ? ` <span class="missing-tag">⚠ ${t('ship.weight_unknown')}</span>` : ''}`;
    $('#s-eur').placeholder = auto.shipping_unknown ? '?' : `${t('items.auto')} (${money(auto.shipping_eur_effective)})`;
    $('#s-czk').placeholder = auto.shipping_unknown ? '?' : `${t('items.auto')} (${money(auto.shipping_czk_effective)})`;
    const carrierName = esc(carrierLabel(effectiveCarrier(o)));
    $('#t-ship-info').innerHTML = auto.shipping_unknown
      ? `<span class="missing-tag">⚠ ${t('ship.none', { carrier: carrierName, country: esc(v.country_code), kg: kg(v.weight_g) })}</span>`
      : `${t('ship.auto')} : ${carrierName} · ${esc(v.country_code)} · ${kg(v.weight_g)} kg`
        + (auto.cod_effective ? ` · ${t('cod.included', { eur: money(auto.cod_eur), czk: money(auto.cod_czk) })}` : '');
    $('#t-grand').textContent = `${money(v.grand_total_eur)} € / ${money(v.grand_total_czk)} Kč`;
  };
  const productCell = it => {
    const list = activeProducts();
    if (it.custom || !state.products.length) {
      return `<input data-k="product" value="${esc(it.product)}" class="wide" aria-label="${t('items.product')}">`;
    }
    const known = productByName(it.product);
    const opts = known && !known.active ? [known, ...list] : list;
    // menu groupé par catégorie principale, textile d'abord
    const groups = {};
    for (const p of opts) {
      const top = catPath(p.category_id).split(' › ')[0] || t('cat.no_category');
      (groups[top] ||= []).push(p);
    }
    const opt = p => `<option ${known && p.id === known.id ? 'selected' : ''}>${esc(p.name)}</option>`;
    return `<div class="prod-cell">${known ? thumb(known, 'thumb sm') : ''}<select data-k="product" class="wide" aria-label="${t('items.product')}">
      ${it.product && !known ? `<option selected>${esc(it.product)}</option>` : ''}
      ${!it.product ? '<option value="" selected>—</option>' : ''}
      ${Object.entries(groups).map(([g, ps]) => `<optgroup label="${esc(g)}">${ps.map(opt).join('')}</optgroup>`).join('')}
      <option value="__other">${t('cat.other')}</option></select></div>`;
  };
  const sizeCell = it => {
    const p = productByName(it.product);
    if (it.custom || !p) return `<input data-k="size" value="${esc(it.size ?? '')}" class="xs" aria-label="${t('items.size')}">`;
    const sizes = [...(p.textile === false ? [] : p.sizes || [])], girlyS = (p.textile === false ? [] : p.girly_sizes || []).map(x => 'Girly ' + x);
    if (it.size && !sizes.includes(it.size) && !girlyS.includes(it.size)) sizes.unshift(it.size);
    if (!sizes.length && !girlyS.length) return '<span class="muted">—</span>';
    const o = z => `<option ${z === it.size ? 'selected' : ''}>${esc(z)}</option>`;
    return `<select data-k="size" aria-label="${t('items.size')}"><option value="">${t('cat.choose_size')}</option>
      ${girlyS.length ? `<optgroup label="Unisex">${sizes.map(o).join('')}</optgroup><optgroup label="Girly">${girlyS.map(o).join('')}</optgroup>` : sizes.map(o).join('')}</select>`;
  };
  const drawItems = () => {
    $('#items').innerHTML = editItems.map((it, i) => `
      <tr data-i="${i}" class="${it.missing ? 'is-missing' : ''}">
        <td class="center"><input type="checkbox" data-k="prepared" ${it.prepared ? 'checked' : ''} aria-label="${t('items.prepared')}"></td>
        <td class="center"><label class="miss"><input type="checkbox" data-k="missing" ${it.missing ? 'checked' : ''}> ⚠</label></td>
        <td>${productCell(it)}
          ${it.missing ? `<input data-k="missing_note" class="missing-note" value="${esc(it.missing_note ?? '')}" placeholder="${t('miss.note_ph')}" aria-label="${t('miss.notes')}">
          ${it.missing_since ? `<div class="small muted">${t('miss.since', { date: fmtDate(it.missing_since) })}</div>` : ''}` : ''}</td>
        <td>${sizeCell(it)}</td>
        <td class="num"><input data-k="qty" type="number" min="1" value="${esc(it.qty)}" class="xs" aria-label="${t('items.qty')}"></td>
        <td class="num"><input data-k="unit_eur" type="number" step="0.5" value="${esc(it.unit_eur ?? '')}" class="sm" aria-label="${t('items.price_eur')}"></td>
        <td class="num"><input data-k="unit_czk" type="number" step="10" value="${esc(it.unit_czk ?? '')}" class="sm" aria-label="${t('items.price_czk')}"></td>
        <td><button class="link danger rm" title="${t('items.remove')}" aria-label="${t('items.remove')}">✕</button></td>
      </tr>`).join('') || `<tr><td colspan="8" class="empty">${t('items.empty')}</td></tr>`;
    $$('#items tr[data-i]').forEach(tr => {
      const it = editItems[+tr.dataset.i];
      $$('input, select', tr).forEach(inp => inp.oninput = inp.onchange = e => {
        if (inp.dataset.k === 'product' && inp.tagName === 'SELECT') {
          if (e.type === 'input') return;
          if (inp.value === '__other') {
            it.custom = true; it.product = ''; drawItems();
            $(`#items tr[data-i="${tr.dataset.i}"] input[data-k=product]`).focus(); return;
          }
          const p = productByName(inp.value);
          it.product = inp.value;
          if (p) {
            it.unit_eur = p.price_eur ?? ''; it.unit_czk = p.price_czk ?? '';
            if (!allSizes(p).includes(it.size)) it.size = '';
          }
          drawItems(); return;
        }
        it[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? (inp.value === '' ? '' : +inp.value) : inp.value;
        if (inp.dataset.k === 'missing') { if (inp.checked) it.prepared = false; drawItems(); $(`#items tr[data-i="${tr.dataset.i}"] .missing-note`)?.focus(); return; }
        drawTotals();
      });
      $('.rm', tr).onclick = () => { if (it.id) removed.push(it.id); editItems.splice(+tr.dataset.i, 1); drawItems(); };
    });
    drawTotals();
  };
  for (const id of ['#d-eur', '#d-czk', '#s-eur', '#s-czk']) $(id).oninput = drawTotals;
  $('#s-cod').onchange = drawTotals;
  $('#add-item').onclick = () => {
    editItems.push({ product: '', size: '', qty: 1, unit_eur: '', unit_czk: '', prepared: false });
    drawItems();
    $('#items tr:last-child [data-k=product]').focus();
  };
  $('#save-items').onclick = async () => {
    if (editItems.some(i => !String(i.product).trim())) return toast(t('items.need_name'), 'error');
    await guard(async () => {
      await db.saveItems(o.id, editItems, removed);
      await db.updateOrders([o.id], { discount_eur: num('#d-eur'), discount_czk: num('#d-czk'), shipping_eur: num('#s-eur'), shipping_czk: num('#s-czk'), cod: codVal() });
    }, t('items.saved'));
    pageOrder(o.id);
  };
  drawItems();

  // --- formulaires
  const formPatch = form => {
    const fd = new FormData(form), patch = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      patch[el.name] = el.type === 'checkbox' ? el.checked : (fd.get(el.name) === '' ? null : fd.get(el.name));
    }
    return patch;
  };
  $('#f-track').onsubmit = async e => {
    e.preventDefault();
    const p = formPatch(e.target);
    if (p.order_no != null) p.order_no = +p.order_no;
    await guard(() => db.updateOrders([o.id], p), t('order.saved_tracking'));
    pageOrder(o.id);
  };
  for (const f of ['#f-ship', '#f-customer']) $(f).onsubmit = async e => {
    e.preventDefault();
    const p = formPatch(e.target);
    // mode de livraison modifié : le transporteur suit, sauf s'il a été choisi à la main
    if ('shipping_method' in p && p.shipping_method !== o.shipping_method
        && (!o.carrier || o.carrier === guessCarrier(o.shipping_method))) p.carrier = guessCarrier(p.shipping_method) || null;
    if (p.email) p.email = p.email.toLowerCase().trim();
    await guard(() => db.updateOrders([o.id], p), t('saved'));
    pageOrder(o.id);
  };

  // --- mails
  if (o.email) {
    const fill = () => {
      const tp = templates[$('#tpl').value];
      $('#m-subject').value = tp ? renderTemplate(tp.subject, o, items, state.settings) : `ADACTA merch · order N°${o.order_no ?? ''}`;
      $('#m-body').value = tp ? renderTemplate(tp.body, o, items, state.settings) : `${prefersSk(o) ? 'Ahoj' : 'Hi'} ${o.first_name ?? ''}!\n\n\n\nADACTA`;
      $('#m-ship').checked = $('#tpl').value.startsWith('expedition') && o.status !== 'envoyee';
    };
    $('#tpl').onchange = fill;
    $('#tpl').value = defaultTemplate(o, templates);
    fill();
    $('#send-mail').onclick = async () => {
      const body = $('#m-body').value;
      const src = (templates[$('#tpl').value] || {}).body || '';
      if (/\{\w+\}/.test(body + $('#m-subject').value) && !await confirmDialog(t('mail.leftover'))) return;
      if (!o.order_no && /\{order_no\}/.test(src) && !await confirmDialog(t('mail.no_number'))) return;
      if (/\{tracking_(number|url)\}/.test(src) && !o.tracking_number && !await confirmDialog(t('mail.no_tracking'))) return;
      if (/\{(shipping_eur|shipping_czk|grand_total_eur|grand_total_czk)\}/.test(src) && o.shipping_unknown && !await confirmDialog(t('mail.no_shipping'))) return;
      if (/\{(iban|bic)\}/.test(src) && !state.settings.bank?.iban && !await confirmDialog(t('mail.no_iban'))) return;
      await guard(async () => {
        await db.queueEmails([{ order_id: o.id, kind: $('#tpl').value || 'custom', to_email: $('#m-to').value.trim(),
                                subject: $('#m-subject').value, body_text: body }]);
        if ($('#m-ship').checked) await db.updateOrders([o.id], { status: 'envoyee' });
      }, t('mail.queued'));
      pageOrder(o.id);
    };
  }
  $$('.cancel-mail').forEach(b => b.onclick = async () => { await guard(() => db.cancelEmail(+b.dataset.id), t('mail.cancelled')); pageOrder(o.id); });
  $('#delete-order')?.addEventListener('click', async () => {
    if (!await confirmDialog(t('order.delete_confirm', { label: orderLabel(o) }))) return;
    await guard(() => db.deleteOrder(o.id), t('order.deleted'));
    location.hash = '#/commandes';
  });
}

// ---------------------------------------------------------------------
// Commande saisie à la main (concert, message privé…)
// ---------------------------------------------------------------------
function pageNewOrder() {
  $('#app').innerHTML = `
    <a href="#/commandes" class="back">${t('order.back')}</a>
    <section class="card narrow">
      <h1>${t('new.title')}</h1>
      <p class="muted">${t('new.sub')}</p>
      <form id="f-new" class="form-grid">
        <label>${t('order.number')}<input name="order_no" type="number" placeholder="${t('new.auto_no')}"></label>
        <label>${t('order.method')}<input name="shipping_method" placeholder="${t('new.method_ph')}"></label>
        ${CUSTOMER_FIELDS.map(k => `<label>${t('f.' + k)}<input name="${k}" ${k === 'email' ? 'type="email"' : ''}></label>`).join('')}
        <div class="span2"><button class="primary">${t('new.create')}</button></div>
      </form>
    </section>`;
  $('#f-new').onsubmit = async e => {
    e.preventDefault();
    const fields = Object.fromEntries([...new FormData(e.target)].filter(([, v]) => v !== ''));
    if (fields.order_no) fields.order_no = +fields.order_no;
    if (fields.email) fields.email = fields.email.toLowerCase().trim();
    fields.submitted_at = new Date().toISOString();
    fields.source_key = 'manuel|' + fields.submitted_at;
    const id = await guard(() => db.createOrder(fields), t('new.created'));
    location.hash = `#/commande/${id}`;
  };
}

// ---------------------------------------------------------------------
// Articles à préparer
// ---------------------------------------------------------------------

async function pagePreparation() {
  if (!state.orders.length) state.orders = await guard(() => db.listOrders());
  const chosen = new Set(JSON.parse(storageGet('prep-status') || '["non_traitee","en_preparation"]'));
  $('#app').innerHTML = `
    <header class="order-head"><div><h1>${t('prep.title')}</h1><p class="muted" id="prep-sub"></p></div>
      <div class="head-actions"><button class="ghost print-btn" onclick="window.print()">${t('order.print')}</button></div></header>
    <div class="toolbar no-print">${STATUS_KEYS.map(k => `<label class="chip"><input type="checkbox" value="${k}" ${chosen.has(k) ? 'checked' : ''}> ${esc(statusLabel(k))}</label>`).join('')}
      <label class="chip"><input type="checkbox" id="hide-prepared" ${storageGet('prep-hide') === '1' ? 'checked' : ''}> ${t('prep.hide')}</label></div>
    <div id="prep"></div>`;
  const draw = async () => {
    const statuses = $$('.toolbar input[value]').filter(i => i.checked).map(i => i.value);
    storageSet('prep-status', JSON.stringify(statuses));
    const hide = $('#hide-prepared').checked;
    storageSet('prep-hide', hide ? '1' : '0');
    const orders = state.orders.filter(o => statuses.includes(o.status));
    const byId = Object.fromEntries(orders.map(o => [o.id, o]));
    const allItems = await db.listItems(orders.map(o => o.id));
    const missingItems = allItems.filter(i => i.missing);
    const items = allItems.filter(i => !i.missing && (!hide || !i.prepared));
    const groups = {};
    for (const it of items) {
      const key = it.product + '\u0000' + (it.size || '');
      (groups[key] ||= { product: it.product, size: it.size, qty: 0, orders: [], prepared: 0 });
      groups[key].qty += it.qty;
      groups[key].prepared += it.prepared ? it.qty : 0;
      groups[key].orders.push(byId[it.order_id]);
    }
    const rows = Object.values(groups).sort((a, b) => a.product.localeCompare(b.product) ||
      (sizeRank(a.size) - sizeRank(b.size)));
    const total = rows.reduce((a, r) => a + r.qty, 0);
    $('#prep-sub').textContent = t('prep.sub', { orders: orders.length, items: total });
    let last = null;
    $('#prep').innerHTML = `<div class="table-wrap"><table class="prep">
      <thead><tr><th class="print-only">☐</th><th>${t('items.product')}</th><th>${t('items.size')}</th><th class="num">${t('items.qty')}</th><th>${t('prep.orders')}</th></tr></thead>
      <tbody>${rows.map(r => {
        const same = r.product === last; last = r.product;
        const ords = [...new Set(r.orders)].sort((a, b) => (a.order_no ?? 1e9 + a.id) - (b.order_no ?? 1e9 + b.id));
        return `<tr class="${same ? 'cont' : 'first'} ${r.prepared === r.qty ? 'done' : ''}"><td class="print-only">☐</td><td>${same ? '' : esc(r.product)}</td><td>${esc(r.size || '—')}</td>
          <td class="num"><b>${r.qty}</b>${r.prepared && r.prepared < r.qty ? ` <span class="small muted">(${t('prep.ready', { n: r.prepared })})</span>` : ''}</td>
          <td>${ords.map(o => `<a href="#/commande/${o.id}">${o.order_no ?? '#' + o.id}</a>`).join(', ')}</td></tr>`;
      }).join('') || `<tr><td colspan="5" class="empty">${t('prep.empty')}</td></tr>`}</tbody>
      <tfoot><tr><td class="print-only"></td><td>${t('prep.total')}</td><td></td><td class="num"><b>${total}</b></td><td></td></tr></tfoot></table></div>
      ${missingTable(missingItems, byId)}`;
  };
  $$('.toolbar input').forEach(i => i.onchange = draw);
  draw();
}

function missingTable(items, byId) {
  const groups = {};
  for (const it of items) {
    const key = it.product + '\u0000' + (it.size || '');
    (groups[key] ||= { product: it.product, size: it.size, qty: 0, lines: [] });
    groups[key].qty += it.qty;
    groups[key].lines.push(it);
  }
  const rows = Object.values(groups).sort((a, b) => a.product.localeCompare(b.product) || (sizeRank(a.size) - sizeRank(b.size)));
  const total = rows.reduce((a, r) => a + r.qty, 0);
  return `<h2 class="missing-h">⚠ ${t('miss.title')}</h2><p class="small muted">${t('miss.help')}</p>
    <div class="table-wrap"><table class="prep missing-table">
      <thead><tr><th>${t('items.product')}</th><th>${t('items.size')}</th><th class="num">${t('items.qty')}</th><th>${t('prep.orders')}</th><th>${t('miss.notes')}</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(r.product)}</td><td>${esc(r.size || '—')}</td><td class="num"><b>${r.qty}</b></td>
        <td>${r.lines.map(i => byId[i.order_id]).filter(Boolean).map(o => `<a href="#/commande/${o.id}">${o.order_no ?? '#' + o.id}</a>`).join(', ')}</td>
        <td class="small">${r.lines.filter(i => i.missing_note).map(i => `${esc(byId[i.order_id]?.order_no ?? '')}: ${esc(i.missing_note)}`).join('<br>')}</td></tr>`).join('')
        || `<tr><td colspan="5" class="empty">${t('miss.empty')}</td></tr>`}</tbody>
      ${total ? `<tfoot><tr><td>${t('prep.total')}</td><td></td><td class="num"><b>${total}</b></td><td></td><td></td></tr></tfoot>` : ''}</table></div>`;
}

function storageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* stockage indisponible */ } }

// ---------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------
async function pageSettings() {
  const s = state.settings = await db.settings();
  const isAdmin = state.me.role === 'admin';
  const allowed = await db.listAllowed();
  const tpls = s.email_templates || {};
  const mail = s.email || {};
  const tracking = s.tracking_urls || {};
  $('#app').innerHTML = `
    <h1>${t('set.title')}</h1>
    <section class="card">
      <h2>${t('set.people')}</h2>
      <p class="muted">${t('set.people_help')}${isAdmin ? '' : t('set.people_admin_only')}</p>
      <ul class="people">${allowed.map(a => `<li><span>${esc(a.email)}</span> <span class="badge">${a.role === 'admin' ? t('set.admin') : t('set.member')}</span>
        ${isAdmin && a.email !== state.me.email ? `<button class="link danger rm-user" data-email="${esc(a.email)}">${t('set.remove')}</button>` : ''}</li>`).join('')}</ul>
      ${isAdmin ? `<form id="f-user" class="inline-form"><input id="new-user" name="email" type="email" required placeholder="${t('set.email_ph')}">
        <select name="role"><option value="member">${t('set.member')}</option><option value="admin">${t('set.admin')}</option></select><button class="primary">${t('set.add')}</button></form>` : ''}
    </section>

    <section class="card">
      <h2>${t('set.sender')}</h2>
      <form id="f-mail" class="form-grid">
        <label>${t('set.sender_name')}<input name="sender_name" value="${esc(mail.sender_name ?? 'ADACTA')}"></label>
        <label>${t('set.reply_to')}<input name="reply_to" type="email" value="${esc(mail.reply_to ?? '')}"></label>
        <label class="span2">${t('set.cc')}<input name="cc" value="${esc(mail.cc ?? '')}"></label>
        <label class="span2 check"><input type="checkbox" name="bcc_users" ${mail.bcc_users === false ? '' : 'checked'}> ${t('set.bcc_users')}</label>
        <label class="span2 check"><input type="checkbox" name="auto_confirm" ${mail.auto_confirm === false ? '' : 'checked'}> ${t('set.auto_confirm')}</label>
        <div class="span2"><button class="primary">${t('save')}</button></div>
      </form>
    </section>

    <section class="card">
      <h2>${t('set.bank')}</h2>
      <p class="small muted">${t('set.bank_help')}</p>
      <form id="f-bank" class="form-grid">
        <label>IBAN<input name="iban" value="${esc(state.settings.bank?.iban ?? '')}" autocomplete="off" spellcheck="false"></label>
        <label>SWIFT/BIC<input name="bic" value="${esc(state.settings.bank?.bic ?? '')}" autocomplete="off" spellcheck="false"></label>
        <div class="span2"><button class="primary">${t('save')}</button></div>
      </form>
    </section>

    <section class="card">
      <h2>${t('set.templates')}</h2>
      <p class="small muted">${t('set.vars')} {first_name} {last_name} {customer_name} {order_no} {items} {missing_items} {weight_kg} {shipping_eur} {grand_total_eur} {grand_total_czk} {subtotal_eur} {discount_eur} {total_eur} {total_czk} {shipping_method} {pickup_point} {tracking_number} {tracking_url} {address} {iban} {bic}</p>
      <div id="tpls">${Object.entries(tpls).map(([k, tp]) => tplEditor(k, tp)).join('')}</div>
      <div class="row-actions"><button id="add-tpl" class="ghost">${t('set.new_tpl')}</button> <button id="save-tpls" class="primary">${t('set.save_tpls')}</button></div>
    </section>

    <section class="card">
      <h2>${t('set.tracking')}</h2>
      <p class="small muted">${t('set.tracking_help')}</p>
      <form id="f-tracking" class="form-grid">
        ${carrierKeys().filter(k => k && k !== 'main_propre').map(k => `<label class="span2">${esc(carrierLabel(k))}<input name="${k}" value="${esc(tracking[k] ?? '')}"></label>`).join('')}
        <div class="span2"><button class="primary">${t('save')}</button></div>
      </form>
    </section>

    <section class="card">
      <h2>${t('set.discounts')}</h2>
      <p class="small muted">${t('set.discounts_help')}</p>
      <div class="table-wrap"><table class="rules"><thead><tr><th>${t('set.rule_match')}</th><th class="num">${t('set.per_piece_eur')}</th><th class="num">${t('set.per_piece_czk')}</th><th></th></tr></thead>
        <tbody id="rules"></tbody></table></div>
      <div class="row-actions"><button id="add-rule" class="ghost">${t('set.add_rule')}</button> <button id="save-rules" class="primary">${t('set.save_rules')}</button></div>
    </section>`;

  $('#f-user')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await guard(() => db.addAllowed(fd.get('email'), fd.get('role')), t('set.added'));
    pageSettings();
  });
  $$('.rm-user').forEach(b => b.onclick = async () => {
    if (!await confirmDialog(t('set.remove_confirm', { email: b.dataset.email }))) return;
    await guard(() => db.removeAllowed(b.dataset.email), t('set.removed'));
    pageSettings();
  });

  $('#f-mail').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const was = (state.settings.email || {}).auto_confirm !== false, on = fd.has('auto_confirm');
    await guard(() => db.saveSetting('email', { ...(state.settings.email || {}), ...Object.fromEntries(fd), bcc_users: fd.has('bcc_users'),
      auto_confirm: on, ...(on && !was ? { auto_confirm_since: new Date().toISOString() } : {}) }), t('saved'));
    state.settings = await db.settings();
  };
  $('#f-bank').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const clean = v => String(v || '').toUpperCase().replace(/\s+/g, ' ').trim();
    await guard(() => db.saveSetting('bank', { iban: clean(fd.get('iban')), bic: clean(fd.get('bic')) }), t('saved'));
    state.settings = await db.settings();
  };
  $('#f-tracking').onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries([...new FormData(e.target)].filter(([, x]) => x.trim()));
    await guard(() => db.saveSetting('tracking_urls', v), t('saved'));
    state.settings = await db.settings();
  };

  const bindTplRemove = () => $$('.rm-tpl').forEach(b => b.onclick = () => b.closest('.tpl').remove());
  $('#add-tpl').onclick = () => {
    $('#tpls').insertAdjacentHTML('beforeend', tplEditor('tpl_' + Date.now().toString(36),
      { label: t('set.tpl_new_label'), subject: 'ADACTA merch · order N°{order_no}', body: 'Hi {first_name}!\n\n\n\nADACTA' }, true));
    bindTplRemove();
  };
  bindTplRemove();
  $('#save-tpls').onclick = async () => {
    const v = {};
    $$('.tpl').forEach(d => { v[d.dataset.key] = { label: $('[data-f=label]', d).value, subject: $('[data-f=subject]', d).value, body: $('[data-f=body]', d).value }; });
    await guard(() => db.saveSetting('email_templates', v), t('set.tpls_saved'));
    state.settings = await db.settings();
  };

  let rules = structuredClone(s.discount_rules || []);
  const drawRules = () => {
    $('#rules').innerHTML = rules.map((r, i) => `<tr data-i="${i}">
      <td><input data-k="match" class="wide" value="${esc((r.match || []).join(', '))}" aria-label="${t('set.rule_match')}"></td>
      <td class="num"><input data-k="eur" type="number" step="0.5" class="sm" value="${esc(r.eur ?? 0)}" aria-label="${t('set.per_piece_eur')}"></td>
      <td class="num"><input data-k="czk" type="number" step="10" class="sm" value="${esc(r.czk ?? 0)}" aria-label="${t('set.per_piece_czk')}"></td>
      <td><button class="link danger rm-rule" aria-label="${t('items.remove')}">✕</button></td></tr>`).join('') || `<tr><td colspan="4" class="empty">${t('set.no_rules')}</td></tr>`;
    $$('#rules tr[data-i]').forEach(tr => {
      const r = rules[+tr.dataset.i];
      $$('input', tr).forEach(inp => inp.oninput = () => {
        r[inp.dataset.k] = inp.dataset.k === 'match' ? inp.value.split(',').map(x => x.trim()).filter(Boolean) : +inp.value;
      });
      $('.rm-rule', tr).onclick = () => { rules.splice(+tr.dataset.i, 1); drawRules(); };
    });
  };
  drawRules();
  $('#add-rule').onclick = () => { rules.push({ match: [], eur: 0, czk: 0 }); drawRules(); };
  $('#save-rules').onclick = async () => {
    rules = rules.filter(r => r.match.length);
    await guard(() => db.saveSetting('discount_rules', rules), t('set.rules_saved'));
    state.settings = await db.settings();
    drawRules();
  };
}

// ---------------------------------------------------------------------
// Katalóg : articles, prix, tailles, poids
// ---------------------------------------------------------------------
async function pageCatalog() {
  [state.products, state.categories] = await guard(() => Promise.all([db.listProducts(), db.listCategories()]));
  state.settings = await db.settings();
  const f = state.catFilter ||= { q: '', cat: '', type: '', textile: '', inactive: false };
  const gf = state.settings.google_form || {};
  // seuls les admins modifient le Katalóg (la base le refuse aussi aux membres)
  const isAdmin = state.me?.role === 'admin';
  $('#app').innerHTML = `
    <header class="order-head"><div><h1>${t('cat.title')}</h1><p class="muted narrow-text">${isAdmin ? t('cat.help') : t('cat.readonly')}</p></div>
      <div class="head-actions">${state.settings.google_form?.view_url ? `<a class="button" href="${esc(state.settings.google_form.view_url)}" target="_blank" rel="noopener">${t('cat.open_form')} ↗</a>` : ''}
        ${isAdmin && state.settings.google_form?.edit_url ? `<a class="button" href="${esc(state.settings.google_form.edit_url)}" target="_blank" rel="noopener">${t('cat.edit_form')} ↗</a>` : ''}
        ${isAdmin ? `<button id="cat-add" class="primary">${t('cat.add')}</button>
        <button id="cat-form" class="ghost">${t('cat.form_btn')}</button>` : ''}</div></header>
    <div class="toolbar cat-toolbar">
      <input id="cat-q" type="search" placeholder="${t('cat.search')}" value="${esc(f.q)}" aria-label="${t('cat.search')}">
      <select id="cat-type" aria-label="${t('cat.type')}"><option value="">${t('cat.all_types')}</option>
        ${productTypes().map(x => `<option ${x.name === f.type ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <span class="seg" role="group" aria-label="${t('cat.textile')}">
        ${[['', 'cat.all'], ['1', 'cat.textile'], ['0', 'cat.non_textile']].map(([v, k]) =>
          `<button data-tx="${v}" class="${f.textile === v ? 'on' : ''}">${t(k)}</button>`).join('')}</span>
      <label class="chip"><input type="checkbox" id="cat-inactive" ${f.inactive ? 'checked' : ''}> ${t('cat.show_inactive')}</label>
    </div>
    ${isAdmin ? `<details class="card" id="form-head"><summary><h2>${t('cat.form_header')}</h2></summary>
      <div class="form-head">
        ${gf.header_image ? `<img class="form-banner" src="${esc(gf.header_image)}" alt="${t('cat.header_image')}">` : ''}
        <p class="small muted">${t('cat.header_image_note')}${gf.edit_url ? ` <a href="${esc(gf.edit_url)}" target="_blank" rel="noopener">${t('cat.edit_form')} ↗</a>` : ''}</p>
        <label>${t('cat.form_title_label')}<input id="fh-title" value="${esc(gf.title ?? '')}" maxlength="200"></label>
        <label>${t('cat.form_desc_label')}<textarea id="fh-desc" rows="6" placeholder="${t('cat.form_desc_ph')}">${esc(gf.description ?? '')}</textarea></label>
        <div><button id="fh-save" class="primary">${t('cat.form_header_save')}</button></div>
      </div></details>` : ''}
    <p id="cat-warn" class="notice" hidden></p>
    <div class="cat-layout">
      <nav id="cat-nav" class="card" aria-label="${t('cat.categories')}"></nav>
      <div id="cat-lists"></div>
    </div>
    ${isAdmin ? `<details class="card" id="cat-admin"><summary><h2>${t('cat.manage')}</h2></summary>
      <div class="admin-grid"><div><h3>${t('cat.categories')}</h3><p class="small muted">${t('cat.cat_help')}</p>
        <div id="cat-tree"></div><button id="cat-root" class="ghost">${t('cat.add_root')}</button></div>
      <div><h3>${t('cat.types')}</h3><p class="small muted">${t('cat.types_help')}</p>
        <div id="type-list"></div><button id="type-add" class="ghost">${t('cat.add_type')}</button>
        <button id="type-save" class="primary">${t('cat.save_types')}</button></div></div></details>` : ''}`;

  const collapsed = state.catCollapsed ||= new Set();
  const draw = () => {
    const q = f.q.trim().toLowerCase();
    // filtres hors catégorie (recherche, type, textile, inactifs)
    const base = state.products.filter(p =>
      (f.inactive || p.active) &&
      (!q || p.name.toLowerCase().includes(q) || (p.type || '').toLowerCase().includes(q)) &&
      (!f.type || p.type === f.type) && (f.textile === '' || String(+!!p.textile) === f.textile));
    const known = new Set((state.categories || []).map(c => c.id));
    const direct = id => base.filter(p => id === 'none' ? !p.category_id || !known.has(p.category_id) : p.category_id === id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
    const count = id => id === 'none' ? direct('none').length : [...descendants(id)].reduce((n, c) => n + direct(c).length, 0);

    // --- menu des catégories (à gauche)
    const navTree = (parent, depth) => childrenOf(parent).map(c => `<li>
        <button class="nav-cat d${depth} ${String(f.cat) === String(c.id) ? 'on' : ''}" data-cat="${c.id}">
          <span>${esc(c.name)}</span><span class="n">${count(c.id)}</span></button>
        ${depth < 3 ? `<ul>${navTree(c.id, depth + 1)}</ul>` : ''}</li>`).join('');
    $('#cat-nav').innerHTML = `<ul class="cat-nav">
      <li><button class="nav-cat d0 ${!f.cat ? 'on' : ''}" data-cat=""><span>${t('cat.all_categories')}</span><span class="n">${base.length}</span></button></li>
      ${navTree(null, 1)}
      ${count('none') ? `<li><button class="nav-cat d1 ${f.cat === 'none' ? 'on' : ''}" data-cat="none"><span>${t('cat.no_category')}</span><span class="n">${count('none')}</span></button></li>` : ''}
    </ul>`;
    $$('#cat-nav .nav-cat').forEach(b => b.onclick = () => { f.cat = b.dataset.cat; draw(); $('#cat-lists').scrollIntoView({ block: 'nearest' }); });

    // --- articles groupés : catégorie › sous-catégorie › sous-sous-catégorie
    const row = p => `<tr data-id="${p.id}" class="${isAdmin || p.photos?.length ? 'clickable' : ''} ${p.active ? '' : 'inactive'}" ${isAdmin || p.photos?.length ? 'tabindex="0"' : ''}>
        <td class="thumb-cell">${p.photos?.length ? `<button class="zoom" title="${t('cat.zoom')}" aria-label="${t('cat.zoom')} : ${esc(p.name)}">${thumb(p)}${p.photos.length > 1 ? `<span class="zoom-n">${p.photos.length}</span>` : ''}</button>` : thumb(p)}</td>
        <td><strong>${esc(p.name)}</strong><div class="small muted">${p.type ? `<span class="type-tag">${esc(p.type)}</span> · ` : ''}${t(p.textile ? 'cat.textile' : 'cat.non_textile')}${p.from_form ? ` · ${t('cat.form')}` : ''}</div></td>
        <td class="small">${p.textile ? sizeChips(p) : '<span class="muted">—</span>'}</td>
        <td class="num">${p.price_eur != null ? money(p.price_eur) : '—'}</td><td class="num">${p.price_czk != null ? money(p.price_czk) : '—'}</td>
        <td class="num ${p.active && p.weight_g == null ? 'need-text' : ''}">${p.weight_g != null ? p.weight_g + ' g' : '?'}</td>
        <td>${!p.active ? `<span class="badge st-annulee">${t('cat.inactive')}</span>` : p.sold_out ? `<span class="badge st-non_traitee">SOLD OUT</span>` : `<span class="badge st-envoyee">${t('cat.on_sale')}</span>`}</td>
      </tr>`;
    const subRows = (id, depth) => direct(id).map(row).join('') + childrenOf(id).filter(c => count(c.id)).map(c =>
      `<tr class="grp grp-${depth}"><th colspan="7"><span>${esc(c.name)}</span> <span class="n">${count(c.id)}</span></th></tr>` + subRows(c.id, depth + 1)).join('');
    const head = `<thead><tr><th></th><th>${t('cat.name')}</th><th>${t('cat.sizes')}</th><th class="num">€</th><th class="num">Kč</th>
      <th class="num">${t('cat.weight')}</th><th>${t('cat.state')}</th></tr></thead>`;
    const section = (key, title, crumbs, rows, n) => `<section class="card cat-sec" data-key="${key}">
      <details ${collapsed.has(key) ? '' : 'open'}><summary>${crumbs ? `<div class="crumbs small muted">${esc(crumbs)}</div>` : ''}<h2>${esc(title)} <span class="n">${n}</span></h2></summary>
      <div class="table-wrap"><table class="catalog">${head}<tbody>${rows}</tbody></table></div></details></section>`;
    let html = '';
    if (f.cat && f.cat !== 'none') {               // une catégorie choisie : elle seule, avec ses sous-catégories
      const c = catById(+f.cat);
      if (c && count(c.id)) html = section('c' + c.id, c.name, catPath(c.parent_id), subRows(c.id, catDepth(c.id) + 1), count(c.id));
    } else {
      if (!f.cat) html = childrenOf(null).filter(c => count(c.id)).map(c => section('c' + c.id, c.name, '', subRows(c.id, 2), count(c.id))).join('');
      if (count('none')) html += section('none', t('cat.no_category'), '', direct('none').map(row).join(''), count('none'));
    }
    $('#cat-lists').innerHTML = !state.products.length ? `<p class="empty card">${t('cat.empty')}</p>`
      : html || `<p class="empty card">${t('cat.empty_filter')}</p>`;
    $$('#cat-lists details').forEach(d => d.ontoggle = () => {
      const k = d.closest('.cat-sec').dataset.key;
      if (d.open) collapsed.delete(k); else collapsed.add(k);
    });
    const noWeight = state.products.filter(p => p.active && p.weight_g == null).length;
    $('#cat-warn').hidden = !noWeight || !isAdmin;
    $('#cat-warn').textContent = t('cat.no_weight', { n: noWeight });
    $$('#cat-lists tr[data-id]').forEach(tr => {
      const prod = state.products.find(p => p.id === +tr.dataset.id);
      // membre : la ligne ouvre seulement les photos, pas la fiche de modification
      const open = () => isAdmin ? productEditor(prod, pageCatalog) : lightbox(prod);
      tr.onclick = open; tr.onkeydown = e => { if (e.key === 'Enter' && e.target === tr) open(); };
      const z = $('.zoom', tr);
      if (z) z.onclick = e => { e.stopPropagation(); lightbox(state.products.find(p => p.id === +tr.dataset.id)); };
    });
  };
  $('#cat-q').oninput = e => { f.q = e.target.value; draw(); };
  $('#cat-type').onchange = e => { f.type = e.target.value; draw(); };
  $$('.seg button').forEach(b => b.onclick = () => { f.textile = b.dataset.tx; $$('.seg button').forEach(x => x.classList.toggle('on', x === b)); draw(); });
  $('#cat-inactive').onchange = e => { f.inactive = e.target.checked; draw(); };
  if (!isAdmin) return draw();
  $('#cat-add').onclick = () => productEditor(null, pageCatalog);
  $('#fh-save').onclick = async () => {
    const title = $('#fh-title').value.trim();
    if (!title) return toast(t('cat.form_title_needed'), 'error');
    const done = await runFormRequest('form_header', { title, description: $('#fh-desc').value });
    if (done) { toast(t('cat.form_header_done')); state.settings = await db.settings(); }
  };
  $('#cat-form').onclick = async () => {
    const preview = await runFormRequest('form_preview');
    if (!preview) return;
    if (!preview.ops.length) return toast(t('cat.form_none'));
    if (!(await formPreviewDialog(preview.ops))) return;
    const done = await runFormRequest('form_publish');
    if (done) { toast(t('cat.form_done', done)); pageCatalog(); }
  };
  drawCategoryAdmin();
  draw();
}

// --- catégories (3 niveaux) et types -------------------------------------
const TEXTILE_SIZES = ['S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', 'Unisize'];
const DEFAULT_TYPES = [['LP', false], ['CD', false], ['MC', false], ['Patch', false], ['Bag', false], ['Headwear', false], ['Accessory', false],
  ['T-shirt', true], ['Longsleeve', true], ['Hoodie', true], ['Zipper hoodie', true], ['Crewneck', true]].map(([name, textile]) => ({ name, textile }));
const productTypes = () => state.settings.product_types || DEFAULT_TYPES;
const catById = id => (state.categories || []).find(c => c.id === id);
function catPath(id) {
  const parts = [];
  for (let c = catById(id), n = 0; c && n < 4; c = catById(c.parent_id), n++) parts.unshift(c.name);
  return parts.join(' › ');
}
const catDepth = id => { let d = 0; for (let c = catById(id); c && d < 4; c = catById(c.parent_id)) d++; return d; };
const childrenOf = id => (state.categories || []).filter(c => (c.parent_id || null) === (id || null))
  .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
function descendants(id) {
  const out = new Set([id]);
  for (const c of childrenOf(id)) for (const x of descendants(c.id)) out.add(x);
  return out;
}
function categoryOptions(selected) {
  const walk = (parent, depth) => childrenOf(parent).map(c =>
    `<option value="${c.id}" ${String(c.id) === String(selected) ? 'selected' : ''}>${' '.repeat(depth)}${esc(c.name)}</option>` + walk(c.id, depth + 1)).join('');
  return walk(null, 0);
}
const sizeRank = s => { const g = /^Girly /.test(s || ''); const i = [...TEXTILE_SIZES.slice(0, -1), 'Unisize'].indexOf(String(s || '').replace(/^Girly /, ''));
  return (g ? 100 : 0) + (i < 0 ? (['XXS', 'XS'].indexOf(s) >= 0 ? -2 + ['XXS', 'XS'].indexOf(s) : 50) : i); };
const allSizes = p => p && p.textile !== false ? [...(p.sizes || []), ...(p.girly_sizes || []).map(x => 'Girly ' + x)] : [];
const sizeChips = p => [(p.sizes || []).join(' '), (p.girly_sizes || []).length ? `<span class="girly">Girly ${esc(p.girly_sizes.join(' '))}</span>` : '']
  .filter(Boolean).join(' · ') || `<span class="need-text">${t('cat.no_sizes')}</span>`;
// Agrandissement des photos d'un article (flèches ← → , Échap pour fermer)
function lightbox(p, start = 0) {
  const photos = p?.photos || [];
  if (!photos.length) return;
  let i = start;
  const dlg = document.createElement('dialog');
  dlg.className = 'lightbox';
  dlg.setAttribute('aria-label', p.name);
  dlg.innerHTML = `<figure><img alt="${esc(p.name)}"><figcaption><strong>${esc(p.name)}</strong> <span class="muted lb-n"></span></figcaption></figure>
    <button class="lb-close" aria-label="${t('close')}">✕</button>
    ${photos.length > 1 ? `<button class="lb-prev" aria-label="←">‹</button><button class="lb-next" aria-label="→">›</button>
      <div class="lb-dots">${photos.map((u, k) => `<button data-k="${k}" aria-label="${k + 1}"><img src="${esc(u)}" alt=""></button>`).join('')}</div>` : ''}`;
  document.body.append(dlg);
  const show = k => {
    i = (k + photos.length) % photos.length;
    $('figure img', dlg).src = photos[i];
    $('.lb-n', dlg).textContent = photos.length > 1 ? `${i + 1} / ${photos.length}` : '';
    $$('.lb-dots button', dlg).forEach((b, k2) => b.classList.toggle('on', k2 === i));
  };
  const close = () => dlg.close();
  dlg.onclose = () => dlg.remove();
  dlg.onclick = e => { if (e.target === dlg) close(); };
  dlg.onkeydown = e => { if (e.key === 'ArrowRight') show(i + 1); if (e.key === 'ArrowLeft') show(i - 1); };
  $('.lb-close', dlg).onclick = close;
  if (photos.length > 1) {
    $('.lb-prev', dlg).onclick = () => show(i - 1);
    $('.lb-next', dlg).onclick = () => show(i + 1);
    $$('.lb-dots button', dlg).forEach(b => b.onclick = () => show(+b.dataset.k));
  }
  show(i);
  dlg.showModal();
}

const thumb = (p, cls = 'thumb') => p?.photos?.length
  ? `<img class="${cls}" src="${esc(p.photos[0])}" alt="" loading="lazy">`
  : `<span class="${cls} ph" aria-hidden="true">${esc((p?.type || p?.name || '?').slice(0, 2))}</span>`;

function drawCategoryAdmin() {
  const tree = parent => {
    const kids = childrenOf(parent);
    if (!kids.length) return '';
    return `<ul class="tree">${kids.map(c => `<li data-id="${c.id}"><div class="tree-row">
      <input value="${esc(c.name)}" aria-label="${t('cat.category')}" class="cat-name">
      <span class="small muted">${state.products.filter(p => p.category_id === c.id).length}</span>
      ${catDepth(c.id) < 3 ? `<button class="link add-sub">${t('cat.add_sub')}</button>` : ''}
      <button class="link danger del-cat" aria-label="${t('items.remove')}">✕</button></div>${tree(c.id)}</li>`).join('')}</ul>`;
  };
  $('#cat-tree').innerHTML = tree(null) || `<p class="small muted">${t('cat.no_categories')}</p>`;
  const reload = async () => { state.categories = await db.listCategories(); pageCatalog().then(() => { $('#cat-admin').open = true; }); };
  $$('#cat-tree li').forEach(li => {
    const id = +li.dataset.id, c = catById(id);
    $('.cat-name', li).onchange = async e => { if (!e.target.value.trim()) return; await guard(() => db.saveCategory({ ...c, name: e.target.value }), t('cat.saved_cat')); reload(); };
    const sub = $('.add-sub', li);
    if (sub) sub.onclick = async () => { const name = await askText(t('cat.new_sub', { name: c.name }), 60); if (name?.trim()) { await guard(() => db.saveCategory({ name, parent_id: id, position: 99 })); reload(); } };
    $('.del-cat', li).onclick = async () => {
      if (childrenOf(id).length) return toast(t('cat.del_children'), 'error');
      const n = state.products.filter(p => p.category_id === id).length;
      if (!(await confirmDialog(t('cat.del_confirm', { name: c.name, n })))) return;
      await guard(() => db.deleteCategory(id)); reload();
    };
  });
  $('#cat-root').onclick = async () => { const name = await askText(t('cat.new_root'), 60); if (name?.trim()) { await guard(() => db.saveCategory({ name, parent_id: null, position: 99 })); reload(); } };

  let types = structuredClone(productTypes());
  const drawTypes = () => {
    $('#type-list').innerHTML = types.map((x, i) => `<div class="type-row" data-i="${i}"><input value="${esc(x.name)}" aria-label="${t('cat.type')}">
      <label class="chip"><input type="checkbox" ${x.textile ? 'checked' : ''}> ${t('cat.textile')}</label>
      <button class="link danger" aria-label="${t('items.remove')}">✕</button></div>`).join('');
    $$('#type-list .type-row').forEach(row => {
      const x = types[+row.dataset.i];
      $('input:not([type])', row).onchange = e => { x.name = e.target.value.trim(); };
      $('input[type=checkbox]', row).onchange = e => { x.textile = e.target.checked; };
      $('button', row).onclick = () => { types.splice(+row.dataset.i, 1); drawTypes(); };
    });
  };
  $('#type-add').onclick = () => { types.push({ name: '', textile: false }); drawTypes(); $('#type-list .type-row:last-child input').focus(); };
  $('#type-save').onclick = async () => {
    types = types.filter(x => x.name);
    await guard(() => db.saveSetting('product_types', types), t('cat.saved_types'));
    state.settings.product_types = types;
  };
  drawTypes();
}

// --- fiche article : photos, catégorie, type, textile, tailles -------------
function productEditor(product, onDone) {
  const p = structuredClone(product || { name: '', price_eur: '', price_czk: '', sizes: [], girly_sizes: [], weight_g: '',
    active: true, sold_out: false, textile: false, type: '', category_id: null, photos: [] });
  p.photos ||= []; p.sizes ||= []; p.girly_sizes ||= [];
  const uploaded = [], removed = [];
  let girly = p.girly_sizes.length > 0;
  const d = document.createElement('dialog');
  d.className = 'wide product-dlg';
  document.body.append(d);
  const sizeBoxes = (key, list) => {
    const all = [...new Set([...TEXTILE_SIZES, ...list])].sort((a, b) => sizeRank(a) - sizeRank(b));
    return `<div class="size-boxes" data-key="${key}">${all.map(z => `<label class="size-box"><input type="checkbox" value="${esc(z)}" ${list.includes(z) ? 'checked' : ''}><span>${esc(z)}</span></label>`).join('')}</div>`;
  };
  const draw = () => {
    d.innerHTML = `<form method="dialog" class="product-form">
      <h2>${product ? esc(product.name) : t('cat.new_product')}</h2>
      <div class="photos" id="pe-photos">
        ${p.photos.map((u, i) => `<figure data-i="${i}"><img src="${esc(u)}" alt="${esc(p.name)} ${i + 1}">
          ${i === 0 ? `<figcaption>${t('cat.main_photo')}</figcaption>` : `<button type="button" class="link set-main">${t('cat.make_main')}</button>`}
          <button type="button" class="link danger rm-photo" aria-label="${t('cat.remove_photo')}">✕</button></figure>`).join('')}
        <label class="add-photo"><input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden><span>${t('cat.add_photos')}</span><small>${t('cat.drop_hint')}</small></label>
      </div>
      <div class="grid2">
        <label class="span2">${t('cat.name')}<input name="name" value="${esc(p.name)}" required></label>
        <label>${t('cat.category')}<select name="category_id"><option value="">${t('cat.no_category')}</option>${categoryOptions(p.category_id)}</select></label>
        <label>${t('cat.type')}<select name="type"><option value="">—</option>
          ${[...new Set([...productTypes().map(x => x.name), ...(p.type ? [p.type] : [])])].map(x => `<option ${x === p.type ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <label>${t('items.price_eur')}<input name="price_eur" type="number" step="0.5" min="0" value="${esc(p.price_eur ?? '')}"></label>
        <label>${t('items.price_czk')}<input name="price_czk" type="number" step="10" min="0" value="${esc(p.price_czk ?? '')}"></label>
        <label>${t('cat.weight')}<input name="weight_g" type="number" step="10" min="0" value="${esc(p.weight_g ?? '')}"></label>
        <div class="checks"><label class="chip"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> ${t('cat.active')}</label>
          <label class="chip"><input type="checkbox" name="sold_out" ${p.sold_out ? 'checked' : ''}> ${t('cat.sold_out')}</label></div>
      </div>
      <fieldset class="textile-box"><legend><label class="chip strong"><input type="checkbox" name="textile" ${p.textile ? 'checked' : ''}> ${t('cat.textile_q')}</label></legend>
        ${p.textile ? `<p class="small muted">${t('cat.sizes_help')}</p>${sizeBoxes('sizes', p.sizes)}
          <label class="chip girly-toggle"><input type="checkbox" name="girly" ${girly ? 'checked' : ''}> ${t('cat.girly_q')}</label>
          ${girly ? sizeBoxes('girly_sizes', p.girly_sizes) : ''}` : `<p class="small muted">${t('cat.non_textile_help')}</p>`}
      </fieldset>
      ${p.from_form ? `<p class="small muted">${t('cat.from_form_note')}</p>` : ''}
      <div class="actions">${product ? `<button type="button" class="link danger" id="pe-del">${t('cat.delete')}</button><span class="spacer"></span>` : ''}
        <button type="button" class="ghost" id="pe-cancel">${t('dlg.cancel')}</button><button class="primary">${t('cat.save_product')}</button></div>
    </form>`;
    const form = $('form', d);
    // garde les saisies quand on redessine la fiche
    const keep = () => {
      const fd = new FormData(form);
      p.name = fd.get('name'); p.category_id = fd.get('category_id') ? +fd.get('category_id') : null; p.type = fd.get('type');
      for (const k of ['price_eur', 'price_czk', 'weight_g']) p[k] = fd.get(k) === '' ? '' : +fd.get(k);
      p.active = !!fd.get('active'); p.sold_out = !!fd.get('sold_out'); p.textile = !!fd.get('textile');
      for (const box of $$('.size-boxes', form)) p[box.dataset.key] = $$('input:checked', box).map(x => x.value).sort((a, b) => sizeRank(a) - sizeRank(b));
    };
    $('select[name=type]', form).onchange = e => {
      const def = productTypes().find(x => x.name === e.target.value);
      keep();
      if (def) p.textile = def.textile;
      if (p.textile && !p.sizes.length) p.sizes = ['S', 'M', 'L', 'XL', 'XXL'];
      draw();
    };
    $('input[name=textile]', form).onchange = () => { keep(); if (p.textile && !p.sizes.length) p.sizes = ['S', 'M', 'L', 'XL', 'XXL']; draw(); };
    const g = $('input[name=girly]', form);
    if (g) g.onchange = () => { keep(); girly = g.checked; if (girly && !p.girly_sizes.length) p.girly_sizes = ['S', 'M', 'L']; draw(); };
    const addFiles = async files => {
      keep();
      for (const file of [...files].filter(x => /^image\//.test(x.type))) {
        const url = await guard(() => db.uploadPhoto(file));
        if (url) { p.photos.push(url); uploaded.push(url); }
      }
      draw();
    };
    $('.add-photo input', form).onchange = e => addFiles(e.target.files);
    const zone = $('#pe-photos', form);
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag'); };
    zone.ondragleave = () => zone.classList.remove('drag');
    zone.ondrop = e => { e.preventDefault(); zone.classList.remove('drag'); addFiles(e.dataTransfer.files); };
    $$('figure', form).forEach(fig => {
      const i = +fig.dataset.i;
      $('.rm-photo', fig).onclick = () => { keep(); removed.push(...p.photos.splice(i, 1)); draw(); };
      const m = $('.set-main', fig);
      if (m) m.onclick = () => { keep(); p.photos.unshift(...p.photos.splice(i, 1)); draw(); };
    });
    $('#pe-cancel', form).onclick = d.oncancel = e => { e?.preventDefault(); for (const u of uploaded) db.deletePhoto(u).catch(() => {}); d.close(); d.remove(); };
    const del = $('#pe-del', form);
    if (del) del.onclick = async () => {
      if (!(await confirmDialog(t('cat.delete_confirm', { name: product.name })))) return;
      await guard(() => db.deleteProduct(product.id), t('cat.deleted'));
      for (const u of [...p.photos, ...removed]) db.deletePhoto(u).catch(() => {});
      d.close(); d.remove(); onDone?.();
    };
    form.onsubmit = async e => {
      e.preventDefault();
      keep();
      p.name = String(p.name || '').trim();
      if (!p.name) return toast(t('items.need_name'), 'error');
      if (state.products.some(x => x.id !== p.id && x.name.toLowerCase() === p.name.toLowerCase())) return toast(t('cat.dup', { name: p.name }), 'error');
      if (!girly) p.girly_sizes = [];
      if (p.textile && !p.sizes.length && !p.girly_sizes.length) return toast(t('cat.need_size'), 'error');
      await guard(() => db.saveProduct(p), t('cat.saved_product'));
      for (const u of removed) db.deletePhoto(u).catch(() => {});
      d.close(); d.remove(); onDone?.();
    };
  };
  draw();
  d.showModal();
}

// ---------------------------------------------------------------------
// Doprava : grille transporteur × pays × poids
// ---------------------------------------------------------------------
async function pageTransport() {
  [state.rates, state.cod] = await guard(() => Promise.all([db.listRates(), db.listCod()]));
  state.settings = await db.settings();
  // grid[carrier] = { countries: [...], weights: [...], cells: { 'SK|1000': {eur, czk} } }
  const grid = {};
  for (const r of state.rates) {
    const g = grid[r.carrier] ||= { countries: [], weights: [], cells: {} };
    if (!g.countries.includes(r.country)) g.countries.push(r.country);
    if (!g.weights.includes(r.max_weight_g)) g.weights.push(r.max_weight_g);
    g.cells[`${r.country}|${r.max_weight_g}`] = { eur: r.price_eur ?? '', czk: r.price_czk ?? '' };
  }
  for (const r of state.cod || []) {
    const g = grid[r.carrier] ||= { countries: [], weights: [], cells: {} };
    if (!g.countries.includes(r.country)) g.countries.push(r.country);
    (g.cod ||= {})[r.country] = { eur: r.price_eur ?? '', czk: r.price_czk ?? '' };
  }
  if (!Object.keys(grid).length) {
    grid.packeta = { countries: ['SK', 'CZ'], weights: [1000, 5000, 10000], cells: {} };
    grid.dpd = { countries: ['AT', '*'], weights: [2000, 10000], cells: {} };
  }
  for (const g of Object.values(grid)) g.cod ||= {};
  const sortCountries = g => g.countries.sort((a, b) => (a === '*') - (b === '*') || a.localeCompare(b));
  $('#app').innerHTML = `
    <header class="order-head"><div><h1>${t('tr.title')}</h1><p class="muted narrow-text">${t('tr.help')}</p></div></header>
    <section class="card"><label class="inline-label">${t('tr.packaging')}
      <input id="pack-g" type="number" min="0" step="10" class="sm" value="${esc(state.settings.shipping?.packaging_g ?? 0)}"></label>
      <p class="small muted">${t('tr.codes')}</p></section>
    <div id="carriers"></div>
    <div class="row-actions"><select id="new-carrier" aria-label="${t('tr.carrier')}"></select>
      <button id="tr-save" class="primary">${t('tr.save')}</button></div>`;
  const fillCarrierSelect = () => {
    $('#new-carrier').innerHTML = `<option value="">${t('tr.add_carrier')}</option>`
      + carrierKeys().filter(k => k && !grid[k]).map(k => `<option value="${k}">${esc(carrierLabel(k))}</option>`).join('')
      + `<option value="__new">${t('tr.new_carrier')}</option>`;
  };
  const draw = () => {
    fillCarrierSelect();
    $('#carriers').innerHTML = Object.entries(grid).map(([carrier, g]) => {
      sortCountries(g); g.weights.sort((a, b) => a - b);
      return `<section class="card carrier" data-carrier="${esc(carrier)}">
        <h2>${esc(carrierLabel(carrier))} <button class="link danger rm-carrier">${t('tr.remove_carrier')}</button></h2>
        <div class="table-wrap"><table class="matrix"><thead><tr><th>${t('tr.max_kg')}</th>
          ${g.countries.map(c => `<th class="num">${esc(c)} <button class="link danger rm-country" data-c="${esc(c)}" aria-label="${t('items.remove')} ${esc(c)}">✕</button></th>`).join('')}
          <th><button class="link add-country">${t('tr.add_country')}</button></th></tr></thead>
          <tbody>${g.weights.map(w => `<tr data-w="${w}"><th><input class="xs w-in" type="number" step="0.1" min="0.1" value="${w / 1000}" aria-label="${t('tr.max_kg')}"> kg
              <button class="link danger rm-weight" aria-label="${t('items.remove')}">✕</button></th>
            ${g.countries.map(c => { const v = g.cells[`${c}|${w}`] || {}; return `<td class="num cell" data-c="${esc(c)}">
              <input type="number" step="0.1" class="sm" data-cur="eur" value="${esc(v.eur ?? '')}" aria-label="${esc(c)} ${t('tr.up_to', { kg: w / 1000 })} €"> €
              <input type="number" step="5" class="sm" data-cur="czk" value="${esc(v.czk ?? '')}" aria-label="${esc(c)} ${t('tr.up_to', { kg: w / 1000 })} Kč"> Kč</td>`; }).join('')}<td></td></tr>`).join('')}
          </tbody>
          <tfoot><tr class="cod-row"><th>${t('cod.label')}<div class="small muted">${t('cod.row_help')}</div></th>
            ${g.countries.map(c => { const v = g.cod[c] || {}; return `<td class="num cod-cell" data-c="${esc(c)}">
              <input type="number" step="0.1" min="0" class="sm" data-cur="eur" value="${esc(v.eur ?? '')}" aria-label="${t('cod.label')} ${esc(c)} €"> €
              <input type="number" step="5" min="0" class="sm" data-cur="czk" value="${esc(v.czk ?? '')}" aria-label="${t('cod.label')} ${esc(c)} Kč"> Kč</td>`; }).join('')}<td></td></tr></tfoot>
          </table></div>
        <button class="ghost add-weight">${t('tr.add_weight')}</button></section>`;
    }).join('');
    $$('.carrier').forEach(sec => {
      const g = grid[sec.dataset.carrier];
      $$('.cell input', sec).forEach(inp => inp.onchange = () => {
        const w = +inp.closest('tr').dataset.w, c = inp.closest('td').dataset.c;
        const cell = g.cells[`${c}|${w}`] ||= { eur: '', czk: '' };
        cell[inp.dataset.cur] = inp.value === '' ? '' : +inp.value;
      });
      $$('.cod-cell input', sec).forEach(inp => inp.onchange = () => {
        const cell = g.cod[inp.closest('td').dataset.c] ||= { eur: '', czk: '' };
        cell[inp.dataset.cur] = inp.value === '' ? '' : +inp.value;
      });
      $$('.w-in', sec).forEach(inp => inp.onchange = () => {
        const old = +inp.closest('tr').dataset.w, nw = Math.round(+inp.value * 1000);
        if (!nw || g.weights.includes(nw)) { inp.value = old / 1000; return; }
        g.weights[g.weights.indexOf(old)] = nw;
        for (const c of g.countries) { if (g.cells[`${c}|${old}`]) { g.cells[`${c}|${nw}`] = g.cells[`${c}|${old}`]; delete g.cells[`${c}|${old}`]; } }
        draw();
      });
      $$('.rm-weight', sec).forEach(b => b.onclick = () => { const w = +b.closest('tr').dataset.w; g.weights = g.weights.filter(x => x !== w); draw(); });
      $$('.rm-country', sec).forEach(b => b.onclick = () => { g.countries = g.countries.filter(x => x !== b.dataset.c); draw(); });
      $('.rm-carrier', sec).onclick = () => { delete grid[sec.dataset.carrier]; draw(); };
      $('.add-weight', sec).onclick = () => { const max = Math.max(0, ...g.weights); g.weights.push(max + 1000); draw(); };
      $('.add-country', sec).onclick = async () => {
        const code = await askText(t('tr.country_prompt'));
        const c = (code || '').trim().toUpperCase();
        if (c && !g.countries.includes(c)) { g.countries.push(c); draw(); }
      };
    });
  };
  const addCarrier = k => {
    if (!k || grid[k]) return;
    grid[k] = { countries: ['SK', 'CZ'], weights: [1000, 5000], cells: {}, cod: {} };
    draw();
    $(`#carriers section[data-carrier="${k}"]`)?.scrollIntoView({ block: 'center' });
  };
  $('#new-carrier').onchange = async e => {
    let k = e.target.value; e.target.value = '';
    if (k === '__new') {
      const name = ((await askText(t('tr.new_carrier_prompt'), 40)) || '').trim();
      k = carrierSlug(name);
      if (!k) return;
      if (!carrierKeys().includes(k)) {
        state.settings.carriers = [...customCarriers(), { key: k, name }];
        await guard(() => db.saveSetting('carriers', state.settings.carriers));
      }
    }
    addCarrier(k);
  };
  $('#tr-save').onclick = async () => {
    const rows = [];
    for (const [carrier, g] of Object.entries(grid)) for (const c of g.countries) for (const w of g.weights) {
      const v = g.cells[`${c}|${w}`];
      if (v && (v.eur !== '' || v.czk !== '')) rows.push({ carrier, country: c, max_weight_g: w,
        price_eur: v.eur === '' ? null : v.eur, price_czk: v.czk === '' ? null : v.czk });
    }
    const codRows = [];
    for (const [carrier, g] of Object.entries(grid)) for (const c of g.countries) {
      const v = g.cod[c];
      if (v && (v.eur !== '' || v.czk !== '')) codRows.push({ carrier, country: c,
        price_eur: v.eur === '' ? null : v.eur, price_czk: v.czk === '' ? null : v.czk });
    }
    const pack = $('#pack-g').value === '' ? 0 : +$('#pack-g').value;
    await guard(async () => {
      await db.saveRates(rows);
      await db.saveCod(codRows);
      await db.saveSetting('shipping', { ...(state.settings.shipping || {}), packaging_g: pack });
    }, t('tr.saved'));
    state.settings = await db.settings();
    state.rates = await db.listRates();
    state.cod = await db.listCod();
  };
  draw();
}

// Demande au script Google un aperçu ou une publication du formulaire, puis attend la réponse.
async function runFormRequest(kind, payload = null) {
  const id = await guard(() => db.requestSync(state.me?.email, kind, payload));
  if (!id) return null;
  toast(t('cat.form_wait'));
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, i < 3 ? 1500 : 3000));
    const req = await db.getRequest(id).catch(() => null);
    if (req?.done_at) {
      if (req.result?.error) { toast(t('cat.form_error', { error: req.result.error }), 'error'); return null; }
      return req.result;
    }
  }
  toast(t('cat.form_timeout'), 'error');
  return null;
}

function formPreviewDialog(ops) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'wide';
    const line = o => `<li class="op-${o.op}"><span class="tag">${t('cat.op.' + o.op)}</span> <strong>${esc(o.name)}</strong>
      ${o.op === 'update' && o.title !== o.title_before ? `<div class="small"><s>${esc(o.title_before.split('\n')[0])}</s><br>${esc(o.title.split('\n')[0])}</div>` : ''}
      ${o.op === 'create' ? `<div class="small">${esc(o.title)}</div>` : ''}
      ${o.op === 'shipping' ? `<pre class="small ship-help">${esc(o.help)}</pre>` : ''}
      ${o.choices && JSON.stringify(o.choices) !== JSON.stringify(o.choices_before) ? `<div class="small muted">${t('cat.sizes_to', { sizes: esc(o.choices.join(', ')) })}</div>` : ''}</li>`;
    d.innerHTML = `<form method="dialog"><h2>${t('cat.form_title')}</h2><ul class="ops">${ops.map(line).join('')}</ul>
      <p class="small muted">${t('cat.form_help')}</p>
      <div class="actions"><button class="ghost" type="button">${t('dlg.cancel')}</button><button class="primary">${t('cat.form_publish')}</button></div></form>`;
    document.body.append(d);
    const done = v => { d.close(); d.remove(); resolve(v); };
    $('button[type=button]', d).onclick = () => done(false);
    $('form', d).onsubmit = e => { e.preventDefault(); done(true); };
    d.showModal();
  });
}

function askText(label, maxlength = 3) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog"><label>${esc(label)}<input id="ask-input" maxlength="${maxlength}" autocomplete="off"></label>
      <div class="actions"><button class="ghost" value="no" type="button">${t('dlg.cancel')}</button><button class="primary" value="yes">${t('dlg.confirm')}</button></div></form>`;
    document.body.append(d);
    const done = v => { d.close(); d.remove(); resolve(v); };
    $('button[type=button]', d).onclick = () => done(null);
    $('form', d).onsubmit = e => { e.preventDefault(); done($('#ask-input', d).value); };
    d.showModal();
    $('#ask-input', d).focus();
  });
}

function tplEditor(key, tp, open = false) {
  return `<details class="tpl" data-key="${esc(key)}" ${open ? 'open' : ''}><summary>${esc(tp.label || key)}</summary>
    <div class="form-grid">
      <label>${t('set.tpl_name')}<input data-f="label" value="${esc(tp.label || '')}"></label>
      <label>${t('mail.subject')}<input data-f="subject" value="${esc(tp.subject || '')}"></label>
      <label class="span2">${t('mail.body')}<textarea data-f="body" rows="10">${esc(tp.body || '')}</textarea></label>
      <div class="span2"><button class="link danger rm-tpl" type="button">${t('set.tpl_delete')}</button></div>
    </div></details>`;
}

boot().catch(e => { console.error(e); $('#app').innerHTML = `<p class="notice">${esc(t('boot.error', { error: e.message }))}</p>`; });
