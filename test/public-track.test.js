'use strict';
/* Public order tracking: reference + email, one answer for every mismatch, customer-safe fields only. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrk-'));
const db = require('../src/db');
const T = require('../src/services/tracking');
const P = require('../src/services/publicTrack');

T._setFetcher(async () => ({})); // never reach a carrier from tests

const buyer = db.users.insert({ email: 'Buyer@Example.com', role: 'buyer', name: 'B' });
const other = db.users.insert({ email: 'other@example.com', role: 'buyer', name: 'O' });
const order = db.orders.insert({
  buyer_id: buyer.id, status: 'procuring', currency: 'eur', subtotal: 20, total: 25, shipping_fee: 5,
  shipping_address: { name: 'Secret Name', phone: '+356 0000', line1: '1 Hidden Street', city: 'Valletta', country_code: 'MT' },
  lines: [{ line_no: 1, title: 'Lamp', qty: 2, price: 10, cost_cny: 30, seller_id: 'sel_x', direct: true }],
  sub_orders: [{ direct: true, source: 'aliexpress', seller_id: 'sel_x', status: 'AE_SHIPPED', line_nos: [1], outer_purchase_id: 'PO1', supplier_order_id: 'AE-999', logistics: [{ carrier: 'Cainiao', tracking: 'LP123' }], track: { status: 6, events: [{ text: 'Arrived at destination country', place: 'MT', at: '2026-11-20 10:00' }] } }],
  timeline: [{ at: 1, event: 'Order placed' }]
});
const ref = order.id.slice(-8).toUpperCase();

test('reference is normalised from what customers type', () => {
  assert.strictEqual(P.normRef(` #${ref.toLowerCase()} `), ref);
  assert.strictEqual(P.normRef(`${ref.slice(0, 4)} ${ref.slice(4)}`), ref);
  assert.strictEqual(P.normRef(order.id), ref);
  assert.strictEqual(P.normRef('abc'), '');
});

test('the right reference and email (any case) find the order', async () => {
  const v = await P.lookup({ ref, email: '  buyer@example.COM ' });
  assert.strictEqual(v.ref, ref);
  assert.ok(['procuring', 'shipped'].includes(v.status), v.status); // refreshing the parcel may move the order on
  assert.ok(v.status_label);
  assert.ok(v.next.length > 10, 'tells the customer what happens next');
  assert.strictEqual(v.items, 2);
  assert.strictEqual(v.parcels.length, 1);
  assert.strictEqual(v.parcels[0].number, 'LP123');
  assert.strictEqual(v.parcels[0].track.stage, 6);
});

test('wrong email, wrong reference and missing fields give the same answer', async () => {
  for (const q of [{ ref, email: 'other@example.com' }, { ref: 'ZZZZZZZZ', email: 'buyer@example.com' }, { ref, email: '' }, { ref: '', email: 'buyer@example.com' }, {}]) {
    await assert.rejects(P.lookup(q), (e) => e.status === 404 && e.message === P.NOT_FOUND);
  }
  assert.ok(other.id);
});

test('the public answer leaves out personal and internal details', async () => {
  const v = await P.lookup({ ref, email: 'buyer@example.com' });
  const s = JSON.stringify(v);
  for (const secret of ['Secret Name', 'Hidden Street', '+356', 'AE-999', 'PO1', 'aliexpress', 'cost_cny', buyer.id, order.id, 'sel_x']) {
    assert.ok(!s.includes(secret), `leaks ${secret}`);
  }
  assert.ok(!('total' in v) && !('subtotal' in v), 'no amounts on the public page');
});
