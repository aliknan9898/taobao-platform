// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Sellers add products from the Kinan catalogue (suppliers hidden); supplier imports are for Kinan only. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kcat-'));
Object.assign(process.env, { ADMIN_EMAIL: 'boss@x.com', ADMIN_PASSWORD: 'adminpass1', ADMIN_GOOGLE_EMAILS: 'boss@x.com', KINAN_WHOLESALE_PCT: '10' });
delete process.env.SELLER_SUPPLIER_IMPORTS;
const auth = require('../src/auth');
const db = require('../src/db');
const { server } = require('../src/server');
let base;
test.before(async () => { auth.bootstrapAdmin(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
async function api(method, p, body, token) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}

test('Kinan catalogue: browse without suppliers, add at own price, Kinan price as seller cost, supplier imports closed', async () => {
  const kinan = require('../src/services/buyforme').systemSeller();
  const src = db.listings.insert({ seller_id: kinan.id, source: 'cj', fulfillment: 'direct', status: 'active', title: 'LED Desk Lamp', cj_pid: 'P1', cj_from: 'GB', source_link: 'https://cjdropshipping.com/p1', images: ['https://img.example/1.jpg'], collections: ['home'],
    skus: [{ mp_sku_id: 'cj_V1', cj_vid: 'V1', props: 'White', price: 19.99, cost_sale: 10, stock: 40 }], sourcing: { gb_days: 5, eu_days: 8, quality: 9 } });
  const reg = await api('POST', '/api/auth/register', { role: 'seller', email: 's1@x.com', password: 'sellerpass1', shop_name: 'Lina', accept_terms: true });
  const sid = reg.body.seller_id || db.sellers.find((s) => s.shop_name === 'Lina').id;
  db.sellers.update(sid, { status: 'active', verified_manually: true, kyc: { state: 'verified' } });
  const tok = (await api('POST', '/api/auth/login', { email: 's1@x.com', password: 'sellerpass1', app: 'seller' })).body.token;
  const me = await api('GET', '/api/seller/me', null, tok);
  assert.strictEqual(me.body.supplier_imports ?? me.body.shop?.supplier_imports, false);
  // supplier imports are closed for sellers
  assert.strictEqual((await api('POST', '/api/seller/products/cj/preview', { ref: 'P1' }, tok)).status, 403);
  assert.strictEqual((await api('POST', '/api/seller/products/aliexpress/preview', { link: '1005000000000001' }, tok)).status, 403);
  assert.strictEqual((await api('GET', '/api/cj/search?q=lamp', null, tok)).status, 403);
  // browse: no supplier details
  const b = await api('GET', '/api/seller/kinan-catalog', null, tok);
  assert.strictEqual(b.status, 200, JSON.stringify(b.body)); assert.strictEqual(b.body.total, 1);
  const it = b.body.items[0];
  assert.strictEqual(it.kinan_price, 11); assert.strictEqual(it.delivery_days, 5);
  assert.doesNotMatch(JSON.stringify(b.body), /cj|CJ|cjdropshipping|source_link|cost_sale/);
  // price must be above the Kinan price
  assert.strictEqual((await api('POST', `/api/seller/kinan-catalog/${src.id}`, { prices: { cj_V1: 10.5 } }, tok)).status, 400);
  const add = await api('POST', `/api/seller/kinan-catalog/${src.id}`, { prices: { cj_V1: 24.99 } }, tok);
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  assert.strictEqual(add.body.status, 'active'); assert.strictEqual(add.body.source, 'kinan');
  assert.doesNotMatch(JSON.stringify(add.body), /cjdropshipping|cj_vid|cost_sale|"P1"/);
  assert.strictEqual((await api('POST', `/api/seller/kinan-catalog/${src.id}`, { prices: { cj_V1: 30 } }, tok)).status, 409, 'once per shop');
  // the seller's product list hides the supplier too
  const mine = await api('GET', '/api/seller/products', null, tok);
  assert.doesNotMatch(JSON.stringify(mine.body), /cjdropshipping|cj_vid|cost_sale/);
  assert.strictEqual(mine.body[0].skus[0].kinan_price, 11);
  // the copy still ships through the supplier internally
  const copy = db.listings.get(add.body.id);
  assert.strictEqual(copy.cj_pid, 'P1'); assert.strictEqual(copy.from_kinan, src.id); assert.strictEqual(copy.seller_id, sid);
  assert.strictEqual(require('../src/services/kinanCatalog').lineCost(copy, copy.skus[0]), 11);
  // price change below the Kinan price is refused
  assert.strictEqual((await api('PATCH', `/api/seller/products/${copy.id}`, { prices: { cj_V1: 9 } }, tok)).status, 400);
  assert.strictEqual((await api('PATCH', `/api/seller/products/${copy.id}`, { prices: { cj_V1: 22 } }, tok)).status, 200);
});
