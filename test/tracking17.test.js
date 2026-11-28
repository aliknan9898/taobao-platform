'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-track17-'));
process.env.TRACK17_API_KEY = 'fake-tracking-key';
process.env.TRACK17_ENABLED = '1';
const db = require('../src/db');
const { server } = require('../src/server');
const provider = require('../src/services/tracking17');
const tracking = require('../src/services/tracking');
const realFetch = global.fetch;
let base;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('register warehouse shipments and apply authenticated updates once to both orders', async (t) => {
  const shipment = db.shipments.insert({ carrier: 'DHL', tracking: 'TRACK-17', status: 'in_transit', shipped_at: Date.now() });
  const ids = [1, 2].map((i) => db.orders.insert({ buyer_id: `buyer-${i}`, status: 'shipped', shipment_id: shipment.id }).id);
  db.shipments.update(shipment.id, { order_id: ids[0], order_ids: ids });
  db.shipments.insert({ tracking: 'TRACK-OLD', status: 'in_transit', shipped_at: Date.now() - 31 * 86400e3 });
  const fetchMock = t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.17track.net/track/v2.4/register');
    assert.deepEqual(JSON.parse(options.body), [{ number: shipment.tracking, tag: shipment.id }]);
    return { ok: true, json: async () => ({ code: 0, data: { accepted: [{ number: shipment.tracking, carrier: 100001 }] } }) };
  });
  const notify = t.mock.method(require('../src/notify'), 'trackingStage', () => {});
  await Promise.all([provider.registerOpen(), provider.registerOpen()]);
  await provider.registerOpen();
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(db.shipments.get(shipment.id).track17.registered, true);

  const send = (status, minute, overrides = {}, badSignature = false) => {
    const raw = JSON.stringify({ event: 'TRACKING_UPDATED', data: { tag: shipment.id, number: shipment.tracking,
      carrier: 100001, track_info: { latest_status: { status }, latest_event: { time_utc: `2026-11-28T01:${minute}:00Z`, location: 'Private location' } },
      ...overrides } }, null, 2);
    const sign = createHash('sha256').update(raw + '/' + process.env.TRACK17_API_KEY).digest('hex');
    return realFetch(base + '/webhooks/17track', { method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', sign: badSignature ? '0'.repeat(64) : sign } });
  };
  assert.equal((await send('OutForDelivery', '10', {}, true)).status, 401);
  assert.equal((await send('OutForDelivery', '10', { carrier: 999 })).status, 200);
  assert.equal((await send('OutForDelivery', '10', { number: 'WRONG-NUMBER' })).status, 200);
  assert.equal(notify.mock.callCount(), 0);
  assert.equal((await send('OutForDelivery', '10')).status, 200);
  assert.equal((await send('DeliveryFailure', '15')).status, 200);
  assert.equal((await send('DeliveryFailure', '15')).status, 200);
  assert.equal((await send('Delivered', '12')).status, 200, 'older webhook is ignored');
  assert.equal(db.shipments.get(shipment.id).track.status, 13);
  assert.deepEqual(notify.mock.calls.map((call) => [call.arguments[0].id, call.arguments[2]]),
    [[ids[0], 10], [ids[1], 10], [ids[0], 13], [ids[1], 13]]);
  assert.doesNotMatch(JSON.stringify(db.shipments.get(shipment.id).track), /Private location/);
  tracking._setFetcher(async () => ({ [shipment.tracking]: [] }));
  t.after(() => tracking._setFetcher(null));
  await tracking.refresh(ids[0]);
  assert.equal(db.shipments.get(shipment.id).track.status, 13);
  assert.equal((await send('Delivered', '20')).status, 200);
  assert.equal(db.shipments.get(shipment.id).track.status, 12);
  assert.equal(db.orders.get(ids[0]).status, 'shipped', 'webhook does not run delivery settlement');
});

test('an unsuccessful registration is retried no sooner than the next day', async (t) => {
  const shipment = db.shipments.insert({ tracking: 'BACKOFF-17', status: 'in_transit', shipped_at: Date.now() });
  const mock = t.mock.method(global, 'fetch', async () => { throw new Error('timeout'); });
  await provider.registerOpen();
  await provider.registerOpen();
  assert.equal(mock.mock.callCount(), 1);
  assert.ok(db.shipments.get(shipment.id).track17.attempted_at);
  assert.equal(db.shipments.get(shipment.id).track17.registered, undefined);
});
