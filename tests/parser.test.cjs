// Tests du lecteur de Google Sheet : node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

const ctx = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../google-apps-script/Code.gs'), 'utf8'), ctx);
const P0 = ctx.module.exports;
// le code tourne dans un autre contexte JS : on recopie les résultats pour les comparer
const P = Object.fromEntries(Object.entries(P0).map(([k, f]) => [k, (...a) => JSON.parse(JSON.stringify(f(...a)))]));
const header = require('./fixtures/header.json');

test('intitulés de colonnes article', () => {
  assert.deepStrictEqual({ ...P.parseProductHeader('Misanthropunk t-shirt - 18 eur / 450 Kč') }, { name: 'Misanthropunk t-shirt', eur: 18, czk: 450 });
  assert.deepStrictEqual({ ...P.parseProductHeader('Beanie | 15 eur / 380 Kč') }, { name: 'Beanie', eur: 15, czk: 380 });
  assert.deepStrictEqual({ ...P.parseProductHeader('SOLD OUT! Oversized Fanny Pack - 20 eur / 500 Kč') }, { name: 'Oversized Fanny Pack', eur: 20, czk: 500 });
  assert.deepStrictEqual({ ...P.parseProductHeader('Raven - Crewneck Unisex - 35 € [First item]') }, { name: 'Raven - Crewneck Unisex', eur: 35, czk: null });
  assert.deepStrictEqual({ ...P.parseProductHeader('хуй Любош T-Shirt') }, { name: 'хуй Любош T-Shirt', eur: null, czk: null });
});

test('colonnes client reconnues', () => {
  const fields = header.map(h => P.classifyHeader(h).field);
  for (const f of ['submitted_at', 'email', 'order_no', 'sheet_status', 'first_name', 'last_name', 'company', 'street',
                   'postal_code', 'city', 'country', 'phone', 'social', 'shipping_method', 'pickup_point', 'customer_notes'])
    assert.ok(fields.includes(f), f);
  assert.strictEqual(P.classifyHeader('Column 93').field, '_ignore');
});

test('lecture d\'une réponse complète', () => {
  const row = header.map(() => '');
  const set = (h, v) => { row[header.indexOf(h)] = v; };
  set('Horodateur', '16/11/2026 07:15:06');
  set('Adresse e-mail', 'Client@Example.com');
  set('Name / Meno', 'Jana'); set('Surname / Priezvisko', 'Testová');
  set('Dorucenie', 'SK & CZ Packeta / Pick-up dobierkou');
  set('Misanthropunk t-shirt - 18 eur / 450 Kč', 'XL');
  set('Beanie | 15 eur / 380 Kč', 'Beanie');
  set('Notes / Poznámky k objednávke', 'ZLAVADACTA');
  const old = [...row]; old[0] = '01/03/2025 10:00:00'; old[3] = 'ANO - PACKETA';
  const orders = P.parseSheet([header, row, old, header.map(() => '')], { archiveBefore: '2026-09-15' });
  assert.strictEqual(orders.length, 2);
  const o = orders[0];
  assert.strictEqual(o.email, 'client@example.com');
  assert.strictEqual(o.submitted_at, '2026-11-16T07:15:06+01:00');
  assert.strictEqual(o.status, 'non_traitee');
  assert.strictEqual(o.customer_notes, 'ZLAVADACTA');
  assert.deepStrictEqual(o.items.map(i => [i.product, i.size, i.qty, i.unit_eur]),
    [['Beanie', null, 1, 15], ['Misanthropunk t-shirt', 'XL', 1, 18]]);
  assert.strictEqual(orders[1].status, 'envoyee');
});

test('plusieurs tailles dans une case', () => {
  assert.deepStrictEqual(P.parseItemCell('M, L').map(i => i.size), ['M', 'L']);
  assert.deepStrictEqual(P.parseItemCell('2').map(i => i.qty), [2]);
});

test('mail « Merch order N° »', () => {
  const m = P.parseOrderMail('Adacta Merch Order - Merch order N°673',
    'Hi!\n\nEmail address: o.test@seznam.cz\nRaven T-Shirt: L', ['a@x.com', 'o.test@seznam.cz']);
  assert.deepStrictEqual({ ...m }, { order_no: 673, email: 'o.test@seznam.cz' });
  assert.strictEqual(P.parseOrderMail('Re: hello', '', []), null);
});

test('catalogue depuis les colonnes', () => {
  const row = header.map(() => '');
  row[0] = '16/11/2026 07:15:06';
  row[header.indexOf('Misanthropunk t-shirt - 18 eur / 450 Kč')] = 'XL';
  const row2 = [...row]; row2[header.indexOf('Misanthropunk t-shirt - 18 eur / 450 Kč')] = 'S';
  const cat = P.buildCatalog([header, row, row2], null, '2026-11-21');
  const tee = cat.find(p => p.name === 'Misanthropunk t-shirt');
  assert.deepStrictEqual(tee.sizes, ['S', 'XL']);
  assert.strictEqual(tee.price_czk, 450);
  assert.strictEqual(tee.active, true);
  assert.strictEqual(cat.find(p => p.name === 'Oversized Fanny Pack').sold_out, true);
  assert.strictEqual(cat.find(p => p.name === 'Oversized Fanny Pack').active, false);
  const withForm = P.buildCatalog([header, row], { 'Beanie': [], 'Misanthropunk t-shirt': ['M', 'L'] }, '2026-11-21');
  assert.deepStrictEqual(withForm.filter(p => p.active).map(p => p.name).sort(), ['Beanie', 'Misanthropunk t-shirt']);
  assert.deepStrictEqual(withForm.find(p => p.name === 'Misanthropunk t-shirt').sizes, ['M', 'L', 'XL']);
});

test('import à partir du 15/09/2026', () => {
  const rows = [header, header.map(() => ''), header.map(() => '')];
  rows[1][0] = '14/09/2026 21:59:00'; rows[1][1] = 'a@x.sk'; rows[1][5] = '1';
  rows[2][0] = '15/09/2026 18:01:12'; rows[2][1] = 'b@x.sk'; rows[2][5] = '1';
  const all = P.parseSheet(rows, {});
  const from = P.parseSheet(rows, { importFromMs: Date.parse('2026-09-15T00:00:00+02:00') });
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(from.map(o => o.email), ['b@x.sk']);
});

test('Katalóg → Google Form', () => {
  assert.strictEqual(P.formTitle({ name: 'Raven T-Shirt', price_eur: 19, price_czk: 480 }, 'Raven T-Shirt - 18 eur / 450 Kč'), 'Raven T-Shirt - 19 eur / 480 Kč');
  assert.strictEqual(P.formTitle({ name: 'Beanie', price_eur: 15, price_czk: 380, sold_out: true }, 'Beanie | 15 eur / 380 Kč\nWarm.'), 'SOLD OUT! Beanie | 15 eur / 380 Kč\nWarm.');
  assert.deepStrictEqual(P.formChoices(['S', 'M', 'L'], ['M', 'L', 'XL', 'Other']), ['S', 'M', 'L', 'Other']);
  assert.strictEqual(P.formChoices(['S'], ['1', '2']), null);
  const items = [
    { id: 1, title: 'Raven T-Shirt - 18 eur / 450 Kč', choices: ['M', 'L'] },
    { id: 2, title: 'Beanie | 15 eur / 380 Kč', choices: [] },
    { id: 3, title: 'Old Patch | 5 eur / 120 Kč', choices: [] }];
  const ops = P.planFormUpdate(items, [
    { id: 10, name: 'Raven T-Shirt', price_eur: 18, price_czk: 450, sizes: ['M', 'L'], active: true },
    { id: 11, name: 'Beanie', price_eur: 16, price_czk: 400, sizes: [], active: true },
    { id: 12, name: 'Old Patch', price_eur: 5, sizes: [], active: false },
    { id: 13, name: 'Snake t-shirt', price_eur: 18, price_czk: 450, sizes: ['S', 'M'], active: true }]);
  assert.deepStrictEqual(ops.map(o => [o.op, o.name]), [['same', 'Raven T-Shirt'], ['update', 'Beanie'], ['remove', 'Old Patch'], ['create', 'Snake t-shirt']]);
  assert.strictEqual(ops[1].title, 'Beanie | 16 eur / 400 Kč');
  assert.strictEqual(ops[3].template_id, 1);
  assert.deepStrictEqual(ops[3].choices, ['S', 'M']);
});

test('tailles : S à 4XL, Unisize, Girly', () => {
  assert.deepStrictEqual(['xxxl', 'XXXXL', '2XL', 'one size', 'Girly m', "Women's L", 'M', 'abc'].map(P.normSize),
    ['3XL', '4XL', 'XXL', 'Unisize', 'Girly M', 'Girly L', 'M', null]);
  assert.deepStrictEqual(P.parseItemCell('XXXL, Girly S'), [{ size: '3XL', qty: 1 }, { size: 'Girly S', qty: 1 }]);
  const rows = [['Horodateur', 'Raven T-Shirt - 18 eur / 450 Kč'], ['15/11/2026 10:00:00', 'XL, Girly M'], ['16/11/2026 10:00:00', 'S']];
  const cat = P.buildCatalog(rows, null, '2026-11-20');
  assert.deepStrictEqual([cat[0].sizes, cat[0].girly_sizes], [['S', 'XL'], ['M']]);
  const ops = P.planFormUpdate([{ id: 1, title: 'Raven T-Shirt - 18 eur / 450 Kč', choices: ['S', 'XL'] }],
    [{ id: 1, name: 'Raven T-Shirt', price_eur: 18, price_czk: 450, textile: true, sizes: ['S', 'M', '4XL'], girly_sizes: ['M'], active: true }]);
  assert.deepStrictEqual(ops[0].choices, ['S', 'M', '4XL', 'Girly M']);
});

test('photos et en-tête lus dans la page publique du formulaire', () => {
  const html = '<style>.KHCwJ {background-image: url("https://docs.google.com/forms-images-rt/HEAD_1");}</style>' +
    '<div role="listitem"><div data-params="%.@.[999,&quot;Adresse e-mail&quot;"></div></div>' +
    '<div role="listitem"><div jsmodel="CP1oW" data-params="%.@.[1418613996,&quot;Misanthropunk t-shirt - 18 eur / 450 Kč&quot;,null,2]">' +
    '<img src="https://docs.google.com/forms-images-rt/IMG_A-b_c"></div></div>' +
    '<div role="listitem"><div data-params="%.@.[51433941,&quot;Beanie | 15 eur&quot;"><img src="https://docs.google.com/forms-images-rt/IMG_B"></div></div>';
  assert.deepStrictEqual(P.parseFormPage(html), { header: 'https://docs.google.com/forms-images-rt/HEAD_1',
    items: [{ id: '1418613996', image: 'https://docs.google.com/forms-images-rt/IMG_A-b_c' }, { id: '51433941', image: 'https://docs.google.com/forms-images-rt/IMG_B' }] });
});

test('copie cachée : équipe sans destinataire ni copies', () => {
  const { bccList } = require('../google-apps-script/Code.gs');
  assert.equal(bccList(['a@x.sk', 'B@x.sk', 'c@x.sk', 'a@x.sk'], 'b@x.sk', 'c@x.sk'), 'a@x.sk');
  assert.equal(bccList([], 'b@x.sk', ''), '');
});

test('confirmation automatique : langue et variables', () => {
  const { renderTemplate, confirmationKey } = require('../google-apps-script/Code.gs');
  const T = { confirmation: {}, confirmation_sk: {} };
  assert.equal(confirmationKey({ country_code: 'CZ' }, T), 'confirmation_sk');
  assert.equal(confirmationKey({ country_code: 'AT' }, T), 'confirmation');
  const o = { order_no: 674, first_name: 'Jana', total_eur: 33, total_czk: 830, shipping_method: 'Packeta' };
  const items = [{ product: 'Raven T-Shirt', size: 'L', qty: 1, unit_eur: 18 }, { product: 'Beanie', qty: 1, unit_eur: 15 }];
  assert.equal(renderTemplate('Ahoj {first_name}, č. {order_no}\n{items}\n{total_eur} € / {total_czk} Kč {x}', o, items, {}),
    'Ahoj Jana, č. 674\n- Raven T-Shirt (L) × 1 · 18 €\n- Beanie × 1 · 15 €\n33 € / 830 Kč {x}');
});
