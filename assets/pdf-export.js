// Export PDF des commandes : résumé du matériel à préparer, vue d'ensemble, puis une page par commande.
// Le document s'ouvre dans un nouvel onglet et lance l'impression : choisir « Enregistrer au format PDF ».

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL'];
const sizeRank = s => { const i = SIZE_ORDER.indexOf(String(s || '').toUpperCase().trim()); return i < 0 ? 99 : i; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const x = Math.round((+v || 0) * 100) / 100; return x.toLocaleString('sk-SK', { minimumFractionDigits: Number.isInteger(x) ? 0 : 2, maximumFractionDigits: 2 }); };
const eur = v => `${num(v)} €`, czk = v => `${num(v)} Kč`;
const norm = s => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// Regroupe les articles : produit → taille → quantité + n° de commande
export function itemsSummary(orders, items) {
  const byOrder = new Map(orders.map(o => [o.id, o]));
  const products = new Map();
  for (const i of items) {
    const o = byOrder.get(i.order_id); if (!o) continue;
    const name = norm(i.product) || '—', key = name.toLowerCase(), size = norm(i.size);
    if (!products.has(key)) products.set(key, { name, sizes: new Map() });
    const sizes = products.get(key).sizes;
    if (!sizes.has(size)) sizes.set(size, { size, qty: 0, orders: [], missing: 0 });
    const s = sizes.get(size);
    s.qty += +i.qty || 0;
    if (i.missing) s.missing += +i.qty || 0;
    const no = o.order_no ?? `#${o.id}`;
    if (!s.orders.includes(no)) s.orders.push(no);
  }
  return [...products.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'sk'))
    .map(p => ({ name: p.name, sizes: [...p.sizes.values()].sort((a, b) => sizeRank(a.size) - sizeRank(b.size) || a.size.localeCompare(b.size)) }));
}

export function buildPdfHtml(orders, items, { t, fmtDate, shipLabel, payLabel, statusLabel }) {
  orders = [...orders].sort((a, b) => (a.order_no ?? 1e9) - (b.order_no ?? 1e9) || String(a.submitted_at).localeCompare(String(b.submitted_at)));
  const itemsOf = id => items.filter(i => i.order_id === id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id - b.id);
  const nos = orders.map(o => o.order_no).filter(n => n != null);
  const dates = orders.map(o => o.submitted_at).filter(Boolean).sort();
  const totalQty = items.reduce((a, i) => a + (+i.qty || 0), 0);
  const today = fmtDate(new Date().toISOString());
  const range = nos.length ? t('pdf.range', { from: Math.min(...nos), to: Math.max(...nos) }) : '';
  const sub = [range, dates.length ? `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}` : '',
               t('pdf.counts', { orders: orders.length, items: totalQty })].filter(Boolean).join(' · ');
  const box = '<span class="box"></span>';

  // 1. Matériel à préparer
  const summary = itemsSummary(orders, items);
  const prepRows = summary.map(p => {
    const rows = p.sizes.map((s, k) => `<tr class="${k === 0 ? 'first' : ''}">
      <td class="c">${box}</td><td>${k === 0 ? esc(p.name) : ''}</td><td class="c">${esc(s.size || '—')}</td>
      <td class="r b">${s.qty}</td><td>${s.orders.join(', ')}${s.missing ? ` <span class="warn">⚠ ${t('pdf.missing', { n: s.missing })}</span>` : ''}</td></tr>`).join('');
    const tot = p.sizes.length > 1 ? `<tr class="subtotal"><td></td><td>${t('pdf.total_of', { name: esc(p.name) })}</td><td></td>
      <td class="r b">${p.sizes.reduce((a, s) => a + s.qty, 0)}</td><td></td></tr>` : '';
    return rows + tot;
  }).join('');

  // 2. Vue d'ensemble
  const sum = k => orders.reduce((a, o) => a + (+o[k] || 0), 0);
  const overview = orders.map(o => `<tr>
      <td class="b">${esc(o.order_no ?? '—')}</td><td class="nw">${fmtDate(o.submitted_at)}</td><td>${esc(o.customer_name)}</td>
      <td>${esc(o.country)}</td><td>${esc(shipLabel(o))}</td><td>${esc(payLabel(o))}${o.paid ? ' ✓' : ''}</td>
      <td class="r">${o.items_count ?? ''}</td><td class="r">${+o.discount_eur_effective ? eur(o.discount_eur_effective) : ''}</td>
      <td class="r">${o.shipping_unknown ? '?' : eur(o.shipping_eur_effective)}</td><td class="r b">${eur(o.grand_total_eur)}</td></tr>`).join('');

  // 3. Une page par commande
  const pages = orders.map(o => {
    const its = itemsOf(o.id);
    const addr = [o.customer_name, o.company, o.street, [o.postal_code, o.city].filter(Boolean).join(' '), o.country].filter(Boolean);
    const contact = [o.phone && `${t('pdf.phone')}: ${esc(o.phone)}`, o.email && `${t('pdf.email')}: ${esc(o.email)}`,
                     o.social && `${t('pdf.social')}: ${esc(o.social)}`].filter(Boolean);
    const rows = its.map(i => `<tr><td class="c">${box}</td>
        <td>${esc(norm(i.product))}${i.missing ? ` <span class="warn">⚠ ${t('pdf.missing_item')}${i.missing_note ? ' – ' + esc(i.missing_note) : ''}</span>` : ''}</td>
        <td class="c">${esc(norm(i.size) || '—')}</td><td class="r">${i.qty}</td>
        <td class="r">${i.unit_eur != null ? eur(i.unit_eur * i.qty) : '—'}</td><td class="r">${i.unit_czk != null ? czk(i.unit_czk * i.qty) : '—'}</td></tr>`).join('');
    const line = (label, e, c, cls = '') => `<tr class="${cls}"><td></td><td colspan="3">${label}</td><td class="r">${e}</td><td class="r">${c}</td></tr>`;
    return `<section class="page order">
      <h1>${t('pdf.order_no', { no: esc(o.order_no ?? '—') })}</h1>
      <p class="sub">${t('pdf.placed', { date: fmtDate(o.submitted_at, true) })}${o.email ? ' · ' + esc(o.email) : ''} · ${esc(statusLabel(o.status))}</p>
      <div class="cards">
        <div><h3>${t('pdf.address')}</h3><b>${esc(addr[0] || '')}</b><br>${addr.slice(1).map(esc).join('<br>')}</div>
        <div><h3>${t('pdf.contact')}</h3>${contact.join('<br>') || '—'}</div>
        <div class="wide"><h3>${t('pdf.shipping')}</h3><b>${esc(shipLabel(o))}</b> · ${esc(payLabel(o))}${o.paid ? ` · ${t('pdf.paid')} ✓` : ''}
          ${o.shipping_method ? `<br>${t('pdf.form_choice')}: ${esc(o.shipping_method)}` : ''}
          ${o.pickup_point ? `<br>${t('pdf.pickup')}: ${esc(o.pickup_point)}` : ''}
          ${o.tracking_number ? `<br>${t('pdf.tracking')}: ${esc(o.tracking_number)}` : ''}</div>
        ${o.customer_notes ? `<div class="wide"><h3>${t('pdf.note')}</h3>${esc(o.customer_notes)}</div>` : ''}
      </div>
      <h2>${t('pdf.to_prepare')}</h2>
      <table><thead><tr><th class="c">☐</th><th>${t('pdf.item')}</th><th class="c">${t('pdf.size')}</th><th class="r">${t('pdf.qty')}</th>
        <th class="r">${t('pdf.price_eur')}</th><th class="r">${t('pdf.price_czk')}</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          ${+o.discount_eur_effective || +o.discount_czk_effective ? line(t('pdf.discount'), eur(o.discount_eur_effective), czk(o.discount_czk_effective)) : ''}
          ${line(t('pdf.shipping_cost'), o.shipping_unknown ? '?' : eur(o.shipping_eur_effective), o.shipping_unknown ? '?' : czk(o.shipping_czk_effective))}
          <tr class="grand"><td></td><td colspan="2">${t('pdf.order_total')}</td><td class="r">${o.items_count ?? ''}</td>
            <td class="r">${eur(o.grand_total_eur)}</td><td class="r">${czk(o.grand_total_czk)}</td></tr>
        </tfoot></table>
      <p class="checks">${box} ${t('pdf.ck_prepared')} &nbsp; ${o.paid ? '☑' : box} ${t('pdf.ck_paid')} &nbsp; ${box} ${t('pdf.ck_packed')} &nbsp;
        ${box} ${t('pdf.ck_shipped')} — ${t('pdf.tracking')}: ${o.tracking_number ? esc(o.tracking_number) : '____________________'}</p>
    </section>`;
  }).join('');

  const title = nos.length ? `Adacta_orders_${Math.min(...nos)}-${Math.max(...nos)}` : 'Adacta_orders';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    @page { size: A4; margin: 14mm 13mm 16mm;
      @bottom-left { content: "Adacta Merch · ${esc(t('pdf.generated', { date: today }))}"; font: 8pt system-ui, sans-serif; color: #777; }
      @bottom-right { content: counter(page); font: 8pt system-ui, sans-serif; color: #777; } }
    * { box-sizing: border-box; }
    body { font: 9.5pt/1.35 "DejaVu Sans", system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
    h1 { font-size: 20pt; margin: 0 0 2pt; } h2 { font-size: 12pt; margin: 14pt 0 5pt; } h3 { font-size: 8.5pt; margin: 0 0 2pt; }
    .sub { color: #666; margin: 0 0 10pt; } .note { color: #555; font-size: 8.5pt; margin: 0 0 6pt; }
    .page { break-before: page; } .page:first-child { break-before: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; background: #eee; font-size: 8.5pt; padding: 4pt 5pt; border-bottom: 1px solid #999; }
    td { padding: 3pt 5pt; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
    thead { display: table-header-group; } tr { break-inside: avoid; }
    .r { text-align: right; white-space: nowrap; } .nw { white-space: nowrap; } .c { text-align: center; width: 1%; white-space: nowrap; } .b { font-weight: 700; }
    .subtotal td { color: #666; background: #fafafa; } .first td { border-top: 1px solid #bbb; }
    tfoot td { border: 0; } .grand td { font-weight: 700; border-top: 1.5px solid #111; font-size: 10.5pt; }
    .box { display: inline-block; width: 8pt; height: 8pt; border: 1px solid #333; vertical-align: -1pt; }
    .warn { color: #b45309; font-size: 8pt; font-weight: 600; }
    .cards { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #bbb; }
    .cards > div { padding: 5pt 7pt; border-bottom: 1px solid #bbb; } .cards > div:nth-child(odd):not(.wide) { border-right: 1px solid #bbb; }
    .cards > .wide { grid-column: 1 / -1; } .cards > div:last-child { border-bottom: 0; }
    .checks { margin-top: 16pt; }
    .bar { position: sticky; top: 0; background: #fffbe6; border-bottom: 1px solid #e6d690; padding: 8px 14px; font: 13px system-ui, sans-serif; }
    .bar button { font: inherit; padding: 4px 12px; margin-left: 8px; cursor: pointer; }
    @media screen { body { background: #888; } .page { background: #fff; width: 210mm; min-height: 297mm; margin: 12px auto; padding: 14mm 13mm; box-shadow: 0 2px 8px #0004; } }
    @media print { .bar { display: none; } }
  </style></head><body>
    <div class="bar">${t('pdf.hint')} <button onclick="print()">${t('pdf.print')}</button></div>
    <section class="page">
      <h1>${t('pdf.prep_title')}</h1><p class="sub">${sub}</p>
      <table><thead><tr><th class="c">☐</th><th>${t('pdf.item')}</th><th class="c">${t('pdf.size')}</th><th class="r">${t('pdf.qty')}</th><th>${t('pdf.order_nos')}</th></tr></thead>
        <tbody>${prepRows}</tbody>
        <tfoot><tr class="grand"><td></td><td colspan="2">${t('pdf.total_items')}</td><td class="r">${totalQty}</td><td></td></tr></tfoot></table>
    </section>
    <section class="page">
      <h1>${t('pdf.overview')}</h1><p class="sub">${sub}</p>
      <table><thead><tr><th>${t('pdf.no')}</th><th>${t('pdf.date')}</th><th>${t('pdf.customer')}</th><th>${t('pdf.country')}</th><th>${t('pdf.shipping')}</th>
        <th>${t('pdf.payment')}</th><th class="r">${t('pdf.qty')}</th><th class="r">${t('pdf.discount')}</th><th class="r">${t('pdf.shipping_cost')}</th><th class="r">${t('pdf.total')}</th></tr></thead>
        <tbody>${overview}</tbody>
        <tfoot><tr class="grand"><td></td><td colspan="5">${t('pdf.total')}</td><td class="r">${sum('items_count')}</td>
          <td class="r">${eur(sum('discount_eur_effective'))}</td><td class="r">${eur(orders.reduce((a, o) => a + (o.shipping_unknown ? 0 : +o.shipping_eur_effective || 0), 0))}</td>
          <td class="r">${eur(sum('grand_total_eur'))}</td></tr></tfoot></table>
    </section>
    ${pages}
    <script>addEventListener('load', () => setTimeout(() => print(), 300));</script>
  </body></html>`;
}
