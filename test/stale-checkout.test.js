'use strict';
/* Task 11: a supplier price or stock that cannot be confirmed for too long never reaches a paid order. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'));
for (const k of ['CJ_API_KEY', 'STRIPE_SECRET_KEY', 'DATABASE_URL']) delete process.env[k];
Object.assign(process.env, { EU_DUTY_EUR: '0', EU_IMPORT_HANDLING: '0' });
const db = require('../src/db');
const orders = require('../src/services/orders');

const seller = db.sellers.insert({ shop_name: 'Atlas', status: 'active', kyc: { state: 'approved' } });
const buyer = db.users.insert({ email: 'b@x.test', role: 'buyer', name: 'B', status: 'active' });
const addr = { name: 'C', phone: '+35699999999', country_code: 'GB', city: 'London', line1: '1 St', postcode: 'E1 1AA' };
const mk = (ageHours, extra = {}) => db.listings.insert({ seller_id: seller.id, title: `CJ lamp ${ageHours}h`, status: 'active', source: 'cj', fulfillment: 'direct', cj_pid: 'P1', cj_from: 'GB', currency: 'usd', images: ['https://x/1.jpg'],
  skus: [{ mp_sku_id: '1', cj_vid: 'V1', price: 30, cost_sale: 5, stock: 10, props: 'One' }], last_synced_at: Date.now() - ageHours * 3600e3, ...extra });

test('supplier cannot be asked and the last check is 3 days old: checkout refused with a clear message', async () => {
  const l = mk(72);
  await assert.rejects(orders.checkout(buyer, { items: [{ listing_id: l.id, mp_sku_id: '1', qty: 1 }], shipping_address: addr }), (e) => e.status === 409 && /cannot confirm the current price/.test(e.message));
  assert.equal(db.orders.all().length, 0);
});

test('supplier cannot be asked but the last check is recent: the last known price is used and recorded on the line', async () => {
  const l = mk(5);
  const o = await orders.checkout(buyer, { items: [{ listing_id: l.id, mp_sku_id: '1', qty: 1 }], shipping_address: addr });
  assert.equal(o.lines[0].checked_at, l.last_synced_at);
});

test('a sold-out option is refused whatever the age', async () => {
  const l = mk(1, { skus: [{ mp_sku_id: '1', cj_vid: 'V1', price: 30, cost_sale: 5, stock: 0, props: 'One' }] });
  await assert.rejects(orders.checkout(buyer, { items: [{ listing_id: l.id, mp_sku_id: '1', qty: 1 }], shipping_address: addr }), (e) => e.status === 409);
});

test('the limit is configurable (CHECKOUT_STALE_HOURS)', async () => {
  process.env.CHECKOUT_STALE_HOURS = '100';
  const l = mk(72);
  const o = await orders.checkout(buyer, { items: [{ listing_id: l.id, mp_sku_id: '1', qty: 1 }], shipping_address: addr });
  assert.ok(o.id);
  delete process.env.CHECKOUT_STALE_HOURS;
});
