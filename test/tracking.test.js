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
  assert.strictEqual(T.stepCode(ev('Import customs clearance started', '')), 7);
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

test('two parcels of one order are tracked apart: one delivered, the other still travelling', async () => {
  const u = db.users.insert({ email: 'two@x.test', role: 'buyer', name: 'T' });
  const o = db.orders.insert({ buyer_id: u.id, status: 'shipped', currency: 'usd', total: 20, shipping_address: { country_code: 'MT' },
    lines: [{ line_no: 1, title: 'Cap', qty: 1, price: 10, direct: true, seller_id: 's1' }, { line_no: 2, title: 'Mug', qty: 1, price: 10, direct: true, seller_id: 's2' }],
    sub_orders: [
      { outer_purchase_id: 'P1', seller_id: 's1', direct: true, source: 'aliexpress', status: 'AE_SHIPPED', line_nos: [1], logistics: [{ carrier: 'Cainiao', tracking: 'AP_A' }] },
      { outer_purchase_id: 'P2', seller_id: 's2', direct: true, source: 'aliexpress', status: 'AE_SHIPPED', line_nos: [2], logistics: [{ carrier: 'Cainiao', tracking: 'AP_B' }] }], timeline: [] });
  T._setFetcher(async (nums) => ({ AP_A: [ev('Delivered', '2'), ev('Out for delivery', '1')], AP_B: [ev('Departed from the origin country', '1')] }));
  await T.refresh(o.id);
  const x = db.orders.get(o.id);
  assert.deepEqual(x.sub_orders.map((s) => [s.outer_purchase_id, s.status, s.track.status]), [['P1', 'AE_DELIVERED', 12], ['P2', 'AE_SHIPPED', 5]]);
  assert.notEqual(x.status, 'delivered');
  const keys = (x.notices || []).filter((k) => k.startsWith('trk:'));
  assert.ok(keys.some((k) => k.includes(':P1:12')) && keys.some((k) => k.includes(':P2:5')), JSON.stringify(keys));
  T._setFetcher(null);
});

test('carrier handoff, failed attempt, pickup and return have distinct stages', () => {
  assert.strictEqual(T.stepCode(ev('Package not accepted by local delivery company.Package not yet arrived in local destination/destination country', '', 'EXCEPTION')), 90);
  assert.strictEqual(T.stepCode(ev('Delivery attempt unsuccessful', '')), 13);
  assert.strictEqual(T.stepCode(ev('Available for pickup', '')), 11);
  assert.strictEqual(T.stepCode(ev('Returning to sender', '')), 14);
  const events = [ev('Delivery attempt unsuccessful', '3'), ev('Out for delivery', '2'), ev('Arrived at destination country', '1')];
  assert.deepStrictEqual(T.transitions({ status: 6, events: events.slice(2) }, events, T.stageOf(events)).map(({ code }) => code), [10, 13]);
});

test('warehouse parcel sends email and push for each new delivery event, with pickup instructions', async (t) => {
  const notifyMail = t.mock.method(require('../src/mailer'), 'send', async () => {});
  const push = t.mock.method(require('../src/push'), 'toUser', () => {});
  const user = db.users.insert({ email: 'shipping@x.test', lang: 'ar' });
  const shipment = db.shipments.insert({ tracking: 'WH_TRACK', carrier: 'Carrier', status: 'in_transit',
    track: { status: 9, at: 0, events: [ev('Received by local carrier', '1')] } });
  const order = db.orders.insert({ buyer_id: user.id, status: 'shipped', shipment_id: shipment.id, currency: 'eur',
    total: 15, shipping_fee: 5, lines: [{ title: 'Cap', qty: 1, price: 10 }], timeline: [] });
  T._setFetcher(async () => ({ WH_TRACK: [ev('Ready for pickup', '4'), ev('Delivery attempt unsuccessful', '3'),
    ev('Out for delivery', '2'), ev('Received by local carrier', '1')] }));
  t.after(() => T._setFetcher(null));
  await T.refresh(order.id);
  await T.refresh(order.id);
  assert.strictEqual(db.shipments.get(shipment.id).track.status, 11);
  const messages = notifyMail.mock.calls.map((call) => call.arguments[0]);
  assert.deepStrictEqual(messages.map((message) => message.key.split(':').pop()), ['10', '13', '11']);
  assert.strictEqual(push.mock.callCount(), 3);
  assert.ok(messages.every((message) => message.lines.some((line) => line.includes('Cap'))));
  assert.match(messages[2].ar.lines.join(' '), /قبل المهلة.*يعيده الناقل/);
});

test('shipping email keeps order details without the van', async (t) => {
  const { config } = require('../src/config');
  const before = [config.publicBaseUrl, config.mail.brevoKey, config.mail.from];
  t.after(() => { [config.publicBaseUrl, config.mail.brevoKey, config.mail.from] = before; });
  [config.publicBaseUrl, config.mail.brevoKey, config.mail.from] = ['https://kinan.test', 'mock-key', 'noreply@kinan.test'];
  const transport = t.mock.method(global, 'fetch', async () => ({ ok: true }));
  const response = await require('../src/mailer').send({ to: 'shipping@x.test', subject: 'Fixture', lines: ['Order details'] });
  assert.strictEqual(response.status, 'sent');
  const payload = JSON.parse(transport.mock.calls[0].arguments[1].body);
  assert.doesNotMatch(payload.htmlContent, /kinan-delivery-van/);
  assert.match(payload.htmlContent, /Order details/);
});

test('17TRACK registers unknown numbers and merges origin and last-mile events without exposing locations', async (context) => {
  const provider = require('../src/services/track17');
  const number = 'LZ123456789CN';
  const requests = [];
  context.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ endpoint: url.split('/').pop(), body: JSON.parse(options.body) });
    assert.equal(options.headers['17token'], 'test-key');
    const event = (stage, time_utc, description, location) => ({ stage, time_utc, description, location });
    const data = requests.length === 1
      ? { rejected: [{ number, error: { code: -18019902 } }] }
      : { accepted: [{ number, track_info: { tracking: { providers: [
        { provider: { name: 'China Post' }, events: [event('InTransit_Departure', '2026-11-25T13:00:00Z', 'Departed', 'China')] },
        { provider: { name: 'Malta Post' }, events: [event('OutForDelivery', '2026-11-28T08:00:00Z', 'Out', 'Malta')] }
      ] } } }] };
    return { ok: true, json: async () => ({ code: 0, data }) };
  });
  const before = await provider.fetchTracking([number, 'CAINIAO_FULFILLMENT_STD'], 'test-key');
  assert.equal(before[number], undefined);
  assert.deepEqual(requests, [
    { endpoint: 'gettrackinfo', body: [{ number }] },
    { endpoint: 'register', body: [{ number }] }
  ]);
  const after = await provider.fetchTracking([number], 'test-key');
  assert.deepEqual(after[number].map((entry) => entry.carrier), ['Malta Post', 'China Post']);
  assert.equal(T.stageOf(after[number]), 10);
  assert.deepEqual(provider.customerEvents(after[number]), [
    { at: '2026-11-28T08:00:00.000Z', text: 'Out for delivery' },
    { at: '2026-11-25T13:00:00.000Z', text: 'Departed from origin' }
  ]);
});
