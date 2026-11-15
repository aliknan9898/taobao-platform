// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Delivery check of live products: over 15 days → paused (not deleted); known times reused; unknown asked. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'daudit-'));
delete process.env.TELEGRAM_BOT_TOKEN;
const db = require('../src/db');
const cj = require('../src/services/cj');
const A = require('../src/services/aeSourcing');
const D = require('../src/services/deliveryAudit');

const asked = [];
cj.freightOptions = async (dest, items) => { asked.push(dest); return items[0].vid === 'FAST' ? [{ fee: 3, method: 'CJPacket', days: '4-6', min: 4, max: 6 }] : [{ fee: 2, method: 'Slow', max: 25 }]; };
A.freight = async (pid, sku, c) => ({ days: pid === '1005SLOW00000001' ? 22 : 9 });

test('live CJ / AliExpress products over 15 days are hidden; fast and known-fast ones stay', async () => {
  const mk = (x) => db.listings.insert({ seller_id: 'sel_kinan', status: 'active', title: x.title, skus: [{ cj_vid: x.vid, ae_sku_id: 'S1', price: 10, stock: 9 }], ...x });
  const known = mk({ title: 'Known fast', source: 'cj', vid: 'X', sourcing: { gb_days: 5, eu_days: 7 } });
  const fastCj = mk({ title: 'CJ fast', source: 'cj', vid: 'FAST', cj_from: 'CN' });
  const slowCj = mk({ title: 'CJ slow', source: 'cj', vid: 'SLOW', cj_from: 'CN' });
  const slowAe = mk({ title: 'AE slow', source: 'aliexpress', ae_product_id: '1005SLOW00000001' });
  const other = mk({ title: 'Warehouse item', source: 'manual' });
  const st = await D.run({ restart: true });
  assert.strictEqual(st.checked, 4);
  assert.strictEqual(db.listings.get(known.id).status, 'active');
  assert.strictEqual(db.listings.get(fastCj.id).status, 'active'); assert.strictEqual(db.listings.get(fastCj.id).sourcing.gb_days, 6);
  assert.strictEqual(db.listings.get(slowCj.id).status, 'paused'); assert.match(db.listings.get(slowCj.id).paused_reason, /15 days/);
  assert.strictEqual(db.listings.get(slowAe.id).status, 'paused');
  assert.strictEqual(db.listings.get(other.id).status, 'active', 'only CJ / AliExpress products');
  assert.ok(db.listings.get(slowAe.id), 'hidden, not deleted');
  assert.strictEqual(D.status().hidden, 2);
});
