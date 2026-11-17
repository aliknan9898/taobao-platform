'use strict';
/* Parcel tracking: every step on the order, notifications only at the big moments. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trk-'));
const db = require('../src/db');
const T = require('../src/services/tracking');

const ev = (text, at, action = '') => ({ text, place: '', at, action });

test('steps are read as milestones (codes and words, several languages)', () => {
  assert.strictEqual(T.stepCode(ev('Departed from the origin airport', '')), 5);
  assert.strictEqual(T.stepCode(ev('x', '', 'LH_HO_IN_SUCCESS')), 5);
  assert.strictEqual(T.stepCode(ev('Departed from departure country/region', '')), 5);
  assert.strictEqual(T.stepCode(ev('Arrived at destination country/region', '')), 6);
  assert.strictEqual(T.stepCode(ev('Arrived at destination country', '')), 6);
  assert.strictEqual(T.stepCode(ev('Import customs clearance started', '')), 6);
  assert.strictEqual(T.stepCode(ev('Out for delivery', '')), 10);
  assert.strictEqual(T.stepCode(ev('Paket in Zustellung', '')), 10);
  assert.strictEqual(T.stepCode(ev('Delivered', '')), 12);
  assert.strictEqual(T.stepCode(ev('Delivery attempt unsuccessful', '')), 13);
  assert.strictEqual(T.stepCode(ev('Processing at sorting center', '')), null);
});

test('stage: furthest milestone; a newer delivery problem wins', () => {
  assert.strictEqual(T.stageOf([ev('Arrived at destination country', '2'), ev('Departed from the origin country', '1')]), 6);
  assert.strictEqual(T.stageOf([ev('Delivery attempt unsuccessful', '3'), ev('Out for delivery', '2'), ev('Arrived in destination', '1')]), 13);
  assert.strictEqual(T.stageOf([ev('Out for delivery', '4'), ev('Delivery attempt unsuccessful', '3'), ev('Out for delivery', '2')]), 10);
  assert.strictEqual(T.stageOf([ev('Delivered', '5'), ev('Out for delivery', '4')]), 12);
  assert.strictEqual(T.stageOf([ev('Processing at sorting center', '1')]), null);
});

test('Cainiao answers are parsed (place in brackets, newest first)', () => {
  const r = T.parseCainiao({ module: [{ mailNo: 'AP1', detailList: [
    { time: 1000, timeStr: '2026-11-17 14:52', desc: 'Leave the warehouse', actionCode: 'GWMS_OUTBOUND' },
    { time: 2000, timeStr: '2026-11-17 14:58', desc: '[Shatian Town] Processing at sorting center', actionCode: 'SC_INBOUND_SUCCESS' }] }] });
  assert.strictEqual(r.AP1.length, 2);
  assert.strictEqual(r.AP1[0].place, 'Shatian Town');
  assert.strictEqual(r.AP1[0].text, 'Processing at sorting center');
});

test('an order follows its parcel: notified once per milestone, delivered at the end', async () => {
  const u = db.users.insert({ email: 'b@x.test', role: 'buyer', name: 'B' });
  const o = db.orders.insert({ buyer_id: u.id, status: 'shipped', currency: 'usd', total: 10, lines: [{ line_no: 1, title: 'Cap', qty: 1, price: 10, direct: true, seller_id: 's1' }], shipping_address: { country_code: 'MT' },
    sub_orders: [{ outer_purchase_id: 'D1', seller_id: 's1', direct: true, source: 'aliexpress', status: 'AE_SHIPPED', line_nos: [1], logistics: [{ carrier: 'Cainiao', tracking: 'AP1' }] }], timeline: [] });
  let steps = [ev('Processing at sorting center', '1')];
  T._setFetcher(async () => ({ AP1: steps }));
  await T.refresh(o.id);
  let x = db.orders.get(o.id);
  assert.strictEqual(x.sub_orders[0].track.events.length, 1);
  assert.deepStrictEqual(x.notices || [], []); // ordinary steps: shown, not notified

  steps = [ev('Departed from the origin country', '2'), ...steps]; await T.refresh(o.id);
  steps = [ev('Arrived at destination country', '3'), ...steps]; await T.refresh(o.id);
  await T.refresh(o.id); // nothing new: no second notice
  x = db.orders.get(o.id);
  assert.deepStrictEqual((x.notices || []).filter((k) => k.startsWith('trk:')).map((k) => k.split(':').pop()), ['5', '6']);
  assert.strictEqual(x.sub_orders[0].track.status, 6);

  steps = [ev('Out for delivery', '4'), ...steps]; await T.refresh(o.id);
  steps = [ev('Delivered', '5'), ...steps]; await T.refresh(o.id);
  x = db.orders.get(o.id);
  assert.strictEqual(x.sub_orders[0].status, 'AE_DELIVERED');
  assert.strictEqual(x.status, 'delivered');
  assert.deepStrictEqual((x.notices || []).filter((k) => k.startsWith('trk:')).map((k) => k.split(':').pop()), ['5', '6', '10']);

  // the seller sees the same journey (without the customer's address)
  const sv = require('../src/services/orders').sellerView(x, 's1');
  assert.strictEqual(sv.purchase.track.stage, 12);
  assert.ok(sv.purchase.track.events.length >= 5);
  assert.ok(!('shipping_address' in sv));
  T._setFetcher(null);
});
