'use strict';
/* Task 15: a partial refund moves money once, even with a double click; ledger and return agree. Stripe is mocked. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-'));
delete process.env.DATABASE_URL;
const db = require('../src/db');
const stripe = require('../src/payments/stripe');
const money = require('../src/services/money');

const admin = { id: 'usr_admin' };
const sA = db.sellers.insert({ shop_name: 'A', status: 'active' }); const sB = db.sellers.insert({ shop_name: 'B', status: 'active' });
const order = db.orders.insert({ buyer_id: 'usr_buyer', status: 'delivered', currency: 'usd', total: 50, payment: { provider: 'stripe', intent_id: 'pi_1' },
  lines: [{ line_no: '1', seller_id: sA.id, price: 30, qty: 1, title: 'Lamp' }, { line_no: '2', seller_id: sB.id, price: 20, qty: 1, title: 'Bulb' }], timeline: [{ at: Date.now(), event: 'delivered' }] });

test('double click on "refund to card": one Stripe refund, one ledger line, return refunded', async (t) => {
  const calls = [];
  t.mock.method(stripe, 'refund', async (o, a, key) => { calls.push({ a, key }); await new Promise((r) => setTimeout(r, 30)); return { id: 're_1' }; });
  const ret = db.returns.insert({ order_id: order.id, buyer_id: 'usr_buyer', lines: ['1'], reason: 'damaged', value: 30, status: 'approved' });
  const results = await Promise.allSettled([1, 2].map(() => money.decideReturn(ret.id, { action: 'refund', refund_to: 'card' }, admin)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, `ret_${ret.id}`);
  const ledger = db.ledger.all((x) => x.order_id === order.id && x.type === 'refund');
  assert.deepEqual(ledger.map((x) => [x.seller_id, x.net]), [[sA.id, -30]]);
  assert.equal(db.returns.get(ret.id).status, 'refunded');
  assert.equal(db.orders.get(order.id).timeline.filter((e) => /^refund:/.test(e.event)).length, 1);
});

test('a second partial return of equal amount is a separate refund; the order total caps both', async (t) => {
  const calls = [];
  t.mock.method(stripe, 'refund', async (o, a, key) => { calls.push({ a, key }); return { id: 're_2' }; });
  const ret2 = db.returns.insert({ order_id: order.id, buyer_id: 'usr_buyer', lines: ['2'], reason: 'damaged', value: 20, status: 'approved' });
  await assert.rejects(money.decideReturn(ret2.id, { action: 'refund', refund_to: 'card', amount: 25 }, admin), /between 0 and 20/);
  assert.equal(db.returns.get(ret2.id).status, 'approved');
  await money.decideReturn(ret2.id, { action: 'refund', refund_to: 'card', amount: 20 }, admin);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].key, undefined);
  assert.deepEqual(db.ledger.all((x) => x.order_id === order.id && x.type === 'refund').map((x) => x.seller_id).sort(), [sA.id, sB.id].sort());
});

test('a failed Stripe refund leaves the return as it was, to try again', async (t) => {
  const o2 = db.orders.insert({ buyer_id: 'usr_buyer', status: 'delivered', currency: 'usd', total: 10, payment: { provider: 'stripe', intent_id: 'pi_2' }, lines: [{ line_no: '1', seller_id: sA.id, price: 10, qty: 1 }], timeline: [] });
  const ret = db.returns.insert({ order_id: o2.id, buyer_id: 'usr_buyer', lines: ['1'], reason: 'damaged', value: 10, status: 'approved' });
  t.mock.method(stripe, 'refund', async () => { throw new Error('card network down'); });
  await assert.rejects(money.decideReturn(ret.id, { action: 'refund', refund_to: 'card' }, admin), /network down/);
  assert.equal(db.returns.get(ret.id).status, 'approved');
  assert.equal(db.ledger.all((x) => x.order_id === o2.id).length, 0);
});
