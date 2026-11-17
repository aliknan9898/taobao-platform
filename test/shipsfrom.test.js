'use strict';
/* AliExpress "Ships From": hidden from customers; Kinan picks the warehouse for each address. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));
const db = require('../src/db');
const SF = require('../src/services/shipsFrom');
const L = require('../src/services/landed');

const mk = () => db.listings.insert({ seller_id: require('../src/services/buyforme').systemSeller().id, status: 'active', source: 'aliexpress', fulfillment: 'direct', ae_product_id: '9', title: 'Lamp', currency: 'usd',
  images: ['https://x/1.jpg'], sourcing: { gb_fee: 2, eu_fee: 2, from: 'CN' },
  skus: [
    { mp_sku_id: 'R-CN', props: 'Red / China', opts: [{ name: 'Color', value: 'Red' }, { name: 'Ships From', value: 'China' }], price: 9, cost_sale: 3, stock: 50, ae_sku_attr: 'a1' },
    { mp_sku_id: 'R-ES', props: 'Red / Spain', opts: [{ name: 'Color', value: 'Red' }, { name: 'Ships From', value: 'Spain' }], price: 9, cost_sale: 4, stock: 10, ae_sku_attr: 'a2' },
    { mp_sku_id: 'B-CN', props: 'Blue / China', opts: [{ name: 'Color', value: 'Blue' }, { name: 'Ships From', value: 'China' }], price: 9, cost_sale: 3, stock: 50, ae_sku_attr: 'a3' }
  ] });

test('the shop shows one option per colour, without the warehouse', () => {
  const l = mk();
  const vis = SF.visibleSkus(l);
  assert.deepStrictEqual(vis.map((s) => s.props).sort(), ['Blue', 'Red']);
  assert.strictEqual(vis.find((s) => s.props === 'Red').stock, 60);
  const v = require('../src/services/catalog').buyerListing(l.id);
  assert.strictEqual(v.skus.length, 2);
  assert.ok(!(v.option_groups || []).some((g) => /ship/i.test(g.name)));
});

test('Kinan picks the warehouse: EU address → Spain, UK → cheapest (China)', () => {
  const l = mk(); const red = l.skus[0];
  assert.strictEqual(SF.pick(l, red, 'MT').mp_sku_id, 'R-ES');
  assert.strictEqual(SF.pick(l, red, 'DE').mp_sku_id, 'R-ES');
  assert.strictEqual(SF.pick(l, red, 'GB').mp_sku_id, 'R-CN');
  assert.strictEqual(SF.pick(l, l.skus[2], 'MT').mp_sku_id, 'B-CN'); // blue only in China
  // no EU import duty when it leaves from Spain; duty when it leaves from China
  assert.strictEqual(L.importCharges([{ listing_id: l.id, mp_sku_id: 'R-CN', qty: 1 }], 'MT').fee, 0);
  assert.ok(L.importCharges([{ listing_id: l.id, mp_sku_id: 'B-CN', qty: 1 }], 'MT').fee > 0);
});

test('every warehouse copy of an option has the same price (the dearer one), so the margin holds', () => {
  const l = mk();
  L.repriceKinan({ ids: [l.id] });
  const s = db.listings.get(l.id).skus;
  assert.strictEqual(s[0].price, s[1].price);
  assert.ok(s[1].price >= L.minPrice(l, s[1]));
});
