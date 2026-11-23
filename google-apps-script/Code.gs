/**
 * Adacta Merch · Suivi des commandes · script Google Apps Script
 *
 * À installer sur le compte Google adactaband666@gmail.com (voir README).
 * Ce script :
 *   1. importe les réponses du Google Form (Google Sheet) dans Supabase ;
 *   2. (ancien fonctionnement, désactivé par défaut) retrouve les N° de commande dans
 *      les mails « Merch order N°… ». Désormais, la base numérote elle-même les
 *      nouvelles commandes à la suite (674, 675…) ;
 *   3. envoie, depuis ce compte Gmail, les mails préparés sur le site.
 *
 * Propriétés du script (Paramètres du projet > Propriétés du script) :
 *   SUPABASE_URL        https://xxxx.supabase.co
 *   SUPABASE_SECRET_KEY clé « secret » (ou « service_role ») du projet Supabase
 *   SHEET_ID            identifiant du Google Sheet des réponses
 *   SHEET_NAME          (optionnel) nom de l'onglet, par défaut le premier
 *   GMAIL_QUERY         (optionnel) recherche Gmail des mails de commande
 *   IMPORT_FROM         (optionnel) AAAA-MM-JJ, par défaut 2026-09-15 : les réponses
 *                       plus anciennes ne sont pas importées
 *   ARCHIVE_BEFORE      (optionnel) AAAA-MM-JJ : les réponses plus anciennes
 *                       sont importées avec le statut « livrée »
 *   GMAIL_ORDER_NUMBERS (optionnel) « true » pour relire les N° dans les mails
 *                       « Merch order N° » (ancien module d'envoi). Laisser vide.
 */

var DEFAULT_IMPORT_FROM = '2026-09-15';

// ---------------------------------------------------------------------
// Lecture des colonnes du formulaire (fonctions pures, testées hors Google)
// ---------------------------------------------------------------------

var FIELD_PATTERNS = [
  [/^(horodateur|timestamp|horodatage)/i, 'submitted_at'],
  [/^(adresse e-mail|adresse email|email address|e-mail)/i, 'email'],
  [/^order\s*n/i, 'order_no'],
  [/^pod[aá]n/i, 'sheet_status'],
  [/^name\b/i, 'first_name'],
  [/^surname\b/i, 'last_name'],
  [/^company\b/i, 'company'],
  [/^street\b/i, 'street'],
  [/^postal\b/i, 'postal_code'],
  [/^city\b/i, 'city'],
  [/^country\b/i, 'country'],
  [/^phone\b/i, 'phone'],
  [/social media/i, 'social'],
  [/^doru[cč]enie|^delivery\b|^shipping\b/i, 'shipping_method'],
  [/^packeta\b/i, 'pickup_point'],
  [/^notes?\b/i, 'customer_notes'],
  [/^(column|colonne)\s*\d+$/i, '_ignore'],
  [/^amount$/i, '_ignore']
];

var SIZE_RE = /^((girly|women'?s?|dámske|damske)\s*[-:]?\s*)?(XXS|XS|S|M|L|XL|XXL|XXXL|XXXXL|[2-5]XL|unisize|one size|uni)$/i;
var SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL', 'Unisize'];

/** « xxxl » → « 3XL », « one size » → « Unisize », « Girly m » → « Girly M » ; null si ce n'est pas une taille. */
function normSize(value) {
  var m = String(value == null ? '' : value).trim().match(SIZE_RE);
  if (!m) return null;
  var base = m[3].toUpperCase();
  base = { XXXL: '3XL', XXXXL: '4XL', '2XL': 'XXL', UNISIZE: 'Unisize', 'ONE SIZE': 'Unisize', UNI: 'Unisize' }[base] || base;
  return (m[1] ? 'Girly ' : '') + base;
}
function sizeRank_(s) { var g = /^Girly /.test(s); var i = SIZE_ORDER.indexOf(s.replace(/^Girly /, '')); return (g ? 100 : 0) + (i < 0 ? 50 : i); }

function classifyHeader(header) {
  var h = String(header || '').trim();
  if (!h) return { field: '_ignore' };
  for (var i = 0; i < FIELD_PATTERNS.length; i++) {
    if (FIELD_PATTERNS[i][0].test(h)) return { field: FIELD_PATTERNS[i][1] };
  }
  return { field: '_item', product: parseProductHeader(h) };
}

/** « Misanthropunk t-shirt - 18 eur / 450 Kč » → {name, eur, czk} */
function parseProductHeader(header) {
  var full = String(header);
  var line = full.split('\n')[0];
  line = line.replace(/\[[^\]]*\]\s*$/, '');
  line = line.replace(/^\s*SOLD OUT!?\s*\|?\s*/i, '').trim();
  var m = line.match(/\s*[-|–]\s*(\d+(?:[.,]\d+)?)\s*(?:eur|€)(?:\s*\/\s*(\d+)\s*K[čc])?/i);
  var name = line, eur = null, czk = null;
  if (m) {
    name = line.slice(0, m.index).trim();
    eur = parseFloat(m[1].replace(',', '.'));
    czk = m[2] ? parseInt(m[2], 10) : null;
  }
  return { name: name.replace(/\s+/g, ' '), eur: eur, czk: czk };
}

/** Valeur d'une cellule article → liste d'articles {size, qty} */
function parseItemCell(value) {
  var v = String(value == null ? '' : value).trim();
  if (!v) return [];
  if (/^\d+$/.test(v)) return [{ size: null, qty: parseInt(v, 10) }];
  return v.split(/\s*[,;]\s*/).filter(String).map(function (part) {
    return { size: normSize(part), qty: 1 };
  });
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  var s = String(value || '').trim();
  // « 16/11/2026 07:15:06 » (heure de Bratislava si aucune zone n'est donnée)
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    var pad = function (x) { return ('0' + x).slice(-2); };
    return m[3] + '-' + pad(m[2]) + '-' + pad(m[1]) + 'T' + pad(m[4]) + ':' + m[5] + ':' + (m[6] || '00') + '+01:00';
  }
  return s || null;
}

function statusFromSheet(sheetStatus, submittedIso, archiveBefore) {
  var s = String(sheetStatus || '').trim();
  if (/^(ano|yes|oui)/i.test(s)) return 'envoyee';
  if (s) return 'en_attente';
  if (archiveBefore && submittedIso && submittedIso.slice(0, 10) < archiveBefore) return 'livree';
  return 'non_traitee';
}

/** Lignes du Sheet (1re ligne = en-têtes) → commandes prêtes pour import_order() */
function parseSheet(rows, options) {
  options = options || {};
  var headers = rows[0].map(classifyHeader);
  var orders = [];
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    var o = { items: [], raw: {} };
    var hasContent = false;
    for (var c = 0; c < headers.length; c++) {
      var cell = row[c];
      var text = cell instanceof Date ? cell.toISOString() : String(cell == null ? '' : cell).trim();
      if (!text) continue;
      hasContent = true;
      o.raw[String(rows[0][c]).split('\n')[0]] = text;
      var h = headers[c];
      if (h.field === '_ignore') continue;
      if (h.field === '_item') {
        parseItemCell(text).forEach(function (it) {
          o.items.push({ product: h.product.name, size: it.size, qty: it.qty,
                         unit_eur: h.product.eur, unit_czk: h.product.czk });
        });
      } else if (h.field === 'submitted_at') {
        o.submitted_at = toIso(cell);
      } else if (h.field === 'order_no') {
        var n = parseInt(text, 10);
        if (!isNaN(n)) o.order_no = n;
      } else if (!o[h.field]) {
        o[h.field] = text;
      }
    }
    if (!hasContent || !o.submitted_at) continue;
    if (options.importFromMs && new Date(o.submitted_at).getTime() < options.importFromMs) continue;
    o.email = (o.email || '').toLowerCase();
    o.source_key = o.submitted_at + '|' + o.email;
    o.status = statusFromSheet(o.sheet_status, o.submitted_at, options.archiveBefore);
    orders.push(o);
  }
  return orders;
}

/**
 * Catalogue : un article par intitulé de colonne (nom + prix), avec les tailles
 * vues dans les réponses. formItems (facultatif) = articles lus dans le Google Form :
 * { "Raven T-Shirt": ["S","M",…] } ; seuls ceux-là sont alors « actifs ».
 */
function buildCatalog(rows, formItems, now) {
  now = now ? new Date(now) : new Date();
  var yearAgo = new Date(now.getTime() - 365 * 86400000).toISOString();
  var headers = rows[0];
  var byName = {};
  for (var c = 0; c < headers.length; c++) {
    var h = classifyHeader(headers[c]);
    if (h.field !== '_item' || h.product.eur == null) continue;
    var name = h.product.name;
    var soldOut = /SOLD OUT/i.test(String(headers[c]));
    var p = byName[name] || (byName[name] = { name: name, price_eur: h.product.eur, price_czk: h.product.czk,
                                              sizes: [], sold_out: soldOut, last: '', position: c });
    if (h.product.czk != null && p.price_czk == null) p.price_czk = h.product.czk;
    p.position = c;                       // la colonne la plus récente donne le prix
    p.price_eur = h.product.eur;
    if (h.product.czk != null) p.price_czk = h.product.czk;
    p.sold_out = soldOut;
    for (var r = 1; r < rows.length; r++) {
      var v = rows[r][c];
      if (v === '' || v == null) continue;
      parseItemCell(v).forEach(function (it) { if (it.size && p.sizes.indexOf(it.size) < 0) p.sizes.push(it.size); });
      var when = toIso(rows[r][0]) || '';
      if (when > p.last) p.last = when;
    }
  }
  return Object.keys(byName).map(function (k) {
    var p = byName[k];
    var form = formItems ? formItems[p.name] : null;
    (form || []).forEach(function (sz) { if (p.sizes.indexOf(sz) < 0) p.sizes.push(sz); });
    p.sizes.sort(function (a, b) { return sizeRank_(a) - sizeRank_(b); });
    // coupe Girly à part : « Girly M » → girly_sizes ["M"]
    p.girly_sizes = p.sizes.filter(function (x) { return /^Girly /.test(x); }).map(function (x) { return x.slice(6); });
    p.sizes = p.sizes.filter(function (x) { return !/^Girly /.test(x); });
    // article présent dans le formulaire = actif (même SOLD OUT, affiché comme tel) ; sinon ancien article
    p.active = formItems ? !!form : !p.sold_out && (!p.last || p.last >= yearAgo);
    delete p.last;
    return p;
  });
}

/** Articles du Google Form lié au Sheet (si le compte y a accès). */
function readFormItems_(ss) {
  try {
    var url = ss.getFormUrl();
    if (!url) return null;
    var out = {};
    FormApp.openByUrl(url).getItems().forEach(function (item) {
      var p = parseProductHeader(item.getTitle());
      if (p.eur == null) return;
      var T = FormApp.ItemType, type = item.getType(), choices = [];
      try {
        if (type === T.MULTIPLE_CHOICE) choices = item.asMultipleChoiceItem().getChoices().map(function (x) { return x.getValue(); });
        else if (type === T.LIST) choices = item.asListItem().getChoices().map(function (x) { return x.getValue(); });
        else if (type === T.CHECKBOX) choices = item.asCheckboxItem().getChoices().map(function (x) { return x.getValue(); });
        else if (type === T.GRID) choices = item.asGridItem().getColumns();
        else if (type === T.CHECKBOX_GRID) choices = item.asCheckboxGridItem().getColumns();
      } catch (e) { /* type sans choix */ }
      out[p.name] = choices.map(normSize).filter(function (x) { return x; });
    });
    return out;
  } catch (e) {
    Logger.log('Formulaire non lisible (partage-le avec ce compte) : ' + e);
    return null;
  }
}

// ---------------------------------------------------------------------
// Publication du Katalóg vers le Google Form
// ---------------------------------------------------------------------

function fmtPrice_(n) { n = Number(n); return Math.round(n) === n ? String(n) : String(n).replace('.', ','); }

/** Intitulé de question pour un article, en gardant le séparateur et les lignes d'explication d'origine. */
function formTitle(p, oldTitle) {
  var lines = String(oldTitle || '').split('\n');
  var first = lines[0];
  var sep = (first.match(/\s([|\-–])\s*\d+(?:[.,]\d+)?\s*(?:eur|€)/i) || [])[1] || '-';
  var t = (p.sold_out ? 'SOLD OUT! ' : '') + p.name;
  if (p.price_eur != null && p.price_eur !== '') {
    t += ' ' + sep + ' ' + fmtPrice_(p.price_eur) + ' eur';
    if (p.price_czk != null && p.price_czk !== '') t += ' / ' + fmtPrice_(p.price_czk) + ' Kč';
  }
  return [t].concat(lines.slice(1)).join('\n');
}

/** Choix de la question : tailles du Katalóg à la place des tailles actuelles, le reste est gardé. */
function formChoices(sizes, oldChoices) {
  oldChoices = oldChoices || [];
  var hadSize = oldChoices.some(function (c) { return SIZE_RE.test(String(c).trim()); });
  if (!hadSize || !sizes || !sizes.length) return null;
  var out = [], placed = false;
  oldChoices.forEach(function (c) {
    if (SIZE_RE.test(String(c).trim())) { if (!placed) { out = out.concat(sizes); placed = true; } }
    else out.push(c);
  });
  return out;
}

/**
 * Compare le formulaire et le Katalóg. items : [{id, title, type, choices}] (questions article du Form),
 * products : lignes de la table products. Renvoie la liste des changements, sans rien modifier.
 */
function allSizes_(p) {
  if (p.textile === false) return [];
  return (p.sizes || []).concat((p.girly_sizes || []).map(function (x) { return 'Girly ' + x; }));
}

function planFormUpdate(items, products) {
  var ops = [], used = {};
  var key = function (s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); };
  items.forEach(function (it) { it.name = parseProductHeader(it.title).name; it.hasSizes = !!formChoices(['M'], it.choices); });
  products.forEach(function (p) {
    var it = null;
    for (var i = 0; i < items.length && !it; i++) if (!used[items[i].id] && p.form_item_id && String(items[i].id) === String(p.form_item_id)) it = items[i];
    for (var j = 0; j < items.length && !it; j++) if (!used[items[j].id] && key(items[j].name) === key(p.name)) it = items[j];
    if (it) used[it.id] = true;
    if (!p.active) {
      if (it) ops.push({ op: 'remove', product_id: p.id, name: p.name, item_id: it.id, title_before: it.title });
      return;
    }
    if (it) {
      var title = formTitle(p, it.title), choices = formChoices(allSizes_(p), it.choices);
      var same = title === it.title && (!choices || JSON.stringify(choices) === JSON.stringify(it.choices));
      ops.push({ op: same ? 'same' : 'update', product_id: p.id, name: p.name, item_id: it.id,
                 title_before: it.title, title: title, choices_before: it.choices, choices: choices });
      return;
    }
    var wantSizes = !!(p.sizes && p.sizes.length), tpl = null;
    for (var k = items.length - 1; k >= 0 && !tpl; k--) if (items[k].hasSizes === wantSizes) tpl = items[k];
    tpl = tpl || items[items.length - 1];
    if (!tpl) return;
    ops.push({ op: 'create', product_id: p.id, name: p.name, template_id: tpl.id, template_title: tpl.title,
               title: formTitle(p, ''), choices: formChoices(allSizes_(p), tpl.choices) });
  });
  return ops;
}

function formChoiceInfo_(item) {
  var T = FormApp.ItemType, type = item.getType();
  if (type === T.MULTIPLE_CHOICE) return { get: function () { return item.asMultipleChoiceItem().getChoices().map(function (x) { return x.getValue(); }); },
                                           set: function (v) { item.asMultipleChoiceItem().setChoiceValues(v); } };
  if (type === T.LIST) return { get: function () { return item.asListItem().getChoices().map(function (x) { return x.getValue(); }); },
                                set: function (v) { item.asListItem().setChoiceValues(v); } };
  if (type === T.CHECKBOX) return { get: function () { return item.asCheckboxItem().getChoices().map(function (x) { return x.getValue(); }); },
                                    set: function (v) { item.asCheckboxItem().setChoiceValues(v); } };
  if (type === T.GRID) return { get: function () { return item.asGridItem().getColumns(); },
                                set: function (v) { item.asGridItem().setColumns(v); } };
  if (type === T.CHECKBOX_GRID) return { get: function () { return item.asCheckboxGridItem().getColumns(); },
                                         set: function (v) { item.asCheckboxGridItem().setColumns(v); } };
  return null;
}

/** Aperçu (apply = false) ou publication (apply = true) du Katalóg dans le Google Form. */
function publishForm_(apply) {
  var ss = SpreadsheetApp.openById(props_().getProperty('SHEET_ID'));
  var url = ss.getFormUrl();
  if (!url) throw new Error('Aucun Google Form lié au Sheet');
  var form = FormApp.openByUrl(url);                      // demande les droits d'éditeur du formulaire
  var byId = {}, items = [];
  form.getItems().forEach(function (item) {
    var title = item.getTitle();
    if (parseProductHeader(title).eur == null) return;    // pas une question article
    var info = formChoiceInfo_(item);
    byId[item.getId()] = item;
    items.push({ id: item.getId(), title: title, type: String(item.getType()), choices: info ? info.get().map(String) : [] });
  });
  var products = sb_('get', 'products?select=*&order=position,name');
  var ops = planFormUpdate(items, products);
  var summary = { applied: !!apply, update: 0, create: 0, remove: 0, same: 0,
                  ops: ops.filter(function (o) { return o.op !== 'same'; }), at: new Date().toISOString() };
  ops.forEach(function (o) { summary[o.op]++; });
  if (!apply) return summary;
  var now = new Date().toISOString();
  ops.forEach(function (o) {
    var item;
    if (o.op === 'remove') {
      form.deleteItem(byId[o.item_id]);
      sb_('patch', 'products?id=eq.' + o.product_id, { form_item_id: null, form_title: null, form_synced_at: now });
      return;
    }
    if (o.op === 'create') item = byId[o.template_id].duplicate();
    else item = byId[o.item_id];
    if (o.op !== 'same') {
      item.setTitle(o.title);
      var info = formChoiceInfo_(item);
      if (info && o.choices) info.set(o.choices);
    }
    sb_('patch', 'products?id=eq.' + o.product_id, { form_item_id: item.getId(), form_title: o.title, form_synced_at: now, from_form: true });
  });
  return summary;
}

/** Liens du Google Form (réponse et modification), affichés dans le Katalóg du site. */
function saveFormLinks_(ss) {
  try {
    var form = FormApp.openByUrl(ss.getFormUrl());
    var value = { view_url: form.getPublishedUrl(), edit_url: form.getEditUrl(),
                  title: form.getTitle(), description: form.getDescription() };
    var old = sb_('get', 'settings?key=eq.google_form&select=value')[0];
    if (old && old.value && old.value.header_image) value.header_image = old.value.header_image;
    var photos = importFormPhotos_(form.getPublishedUrl(), !value.header_image);
    if (photos.header_image) value.header_image = photos.header_image;
    sb_('post', 'settings?on_conflict=key', { key: 'google_form', updated_at: new Date().toISOString(), value: value },
        'resolution=merge-duplicates');
  } catch (e) { Logger.log('Liens du formulaire non mis à jour : ' + e); }
}

/**
 * Page publique du formulaire → image d'en-tête et image de chaque question.
 * (Google ne donne pas ces images au script : on les lit dans la page publique.)
 */
function parseFormPage(html) {
  var IMG = /https:\/\/docs\.google\.com\/forms-images-rt\/[A-Za-z0-9_\-]+/;
  var header = (String(html).match(/\.KHCwJ\s*\{background-image:\s*url\(["']?(https:\/\/docs\.google\.com\/forms-images-rt\/[A-Za-z0-9_\-]+)/) || [])[1] || null;
  var items = [];
  String(html).split('role="listitem"').slice(1).forEach(function (block) {
    var id = block.match(/data-params="%\.@\.\[(\d+),/);
    var img = block.match(IMG);
    if (id && img) items.push({ id: id[1], image: img[0] });
  });
  return { header: header, items: items };
}

/** Envoie une image dans Supabase Storage (bucket product-photos) et renvoie son adresse publique. */
function storePhoto_(path, blob) {
  var base = props_().getProperty('SUPABASE_URL').replace(/\/+$/, '');
  var key = props_().getProperty('SUPABASE_SECRET_KEY');
  var headers = { apikey: key, 'x-upsert': 'true' };
  if (key.indexOf('sb_') !== 0) headers.Authorization = 'Bearer ' + key;
  var res = UrlFetchApp.fetch(base + '/storage/v1/object/product-photos/' + path, {
    method: 'post', contentType: blob.getContentType() || 'image/jpeg', payload: blob.getBytes(), headers: headers, muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('Storage ' + path + ' → ' + res.getResponseCode() + ' ' + res.getContentText());
  return base + '/storage/v1/object/public/product-photos/' + path + '?v=' + Date.now();
}

/**
 * Photos des questions du Google Form → Katalóg. Une photo n'est ajoutée qu'à un article
 * qui n'en a encore aucune : les photos choisies sur le site ne sont jamais remplacées.
 */
function importFormPhotos_(publishedUrl, withHeader) {
  var out = { added: 0 };
  var html = UrlFetchApp.fetch(publishedUrl, { muteHttpExceptions: true, followRedirects: true }).getContentText();
  var page = parseFormPage(html);
  var products = sb_('get', 'products?select=id,name,photos,form_item_id');
  var form = null;
  page.items.forEach(function (it) {
    var p = products.filter(function (x) { return String(x.form_item_id) === it.id; })[0];
    if (!p) {                                   // pas encore lié : on cherche par le nom de la question
      form = form || FormApp.openByUrl(publishedUrl.replace(/\/viewform.*$/, '/edit'));
      var item = null;
      try { item = form.getItemById(Number(it.id)); } catch (e) { /* question supprimée */ }
      if (!item) return;
      var name = parseProductHeader(item.getTitle()).name.toLowerCase();
      p = products.filter(function (x) { return x.name.toLowerCase() === name; })[0];
    }
    if (!p || (p.photos && p.photos.length)) return;
    try {
      var blob = UrlFetchApp.fetch(it.image).getBlob();
      var url = storePhoto_('form/' + it.id + '.' + (/png/.test(blob.getContentType()) ? 'png' : 'jpg'), blob);
      sb_('patch', 'products?id=eq.' + p.id, { photos: [url], form_item_id: Number(it.id) });
      out.added++;
    } catch (e) { Logger.log('Photo de ' + p.name + ' : ' + e); }
  });
  if (page.header && withHeader) {
    try { out.header_image = storePhoto_('form/header.jpg', UrlFetchApp.fetch(page.header).getBlob()); }
    catch (e) { Logger.log('En-tête : ' + e); }
  }
  return out;
}

/** En-tête du formulaire (titre et description) modifié depuis le Katalóg. */
function updateFormHeader_(payload) {
  var ss = SpreadsheetApp.openById(props_().getProperty('SHEET_ID'));
  var form = FormApp.openByUrl(ss.getFormUrl());
  if (payload && payload.title != null && String(payload.title).trim()) form.setTitle(String(payload.title).trim());
  if (payload && payload.description != null) form.setDescription(String(payload.description));
  saveFormLinks_(ss);
  return { applied: true, title: form.getTitle(), at: new Date().toISOString() };
}

/** Mail « Adacta Merch Order - Merch order N°673 » → {order_no, email} */
function parseOrderMail(subject, plainBody, recipients) {
  var m = String(subject || '').match(/N[°º]\s*(\d+)/);
  if (!m) return null;
  var e = String(plainBody || '').match(/Email address\s*:\s*([^\s<>]+@[^\s<>]+)/i);
  var email = e ? e[1] : (recipients && recipients.length ? recipients[recipients.length - 1] : null);
  if (!email) return null;
  return { order_no: parseInt(m[1], 10), email: email.toLowerCase().replace(/[.,;]+$/, '') };
}

// ---------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------

function props_() { return PropertiesService.getScriptProperties(); }

function sb_(method, path, body, prefer) {
  var url = props_().getProperty('SUPABASE_URL').replace(/\/+$/, '') + '/rest/v1/' + path;
  var key = props_().getProperty('SUPABASE_SECRET_KEY');
  var headers = { apikey: key };
  if (key.indexOf('sb_') !== 0) headers.Authorization = 'Bearer ' + key; // anciennes clés JWT
  if (prefer) headers.Prefer = prefer;
  var res = UrlFetchApp.fetch(url, {
    method: method, contentType: 'application/json', headers: headers,
    payload: body === undefined ? undefined : JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code >= 300) throw new Error('Supabase ' + method + ' ' + path + ' → ' + code + ' ' + text);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------
// Tâches
// ---------------------------------------------------------------------

/** Importe toutes les réponses du Sheet. */
function importSheet() {
  var p = props_();
  var ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'));
  var name = p.getProperty('SHEET_NAME');
  var sheet = name ? ss.getSheetByName(name) : ss.getSheets()[0];
  var rows = sheet.getDataRange().getValues();
  var from = p.getProperty('IMPORT_FROM') || DEFAULT_IMPORT_FROM;
  var orders = parseSheet(rows, { archiveBefore: p.getProperty('ARCHIVE_BEFORE') || '',
                                  importFromMs: Utilities.parseDate(from, 'Europe/Bratislava', 'yyyy-MM-dd').getTime() });
  sb_('post', 'rpc/import_products', { p: buildCatalog(rows, readFormItems_(ss)) });
  saveFormLinks_(ss);
  var created = 0;
  orders.forEach(function (o) {
    if (sb_('post', 'rpc/import_order', { p: o }) === 'created') created++;
  });
  return { rows: orders.length, created: created };
}

/** Lit les mails « Merch order N°… » et attribue les N° manquants. */
function importOrderNumbers() {
  var query = props_().getProperty('GMAIL_QUERY') || 'subject:"Merch order" newer_than:120d';
  var known = {};
  sb_('get', 'orders?select=order_no&order_no=not.is.null').forEach(function (r) { known[r.order_no] = true; });
  var assigned = 0;
  GmailApp.search(query, 0, 200).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var info = parseOrderMail(msg.getSubject(), msg.getPlainBody(), msg.getTo().split(/\s*,\s*/));
      if (!info || known[info.order_no]) return;
      var id = sb_('post', 'rpc/assign_order_no', {
        p_order_no: info.order_no, p_email: info.email,
        p_sent_at: msg.getDate().toISOString(), p_message_id: msg.getId()
      });
      if (id) { assigned++; known[info.order_no] = true; }
    });
  });
  return { assigned: assigned };
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Liste des copies cachées : l'équipe, sans le destinataire ni les personnes déjà en copie. */
function bccList(team, to, cc) {
  var skip = {};
  String((to || '') + ',' + (cc || '')).split(',').forEach(function (e) { skip[e.trim().toLowerCase()] = 1; });
  var seen = {};
  return (team || []).filter(function (e) {
    e = String(e).trim().toLowerCase();
    if (!e || skip[e] || seen[e]) return false;
    return (seen[e] = true);
  }).join(',');
}

/** Envoie les mails en attente préparés sur le site. */
function sendPendingEmails() {
  var settings = sb_('get', 'settings?key=eq.email&select=value');
  var cfg = settings.length ? settings[0].value : {};
  var pending = sb_('get', 'email_outbox?status=eq.pending&order=id&limit=40');
  if (!pending.length) return { sent: 0 };
  // copie cachée à toutes les personnes autorisées sur le site (case dans Nastavenia, activée par défaut)
  var team = [];
  if (cfg.bcc_users !== false) {
    var me = '';
    try { me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
    team = sb_('get', 'allowed_emails?select=email').map(function (r) { return String(r.email).toLowerCase(); })
      .filter(function (e) { return e && e !== me; });
  }
  var sent = 0;
  pending.forEach(function (m) {
    // on réserve le mail avant l'envoi pour ne jamais l'envoyer deux fois
    var claimed = sb_('patch', 'email_outbox?id=eq.' + m.id + '&status=eq.pending',
                      { status: 'sent', sent_at: new Date().toISOString() }, 'return=representation');
    if (!claimed.length) return;
    try {
      var html = escapeHtml_(m.body_text)
        .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
      var opts = { name: cfg.sender_name || 'ADACTA', htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px">' + html + '</div>' };
      var cc = [m.cc, cfg.cc].filter(function (x) { return x && String(x).trim(); }).join(',');
      if (cc) opts.cc = cc;
      var bcc = bccList(team, m.to_email, cc);
      if (bcc) opts.bcc = bcc;
      if (cfg.reply_to) opts.replyTo = cfg.reply_to;
      GmailApp.sendEmail(m.to_email, m.subject, m.body_text, opts);
      sent++;
    } catch (err) {
      sb_('patch', 'email_outbox?id=eq.' + m.id, { status: 'error', error: String(err), sent_at: null });
    }
  });
  return { sent: sent };
}

/** Synchronisation complète : Sheet puis N° de commande Gmail. */
function syncAll() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    var a = importSheet();
    var b = props_().getProperty('GMAIL_ORDER_NUMBERS') === 'true' ? importOrderNumbers() : { assigned: 0 };
    return { rows: a.rows, created: a.created, order_numbers: b.assigned, at: new Date().toISOString() };
  } finally { lock.releaseLock(); }
}

/** Toutes les minutes : mails à envoyer + bouton « Synchroniser » du site. */
function processQueue() {
  sendPendingEmails();
  var requests = sb_('get', 'sync_requests?done_at=is.null&order=id');
  if (!requests.length) return;
  var done = function (r, result) { sb_('patch', 'sync_requests?id=eq.' + r.id, { done_at: new Date().toISOString(), result: result }); };
  // Katalóg → Google Form (aperçu ou publication), une demande à la fois
  requests.filter(function (r) { return r.kind === 'form_preview' || r.kind === 'form_publish' || r.kind === 'form_header'; }).forEach(function (r) {
    var result;
    try { result = r.kind === 'form_header' ? updateFormHeader_(r.payload) : publishForm_(r.kind === 'form_publish'); }
    catch (err) { result = { error: String(err) }; }
    done(r, result);
  });
  var syncs = requests.filter(function (r) { return !r.kind || r.kind === 'sync'; });
  if (!syncs.length) return;
  var result;
  try { result = syncAll() || { skipped: 'synchronisation déjà en cours' }; }
  catch (err) { result = { error: String(err) }; }
  syncs.forEach(function (r) { done(r, result); });
}

/** À lancer une fois à la main : crée les déclencheurs automatiques. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(15).create();
  Logger.log(JSON.stringify(syncAll()));
}

// Pour les tests hors Google (Node)
if (typeof module !== 'undefined') {
  module.exports = { bccList, parseSheet: parseSheet, parseProductHeader: parseProductHeader,
                     parseItemCell: parseItemCell, parseOrderMail: parseOrderMail,
                     classifyHeader: classifyHeader, toIso: toIso, buildCatalog: buildCatalog,
                     formTitle: formTitle, formChoices: formChoices, planFormUpdate: planFormUpdate, normSize: normSize,
                     parseFormPage: parseFormPage };
}
