// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Admin: products by platform — known ones in order, new sources appear by themselves. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
const db = require('../src/db');
const P = require('../src/services/platforms');

test('products by platform', () => {
  const k = require('../src/services/buyforme').systemSeller();
  const add = (x) => db.listings.insert({ seller_id: k.id, status: 'active', title: 'T', skus: [{ price: 10, cost_sale: 4, stock: 5 }], created_at: Date.now(), ...x });
  add({ source: 'cj', sourcing: { gb_days: 5 } }); add({ source: 'cj', status: 'paused' }); add({ source: 'aliexpress', ae_product_id: '1005000000000001', sourcing: { gb_days: 9 } });
  add({ source: 'cj', from_kinan: 'x', seller_id: 'sel_other' }); add({ source: 'temu' }); add({});
  const s = P.summary();
  assert.deepStrictEqual(s.map((x) => x.id), ['aliexpress', 'cj', 'kinan', 'manual', 'temu']);
  const cj = s.find((x) => x.id === 'cj'); assert.strictEqual(cj.active, 1); assert.strictEqual(cj.paused, 1); assert.strictEqual(cj.avg_days, 5);
  assert.strictEqual(s.find((x) => x.id === 'temu').name, 'Temu');
  const ae = P.products('aliexpress');
  assert.strictEqual(ae.total, 1); assert.match(ae.items[0].supplier_link, /aliexpress\.com\/item\/1005000000000001/);
  assert.strictEqual(P.products('cj', { status: 'paused' }).total, 1);
  const id = ae.items[0].id;
  assert.strictEqual(P.setStatus(id, 'paused').status, 'paused');
  assert.strictEqual(P.setStatus(id, 'active').status, 'active');
  assert.throws(() => P.setStatus(id, 'deleted'), /active or paused/);
});
