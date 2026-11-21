'use strict';
/* Admin exceptions queue: derived from live records, filterable, retry only where the purchase can be redone. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'exq-'));
const db = require('../src/db');
const X = require('../src/services/exceptions');

const admin = db.users.insert({ email: 'a@kinan.test', role: 'admin', name: 'Admin' });
const buyer = db.users.insert({ email: 'b@kinan.test', role: 'buyer', name: 'B' });
const base = { buyer_id: buyer.id, currency: 'eur', total: 10, lines: [{ line_no: 1, title: 'X', qty: 1, price: 10, seller_id: 's1' }], shipping_address: { name: 'n', city: 'c', country: 'MT' } };
const failedTb = db.orders.insert({ ...base, status: 'procuring', sub_orders: [{ seller_id: 's1', outer_purchase_id: 'PO-A', status: 'CREATE_FAILED', error: 'Taobao refused the order' }] });
const placedAe = db.orders.insert({ ...base, status: 'procuring', sub_orders: [{ direct: true, source: 'aliexpress', seller_id: 's1', outer_purchase_id: 'PO-B', status: 'AE_PAID', purchase_ids: ['8001'], error: 'Seller did not ship' }] });
const lost = db.orders.insert({ ...base, status: 'shipped', sub_orders: [{ direct: true, source: 'cj', seller_id: 's1', outer_purchase_id: 'PO-C', status: 'AE_SHIPPED', logistics: [{ carrier: 'YunExpress', tracking: 'YT1' }], track: { status: 13, events: [{ text: 'Delivery attempt unsuccessful' }], at: Date.now() } }] });
db.orders.insert({ ...base, status: 'delivered', sub_orders: [{ seller_id: 's1', outer_purchase_id: 'PO-D', status: 'CREATE_FAILED', error: 'old' }] }); // closed orders are not exceptions
db.parcels.insert({ tracking: 'SF999', unmatched: true, status: 'received', received_at: Date.now() });
db.listings.insert({ source: 'cj', status: 'active', sync_error: 'CJ timeout', sync_tried_at: Date.now() });

test('items come from failed purchases, carriers, the warehouse and syncs', () => {
  const r = X.list({}, admin);
  const keys = r.items.map((x) => x.key);
  assert.ok(keys.includes(`supplier:${failedTb.id}:PO-A`));
  assert.ok(keys.includes(`supplier:${placedAe.id}:PO-B`));
  assert.ok(keys.includes(`carrier:${lost.id}:PO-C`));
  assert.ok(keys.some((k) => k.startsWith('unmatched:')));
  assert.ok(keys.includes('sync:cj'));
  assert.ok(!keys.some((k) => k.includes('PO-D')), 'delivered orders are left out');
  assert.strictEqual(r.items[0].severity, 'high', 'most severe first');
});

test('retry is offered only when the purchase can be created again', () => {
  const r = X.list({ area: 'supplier' }, admin).items;
  assert.strictEqual(r.find((x) => x.key.endsWith('PO-A')).retry.eligible, true);
  const ae = r.find((x) => x.key.endsWith('PO-B'));
  assert.strictEqual(ae.retry.eligible, false);
  assert.match(ae.retry.why, /already exists/);
});

test('filters by area, provider and result', () => {
  assert.ok(X.list({ provider: 'aliexpress' }, admin).items.every((x) => x.provider === 'aliexpress'));
  assert.ok(X.list({ result: 'failed' }, admin).items.every((x) => x.result === 'failed'));
  const f = X.list({}, admin).facets;
  assert.ok(f.area.some((a) => a.value === 'carrier'));
});

test('assigning: staff only, open items only, shows on the item', () => {
  const key = `supplier:${failedTb.id}:PO-A`;
  assert.throws(() => X.assign(key, { assignee_id: buyer.id }, admin), /staff member/);
  assert.throws(() => X.assign('order:nope', { assignee_id: admin.id }, admin), /no longer open/);
  X.assign(key, { assignee_id: admin.id, note: 'Calling the seller' }, admin);
  const it = X.list({ mine: '1' }, admin).items;
  assert.strictEqual(it.length, 1);
  assert.strictEqual(it[0].assignee, 'Admin');
  assert.strictEqual(it[0].note, 'Calling the seller');
});
