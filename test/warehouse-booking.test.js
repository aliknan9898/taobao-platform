'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-booking-'));
const db = require('../src/db');
const couriers = require('../src/services/couriers');
const warehouse = require('../src/services/warehouse');
const booking = require('../src/services/warehouseBooking');
const exceptions = require('../src/services/exceptions');
const inbound = require('../src/services/libyaInbound');

const staff = { id: 'staff', role: 'admin' };
const body = { carrier: 'dhl', code: 'P', price: 10, weight_g: 1000, length_cm: 30, width_cm: 20, height_cm: 10 };
function order(patch = {}) {
  return db.orders.insert({
    status: 'ready_to_ship', buyer_id: 'buyer', currency: 'EUR', subtotal: 20,
    lines: [{ title: 'Test item', qty: 1, price: 20 }], timeline: [],
    shipping_address: { country_code: 'MT', city: 'Test city', name: 'Customer', line1: 'Test address' },
    ...patch,
  });
}
function setup(t, label) {
  t.mock.method(couriers, 'validateLabelRequest', () => {});
  return t.mock.method(couriers, 'label', label);
}

test('blocked consolidation never calls the courier', async (t) => {
  const courier = setup(t, () => assert.fail('unexpected booking'));
  const first = order();
  const held = order({ hold: true });
  await assert.rejects(booking.book(first.id, { ...body, with: [held.id] }, staff), { status: 409 });
  assert.equal(courier.mock.callCount(), 0);
  assert.equal(db.shipment_bookings.find((row) => row.order_id === first.id), undefined);
});

test('orders for different apartments cannot use the same carrier label', async (t) => {
  const courier = setup(t, () => assert.fail('unexpected booking'));
  const first = order();
  const second = order({ shipping_address: { ...first.shipping_address, line2: 'Flat 2' } });
  await assert.rejects(booking.book(first.id, { ...body, with: [second.id] }, staff), { status: 400 });
  assert.equal(courier.mock.callCount(), 0);
});

test('one booking covers concurrent requests, with customs data for both orders', async (t) => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const courier = setup(t, async (shipment) => {
    assert.equal(shipment.subtotal, 40);
    assert.equal(shipment.lines.length, 2);
    await gate;
    return { carrier: 'DHL', tracking: 'TRACK-ONE' };
  });
  const first = order();
  const second = order();
  const request = { ...body, with: [second.id] };
  const one = booking.book(first.id, request, staff);
  const two = booking.book(first.id, request, staff);
  try {
    assert.throws(() => warehouse.ship(second.id, { carrier: 'DHL', tracking: 'OTHER' }, staff), { status: 409 });
    await assert.rejects(booking.book(second.id, body, staff), { status: 409 });
    await assert.rejects(booking.book(first.id, { ...request, weight_g: 2000 }, staff), { status: 409 });
  } finally { unblock(); }
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.id, b.id);
  assert.equal((await booking.book(first.id, request, staff)).id, a.id);
  assert.equal(courier.mock.callCount(), 1);
  assert.equal(db.orders.get(second.id).shipment_id, a.id);
});

test('uncertain carrier outcome requires a recorded release before another call', async (t) => {
  const courier = setup(t, async () => { throw new Error('timeout'); });
  const o = order();
  await assert.rejects(booking.book(o.id, body, staff), { status: 502 });
  await assert.rejects(booking.book(o.id, body, staff), { status: 409 });
  assert.equal(courier.mock.callCount(), 1);
  const item = exceptions.collect().find((row) => row.order_id === o.id && row.booking_id);
  assert.ok(item);
  assert.throws(() => booking.release(item.booking_id, {}, staff), { status: 400 });
  await booking.release(item.booking_id, { confirmation: 'CARRIER_CONFIRMED', note: 'Test carrier confirmed no label' }, staff);
  assert.equal(exceptions.collect().some((row) => row.booking_id === item.booking_id), false);
});

test('a saved label can be finalized after resolving a hold, without calling the courier again', async (t) => {
  const o = order();
  const courier = setup(t, async () => {
    db.orders.update(o.id, { hold: true });
    return { carrier: 'DHL', tracking: 'TRACK-RECOVER' };
  });
  await assert.rejects(booking.book(o.id, body, staff), { status: 409 });
  const saved = db.shipment_bookings.find((row) => row.order_id === o.id);
  assert.equal(saved.carrier_result.tracking, 'TRACK-RECOVER');
  db.orders.update(o.id, { hold: false });
  assert.equal((await booking.finalize(saved.id, staff)).tracking, 'TRACK-RECOVER');
  assert.equal(courier.mock.callCount(), 1);
});

test('a Libya carton count discrepancy creates a warehouse exception', () => {
  const carton = db.ly_inbound.insert({ tracking: 'TEST-CARTON', source_tracking: [], items: [{ qty: 2 }] });
  assert.throws(() => inbound.receive(staff, carton.tracking, [1]), { status: 409 });
  const item = exceptions.list({ area: 'warehouse' }).items.find((row) => row.key === `carton:${carton.id}`);
  assert.match(item.detail, /1 line/);
  assert.equal(db.ly_inbound.get(carton.id).received_at, undefined);
  assert.equal(inbound.receive(staff, carton.tracking, [2]).status, 'received');
  assert.equal(exceptions.collect().some((row) => row.key === item.key), false);
});


test('outbound tracking problems appear in the warehouse queue and clear after delivery', () => {
  const o = order();
  const parcel = db.shipments.insert({ order_id: o.id, status: 'in_transit', carrier: 'DHL', tracking: 'TRACK-FAILED',
    shipped_at: Date.now(), track: { status: 13 } });
  const key = `warehouse-tracking:${parcel.id}`;
  assert.equal(exceptions.list({ area: 'warehouse' }).items.find((item) => item.key === key)?.result, 'failed');
  db.shipments.update(parcel.id, { status: 'delivered' });
  assert.equal(exceptions.collect().some((item) => item.key === key), false);
});
