'use strict';
/* Landed-cost pricing: 20% net after supplier price, AliExpress shipping and card fees; EU import duty at checkout. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-'));
const db = require('../src/db');
const L = require('../src/services/landed');

const kinan = () => require('../src/services/buyforme').systemSeller();
const ae = (over = {}) => db.listings.insert({ seller_id: kinan().id, status: 'active', source: 'aliexpress', fulfillment: 'direct', ae_product_id: '1', title: 'Cap', currency: 'usd',
  sourcing: { gb_fee: 1.99, eu_fee: 1.99, from: 'CN' }, skus: [{ mp_sku_id: 'A', price: 4.57, stock: 9, cost_sale: 6.78 }], ...over });

test('price keeps 20% net after supplier price, shipping and card fees', () => {
  const l = ae(); const s = l.skus[0];
  const p = L.priceFor(l, s);
  // (6.78 + 1.99 + 0.35) / (1 - 0.20 - 0.04) = 12.0 → 12.99
  assert.strictEqual(L.minPrice(l, s), 12);
  assert.ok(p >= 12 && String(p).endsWith('.99'));
  const net = p * 0.96 - 0.35 - (6.78 + 1.99);
  assert.ok(net / p >= 0.2, `net ${net} of ${p}`);
});

test('EU import charges: €3 + VAT per line from outside the EU, AliExpress handling once per parcel; none for the UK', () => {
  const a = ae(); const b = ae({ title: 'Gloves' }); const eu = ae({ title: 'From DE', source: 'cj', cj_from: 'DE' });
  const items = [a, b, eu].map((l) => ({ listing_id: l.id, qty: 1 }));
  const mt = L.importCharges(items, 'MT');
  assert.strictEqual(mt.lines, 2);
  assert.ok(mt.fee > 2 * 3 * 1.18 + 2.55); // duty ×2 (+VAT 18%) + one handling fee, plus card fee
  assert.strictEqual(L.importCharges(items, 'GB').fee, 0);
});

test('repricing Kinan products and the checkout guard', () => {
  const l = ae({ title: 'Underpriced' });
  const r = L.repriceKinan({ ids: [l.id] });
  assert.strictEqual(r.changed, 1);
  assert.ok(db.listings.get(l.id).skus[0].price >= 12);
  // a seller's own underpriced supplier product is refused at checkout
  const seller = db.sellers.insert({ shop_name: 'S', status: 'active' });
  const sl = db.listings.insert({ seller_id: seller.id, status: 'active', source: 'aliexpress', fulfillment: 'direct', title: 'Seller cap', sourcing: { gb_fee: 2 }, skus: [{ mp_sku_id: 'X', price: 5, stock: 3, cost_sale: 6 }] });
  const g = L.guard([{ direct: true, listing_id: sl.id, mp_sku_id: 'X', price: 5, qty: 1 }], 'MT');
  assert.strictEqual(g.length, 1); assert.strictEqual(g[0].own, false);
  assert.strictEqual(L.guard([{ direct: true, listing_id: sl.id, mp_sku_id: 'X', price: 20, qty: 1 }], 'MT').length, 0);
});
