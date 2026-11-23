// Couche d'accès aux données : Supabase en production, données fictives en mode démo.
import { DEMO_ORDERS, DEMO_SETTINGS, DEMO_PRODUCTS, DEMO_RATES, DEMO_CATEGORIES, DEMO_COD } from './demo-data.js';

const cfg = window.ADACTA_CONFIG || {};
export const DEMO = !cfg.supabaseUrl || !cfg.supabaseAnonKey;

export const ORDER_COLUMNS = 'id,order_no,submitted_at,email,first_name,last_name,customer_name,country,city,' +
  'shipping_method,pickup_point,status,paid,carrier,tracking_number,items_count,items_summary,' +
  'subtotal_eur,subtotal_czk,discount_eur_effective,discount_czk_effective,total_eur,total_czk,' +
  'customer_notes,internal_notes,shipped_at,missing_count,country_code,weight_g,weight_unknown,shipping_eur,shipping_czk,' +
  'shipping_eur_effective,shipping_czk_effective,shipping_unknown,grand_total_eur,grand_total_czk,cod,cod_effective,cod_eur,cod_czk';

// ---------------------------------------------------------------------
// Calcul des totaux (identique à la vue SQL orders_view, utilisé en démo)
// ---------------------------------------------------------------------
export function autoDiscount(items, rules) {
  let eur = 0, czk = 0;
  for (const it of items) {
    const name = (it.product || '').toLowerCase();
    const r = (rules || []).find(r => (r.match || []).every(m => name.includes(String(m).toLowerCase())));
    if (r) { eur -= it.qty * (r.eur || 0); czk -= it.qty * (r.czk || 0); }
  }
  return { eur, czk };
}

// Même règles que la fonction SQL country_code()
const COUNTRY_RULES = [
  ['SK', /(slovensk|slovak|zlovensk|^\s*(sk|svk)\s*$)/i], ['CZ', /(česk|cesk|czech|^\s*(cz|cr|čr|cze)\s*$)/i],
  ['AT', /(rakús|rakus|rakous|austria|österreich|osterreich|^\s*at\s*$)/i], ['HU', /(maďar|madar|hungar|magyar|^\s*hu\s*$)/i],
  ['PL', /(poľsk|polsk|poland|^\s*pl\s*$)/i], ['DE', /(nemeck|němec|nemec|german|deutschland|^\s*de\s*$)/i],
  ['FR', /(franc|^\s*fr\s*$)/i]];
export const countryCode = c => (COUNTRY_RULES.find(([, re]) => re.test(c || '')) || ['*'])[0];
export const effectiveCarrier = o => o.carrier || (/osobn|odber|odovzd/i.test(o.shipping_method || '') ? 'main_propre' : /dpd/i.test(o.shipping_method || '') ? 'dpd' : /packeta/i.test(o.shipping_method || '') ? 'packeta' : '');

/** Poids du colis et tarif de la grille Transport (identique à la vue SQL). */
export function shippingQuote(o, items, ctx = {}) {
  const byName = Object.fromEntries((ctx.products || []).map(p => [p.name.toLowerCase(), p]));
  let weight = +(ctx.shipping?.packaging_g || 0), unknown = false;
  for (const i of items) {
    const p = byName[(i.product || '').toLowerCase()];
    if (!p || p.weight_g == null || p.weight_g === '') unknown = true; else weight += (+i.qty || 0) * p.weight_g;
  }
  const carrier = effectiveCarrier(o), cc = countryCode(o.country);
  const rate = (ctx.rates || []).filter(r => r.carrier === carrier && (r.country === cc || r.country === '*') && r.max_weight_g >= weight)
    .sort((a, b) => (a.country === '*') - (b.country === '*') || a.max_weight_g - b.max_weight_g)[0];
  // dobierka : case de la commande, sinon déduite du mode de livraison (« … dobierkou »)
  const cod = o.cod ?? (/dobierk|cash on delivery|\bcod\b/i.test(o.shipping_method || '') || cc === 'SK' || cc === 'CZ');
  const fee = (ctx.cod || []).filter(r => r.carrier === carrier && (r.country === cc || r.country === '*'))
    .sort((a, b) => (a.country === '*') - (b.country === '*'))[0];
  return { weight_g: weight, weight_unknown: unknown && items.length > 0, country_code: cc, rate, cod,
           cod_eur: cod ? +(fee?.price_eur || 0) : 0, cod_czk: cod ? +(fee?.price_czk || 0) : 0 };
}

export function computeView(o, items, rules, ctx = {}) {
  const d = autoDiscount(items, rules);
  const sub = items.reduce((a, i) => a + i.qty * (+i.unit_eur || 0), 0);
  const subCzk = items.reduce((a, i) => a + i.qty * (+i.unit_czk || 0), 0);
  const de = o.discount_eur ?? d.eur, dc = o.discount_czk ?? d.czk;
  const q = shippingQuote(o, items, ctx);
  const se = o.shipping_eur ?? (+(q.rate?.price_eur ?? 0) + q.cod_eur), sc = o.shipping_czk ?? (+(q.rate?.price_czk ?? 0) + q.cod_czk);
  return {
    ...o,
    country_code: q.country_code, weight_g: q.weight_g, weight_unknown: q.weight_unknown,
    shipping_eur_effective: +se, shipping_czk_effective: +sc,
    cod_effective: q.cod, cod_eur: q.cod_eur, cod_czk: q.cod_czk,
    shipping_unknown: o.shipping_eur == null && !q.rate && effectiveCarrier(o) !== 'main_propre',
    grand_total_eur: sub + de + +se, grand_total_czk: subCzk + dc + +sc,
    items_count: items.reduce((a, i) => a + i.qty, 0),
    subtotal_eur: sub, subtotal_czk: subCzk,
    discount_eur_effective: de, discount_czk_effective: dc,
    total_eur: sub + de, total_czk: subCzk + dc,
    customer_name: `${o.first_name || ''} ${o.last_name || ''}`.trim(),
    missing_count: items.filter(i => i.missing).reduce((a, i) => a + i.qty, 0),
    items_summary: items.map(i => i.product + (i.size ? ' ' + i.size : '') + (i.qty > 1 ? ' ×' + i.qty : '')).join(' · ')
  };
}

// ---------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------
// Photo réduite avant envoi (1200 px max, JPEG) : économise le stockage gratuit de Supabase.
export async function resizeImage(file, max = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  } finally { URL.revokeObjectURL(url); }
}

const productRow = r => ({
  name: r.name.trim(), price_eur: r.price_eur === '' ? null : r.price_eur, price_czk: r.price_czk === '' ? null : r.price_czk,
  sizes: r.textile ? (r.sizes || []) : [], girly_sizes: r.textile ? (r.girly_sizes || []) : [],
  weight_g: r.weight_g === '' ? null : r.weight_g, active: !!r.active, sold_out: !!r.sold_out,
  category_id: r.category_id || null, type: r.type || null, textile: !!r.textile, photos: r.photos || [],
  updated_at: new Date().toISOString()
});

let sb = null;
if (!DEMO) sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

const real = {
  async session() { return (await sb.auth.getSession()).data.session; },
  onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s)); },
  async signInEmail(email) {
    check(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } }));
  },
  async signInGoogle() {
    check(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }));
  },
  async signOut() { await sb.auth.signOut(); },
  async me(email) {
    const rows = check(await sb.from('allowed_emails').select('email,role').eq('email', email.toLowerCase()));
    return rows[0] || null;
  },
  async listOrders() {
    // la vue renvoie au plus 1000 lignes par requête : on pagine
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = check(await sb.from('orders_view').select(ORDER_COLUMNS)
        .order('submitted_at', { ascending: false }).range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  },
  async getOrder(id) {
    const [o, items, history, emails] = await Promise.all([
      sb.from('orders_view').select('*').eq('id', id).single(),
      sb.from('order_items').select('*').eq('order_id', id).order('position').order('id'),
      sb.from('status_history').select('*').eq('order_id', id).order('changed_at', { ascending: false }),
      sb.from('email_outbox').select('*').eq('order_id', id).order('created_at', { ascending: false })
    ]);
    return { order: check(o), items: check(items), history: check(history), emails: check(emails) };
  },
  async createOrder(fields) {
    return check(await sb.from('orders').insert(fields).select('id').single()).id;
  },
  async updateOrders(ids, patch) {
    check(await sb.from('orders').update(patch).in('id', ids));
  },
  async deleteOrder(id) { check(await sb.from('orders').delete().eq('id', id)); },
  async saveItems(orderId, items, removedIds) {
    if (removedIds.length) check(await sb.from('order_items').delete().in('id', removedIds));
    for (const [pos, it] of items.entries()) {
      const row = { order_id: orderId, product: it.product, size: it.size || null, qty: +it.qty || 1,
                    unit_eur: it.unit_eur === '' ? null : it.unit_eur, unit_czk: it.unit_czk === '' ? null : it.unit_czk,
                    prepared: !!it.prepared, missing: !!it.missing, missing_note: it.missing_note || null, position: pos };
      if (it.id) check(await sb.from('order_items').update(row).eq('id', it.id));
      else check(await sb.from('order_items').insert(row));
    }
  },
  async setItemPrepared(itemId, prepared) {
    check(await sb.from('order_items').update({ prepared }).eq('id', itemId));
  },
  async listItems(orderIds) {
    const out = [];
    for (let i = 0; i < orderIds.length; i += 200) {
      out.push(...check(await sb.from('order_items').select('*').in('order_id', orderIds.slice(i, i + 200))));
    }
    return out;
  },
  async settings() {
    const rows = check(await sb.from('settings').select('key,value'));
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },
  async saveSetting(key, value) {
    check(await sb.from('settings').upsert({ key, value, updated_at: new Date().toISOString() }));
  },
  async listProducts() { return check(await sb.from('products').select('*').order('name')); },
  async saveProducts(rows, removedIds) {
    if (removedIds.length) check(await sb.from('products').delete().in('id', removedIds));
    const clean = r => ({ name: r.name.trim(), price_eur: r.price_eur === '' ? null : r.price_eur, price_czk: r.price_czk === '' ? null : r.price_czk,
                          sizes: r.sizes, weight_g: r.weight_g === '' ? null : r.weight_g, active: !!r.active, sold_out: !!r.sold_out,
                          updated_at: new Date().toISOString() });
    for (const r of rows) {
      if (r.id) check(await sb.from('products').update(clean(r)).eq('id', r.id));
      else check(await sb.from('products').insert(clean(r)));
    }
  },
  async saveProduct(r) {
    if (r.id) { check(await sb.from('products').update(productRow(r)).eq('id', r.id)); return r.id; }
    return check(await sb.from('products').insert(productRow(r)).select('id').single()).id;
  },
  async deleteProduct(id) { check(await sb.from('products').delete().eq('id', id)); },
  async uploadPhoto(file) {
    const blob = await resizeImage(file);
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.jpg`;
    check(await sb.storage.from('product-photos').upload(path, blob, { contentType: 'image/jpeg' }));
    return sb.storage.from('product-photos').getPublicUrl(path).data.publicUrl;
  },
  async deletePhoto(url) {
    const path = String(url).split('/product-photos/')[1];
    if (path) check(await sb.storage.from('product-photos').remove([decodeURIComponent(path)]));
  },
  async listCategories() { return check(await sb.from('categories').select('*').order('position').order('name')); },
  async saveCategory(c) {
    const row = { name: c.name.trim(), parent_id: c.parent_id || null, position: c.position ?? 0 };
    if (c.id) { check(await sb.from('categories').update(row).eq('id', c.id)); return c.id; }
    return check(await sb.from('categories').insert(row).select('id').single()).id;
  },
  async deleteCategory(id) { check(await sb.from('categories').delete().eq('id', id)); },
  async listCod() { return check(await sb.from('cod_fees').select('*').order('carrier').order('country')); },
  async saveCod(rows) {
    check(await sb.from('cod_fees').delete().gt('id', 0));
    if (rows.length) check(await sb.from('cod_fees').insert(rows));
  },
  async listRates() { return check(await sb.from('shipping_rates').select('*').order('carrier').order('country').order('max_weight_g')); },
  async saveRates(rows) {
    check(await sb.from('shipping_rates').delete().gt('id', 0));
    if (rows.length) check(await sb.from('shipping_rates').insert(rows));
  },
  async listAllowed() { return check(await sb.from('allowed_emails').select('*').order('email')); },
  async addAllowed(email, role) { check(await sb.from('allowed_emails').upsert({ email: email.toLowerCase().trim(), role })); },
  async removeAllowed(email) { check(await sb.from('allowed_emails').delete().eq('email', email)); },
  async queueEmails(rows) { check(await sb.from('email_outbox').insert(rows)); },
  async cancelEmail(id) { check(await sb.from('email_outbox').update({ status: 'cancelled' }).eq('id', id).eq('status', 'pending')); },
  async requestSync(email, kind = 'sync', payload = null) { return check(await sb.from('sync_requests').insert({ requested_by: email, kind, payload }).select('id').single()).id; },
  async getRequest(id) { return check(await sb.from('sync_requests').select('*').eq('id', id).single()); },
  async lastSync() {
    const rows = check(await sb.from('sync_requests').select('*').eq('kind', 'sync').order('id', { ascending: false }).limit(1));
    return rows[0] || null;
  },
  async pendingEmailCount() {
    const { count, error } = await sb.from('email_outbox').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    if (error) throw error;
    return count || 0;
  }
};

// ---------------------------------------------------------------------
// Mode démo : tout reste dans le navigateur
// ---------------------------------------------------------------------
// même règle que formTitle() du script Google : séparateur et lignes d'explication gardés
const demoFormTitle = (p, old = p.form_title || '') => {
  const lines = String(old).split('\n'), sep = (lines[0].match(/\s([|\-–])\s*\d+(?:[.,]\d+)?\s*(?:eur|€)/i) || [])[1] || '-';
  const t = (p.sold_out ? 'SOLD OUT! ' : '') + p.name +
    (p.price_eur != null && p.price_eur !== '' ? ` ${sep} ${p.price_eur} eur` + (p.price_czk != null && p.price_czk !== '' ? ` / ${p.price_czk} Kč` : '') : '');
  return [t, ...lines.slice(1)].join('\n');
};
// démo : photos du Google Form chargées seulement en mode démo
let demoPhotosLoaded = false;
async function loadDemoPhotos() {
  if (demoPhotosLoaded) return;
  demoPhotosLoaded = true;
  const { DEMO_PHOTOS, DEMO_FORM_HEADER } = await import('./demo-photos.js');
  for (const p of store.products) if (!p.photos.length && DEMO_PHOTOS[p.name]) p.photos = [DEMO_PHOTOS[p.name]];
  store.settings.google_form = { ...store.settings.google_form, header_image: DEMO_FORM_HEADER };
}
const store = {
  // démo : numérotation continue jusqu'à 673, comme les vraies commandes (la suivante sera 674)
  orders: (() => { let n = 673 - DEMO_ORDERS.length;
    return [...DEMO_ORDERS].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))
      .map(o => ({ ...o, items: undefined, order_no: ++n })); })(),
  items: DEMO_ORDERS.flatMap(o => o.items.map((it, i) => ({ ...it, id: o.id * 100 + i, order_id: o.id, position: i, prepared: false }))),
  history: DEMO_ORDERS.map((o, i) => ({ id: i + 1, order_id: o.id, old_status: null, new_status: o.status, changed_by: 'import', changed_at: o.submitted_at })),
  emails: [], settings: structuredClone(DEMO_SETTINGS),
  allowed: [{ email: 'demo@adacta.sk', role: 'admin' }, { email: 'membre@adacta.sk', role: 'member' }],
  products: DEMO_PRODUCTS.map(p => ({ ...p, form_title: p.form_title || (p.from_form ? demoFormTitle(p) : null),
    form_choices: p.textile ? [...p.sizes, ...p.girly_sizes.map(x => 'Girly ' + x)] : null })), rates: structuredClone(DEMO_RATES), cod: structuredClone(DEMO_COD), requests: {}, categories: structuredClone(DEMO_CATEGORIES),
  sync: null, seq: 100000
};
// exemple d'article manquant pour la démo
for (const [orderId, note] of [[22, 'Objednané u výrobcu, príde ~5. 12.'], [19, '']]) {
  const it = store.items.find(i => i.order_id === orderId);
  if (it) Object.assign(it, { missing: true, missing_note: note, missing_since: new Date(Date.now() - 2 * 86400000).toISOString() });
}
const viewOf = o => computeView(o, store.items.filter(i => i.order_id === o.id), store.settings.discount_rules,
  { products: store.products, rates: store.rates, shipping: store.settings.shipping });

const demo = {
  async session() { return { user: { email: 'demo@adacta.sk' } }; },
  onAuth() {},
  async signInEmail() {}, async signInGoogle() {}, async signOut() { location.reload(); },
  async me() { return store.allowed[0]; },
  async listOrders() { return store.orders.map(viewOf).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)); },
  async getOrder(id) {
    const o = store.orders.find(o => o.id === +id);
    if (!o) throw new Error('Commande introuvable');
    return {
      order: viewOf(o),
      items: store.items.filter(i => i.order_id === o.id).sort((a, b) => a.position - b.position),
      history: store.history.filter(h => h.order_id === o.id).sort((a, b) => b.id - a.id),
      emails: store.emails.filter(e => e.order_id === o.id).sort((a, b) => b.id - a.id)
    };
  },
  async createOrder(fields) {
    const id = ++store.seq;
    const order_no = fields.order_no || Math.max(673, ...store.orders.map(o => o.order_no || 0)) + 1;
    store.orders.push({ status: 'non_traitee', paid: false, submitted_at: new Date().toISOString(), ...fields, order_no, id });
    store.history.push({ id: ++store.seq, order_id: id, new_status: fields.status || 'non_traitee', changed_by: 'demo@adacta.sk', changed_at: new Date().toISOString() });
    return id;
  },
  async updateOrders(ids, patch) {
    for (const o of store.orders.filter(o => ids.includes(o.id))) {
      if (patch.order_no && store.orders.some(x => x.order_no === +patch.order_no && x.id !== o.id))
        throw new Error('duplicate key value violates unique constraint "orders_order_no_key"');
      if (patch.status && patch.status !== o.status) {
        store.history.push({ id: ++store.seq, order_id: o.id, old_status: o.status, new_status: patch.status, changed_by: 'demo@adacta.sk', changed_at: new Date().toISOString() });
        if (patch.status === 'envoyee' && !o.shipped_at) o.shipped_at = new Date().toISOString();
      }
      Object.assign(o, patch);
    }
  },
  async deleteOrder(id) { store.orders = store.orders.filter(o => o.id !== id); },
  async saveItems(orderId, items, removedIds) {
    store.items = store.items.filter(i => !removedIds.includes(i.id));
    items.forEach((it, pos) => {
      const row = { ...it, order_id: orderId, position: pos, qty: +it.qty || 1,
                    unit_eur: it.unit_eur === '' ? null : +it.unit_eur, unit_czk: it.unit_czk === '' ? null : +it.unit_czk,
                    missing: !!it.missing, missing_note: it.missing_note || null,
                    missing_since: it.missing ? (it.missing_since || new Date().toISOString()) : null };
      if (it.id) Object.assign(store.items.find(i => i.id === it.id), row);
      else store.items.push({ ...row, id: ++store.seq });
    });
  },
  async setItemPrepared(itemId, prepared) { store.items.find(i => i.id === itemId).prepared = prepared; },
  async listItems(orderIds) { return store.items.filter(i => orderIds.includes(i.order_id)); },
  async settings() { await loadDemoPhotos(); return structuredClone(store.settings); },
  async saveSetting(key, value) { store.settings[key] = value; },
  async listProducts() { await loadDemoPhotos(); return structuredClone(store.products).sort((a, b) => a.name.localeCompare(b.name)); },
  async saveProducts(rows, removedIds) {
    store.products = store.products.filter(p => !removedIds.includes(p.id));
    for (const r of rows) {
      const row = { ...r, price_eur: r.price_eur === '' ? null : +r.price_eur, price_czk: r.price_czk === '' ? null : +r.price_czk,
                    weight_g: r.weight_g === '' ? null : +r.weight_g };
      if (r.id) Object.assign(store.products.find(p => p.id === r.id), row); else store.products.push({ ...row, id: ++store.seq });
    }
  },
  async saveProduct(r) {
    const row = { ...productRow(r), price_eur: r.price_eur === '' ? null : +r.price_eur, price_czk: r.price_czk === '' ? null : +r.price_czk,
                  weight_g: r.weight_g === '' || r.weight_g == null ? null : +r.weight_g };
    if (store.products.some(p => p.id !== r.id && p.name.toLowerCase() === row.name.toLowerCase())) throw new Error('duplicate key value violates unique constraint "products_name_key"');
    if (r.id) { Object.assign(store.products.find(p => p.id === r.id), row); return r.id; }
    const id = ++store.seq; store.products.push({ from_form: false, ...row, id }); return id;
  },
  async deleteProduct(id) { store.products = store.products.filter(p => p.id !== id); },
  async uploadPhoto(file) {   // démo : la photo reste dans la page (rien n'est envoyé)
    const blob = await resizeImage(file, 800);
    return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  },
  async deletePhoto() {},
  async listCategories() { return structuredClone(store.categories).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)); },
  async saveCategory(c) {
    const depth = id => { let d = 0; for (let x = store.categories.find(k => k.id === id); x; x = store.categories.find(k => k.id === x.parent_id)) d++; return d; };
    if (c.parent_id && depth(c.parent_id) >= 3) throw new Error('3 niveaux de catégories au maximum');
    if (c.id) { Object.assign(store.categories.find(k => k.id === c.id), { name: c.name.trim(), parent_id: c.parent_id || null }); return c.id; }
    const id = ++store.seq;
    store.categories.push({ id, name: c.name.trim(), parent_id: c.parent_id || null, position: c.position ?? 99 });
    return id;
  },
  async deleteCategory(id) {
    if (store.categories.some(k => k.parent_id === id)) throw new Error('violates foreign key constraint "categories_parent_id_fkey"');
    store.categories = store.categories.filter(k => k.id !== id);
    for (const p of store.products) if (p.category_id === id) p.category_id = null;
  },
  async listRates() { return structuredClone(store.rates); },
  async listCod() { return structuredClone(store.cod); },
  async saveCod(rows) { store.cod = rows.map(r => ({ ...r, id: ++store.seq })); },
  async saveRates(rows) { store.rates = rows.map(r => ({ ...r, id: ++store.seq })); },
  async listAllowed() { return [...store.allowed]; },
  async addAllowed(email, role) {
    email = email.toLowerCase().trim();
    store.allowed = store.allowed.filter(a => a.email !== email).concat({ email, role });
  },
  async removeAllowed(email) { store.allowed = store.allowed.filter(a => a.email !== email); },
  async queueEmails(rows) {
    for (const r of rows) {
      const e = { ...r, id: ++store.seq, status: 'pending', created_at: new Date().toISOString(), requested_by: 'demo@adacta.sk' };
      store.emails.push(e);
      setTimeout(() => { if (e.status === 'pending') { e.status = 'sent'; e.sent_at = new Date().toISOString(); } }, 4000);
    }
  },
  async cancelEmail(id) { const e = store.emails.find(e => e.id === id); if (e && e.status === 'pending') e.status = 'cancelled'; },
  async requestSync(email, kind = 'sync', payload = null) {
    if (kind === 'form_header') {   // démo : en-tête du formulaire
      const req = { id: ++store.seq, kind, payload, created_at: new Date().toISOString(), done_at: null };
      store.requests[req.id] = req;
      setTimeout(() => {
        Object.assign(store.settings.google_form, { title: payload.title, description: payload.description });
        req.done_at = new Date().toISOString(); req.result = { applied: true, title: payload.title };
      }, 2000);
      return req.id;
    }
    if (kind !== 'sync') {
      // démo : le « script » compare le Katalóg au formulaire (titres et tailles)
      const req = { id: ++store.seq, kind, created_at: new Date().toISOString(), done_at: null };
      store.requests[req.id] = req;
      setTimeout(() => {
        const ops = [];
        const sizesOf = p => p.textile ? [...(p.sizes || []), ...(p.girly_sizes || []).map(x => 'Girly ' + x)] : null;
        for (const p of store.products) {
          const title = demoFormTitle(p), choices = sizesOf(p), before = p.form_choices || null;
          const sizesChanged = choices && JSON.stringify(choices) !== JSON.stringify(before);
          if (!p.active && p.from_form) ops.push({ op: 'remove', name: p.name, title_before: p.form_title || title });
          else if (p.active && !p.from_form) ops.push({ op: 'create', name: p.name, title, choices });
          else if (p.active && (p.form_title && p.form_title !== title || sizesChanged))
            ops.push({ op: 'update', name: p.name, title_before: p.form_title, title, choices: sizesChanged ? choices : null, choices_before: before });
        }
        if (kind === 'form_publish') for (const p of store.products) {
          if (!p.active && p.from_form) { p.from_form = false; p.form_title = null; p.form_choices = null; }
          else if (p.active) { p.from_form = true; p.form_title = demoFormTitle(p); p.form_choices = sizesOf(p); }
        }
        const count = op => ops.filter(o => o.op === op).length;
        req.done_at = new Date().toISOString();
        req.result = { applied: kind === 'form_publish', ops, update: count('update'), create: count('create'), remove: count('remove') };
      }, 2500);
      return req.id;
    }
    store.sync = { id: ++store.seq, created_at: new Date().toISOString(), done_at: null };
    setTimeout(() => { store.sync.done_at = new Date().toISOString(); store.sync.result = { rows: store.orders.length, created: 0, order_numbers: 0 }; }, 3000);
    return store.sync.id;
  },
  async getRequest(id) { return structuredClone(store.requests[id]); },
  async lastSync() { return store.sync && { ...store.sync }; },
  async pendingEmailCount() { return store.emails.filter(e => e.status === 'pending').length; }
};

export const db = DEMO ? demo : real;
