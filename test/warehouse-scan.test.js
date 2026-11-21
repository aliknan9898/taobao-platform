'use strict';
/* Warehouse scanning: a second scan never silently overwrites the first, weights are grams, readback says what to do next. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'whs-'));
const db = require('../src/db');
const W = require('../src/services/warehouse');

const staff = db.users.insert({ email: 'w@kinan.test', role: 'warehouse', name: 'W' });
const order = db.orders.insert({ status: 'awaiting_parcels', currency: 'eur', total: 10, lines: [{ line_no: 1, title: 'Mug', props: 'White', qty: 2, price: 5, mp_sku_id: 'm1', seller_id: 's1' }, { line_no: 2, title: 'Plate', qty: 1, price: 5, mp_sku_id: 'm2', seller_id: 's1' }], shipping_address: { name: 'n', city: 'c', country: 'MT' } });
db.parcels.insert({ tracking: 'SF100', order_id: order.id, mp_sku_id: 'm1', status: 'expected' });
db.parcels.insert({ tracking: 'SF200', order_id: order.id, mp_sku_id: 'm2', status: 'expected' });

test('first scan receives and reads back the item and the next step', () => {
  const r = W.receive({ tracking: ' sf 100 ', location: 'A-01', weight_g: 350 }, staff);
  assert.strictEqual(r.matched, true);
  assert.strictEqual(r.readback.item, 'Mug — White × 2');
  assert.strictEqual(r.readback.parcels_received, 1);
  assert.strictEqual(r.readback.parcels_total, 2);
  assert.match(r.readback.next, /1 more parcel/);
  assert.strictEqual(r.readback.order_ref, order.id.slice(-8).toUpperCase());
});

test('scanning the same parcel again is reported and changes nothing', () => {
  const r = W.receive({ tracking: 'SF100', location: 'B-09', weight_g: 999 }, staff);
  assert.strictEqual(r.duplicate, true);
  const p = db.parcels.find((x) => x.tracking === 'SF100');
  assert.strictEqual(p.location, 'A-01');
  assert.strictEqual(p.weight_g, 350);
});

test('an explicit update changes only what was typed', () => {
  const r = W.receive({ tracking: 'SF100', location: '', weight_g: 360, update: true }, staff);
  assert.strictEqual(r.updated, true);
  const p = db.parcels.find((x) => x.tracking === 'SF100');
  assert.strictEqual(p.location, 'A-01', 'empty location keeps the shelf');
  assert.strictEqual(p.weight_g, 360);
  assert.strictEqual(p.updated_by, staff.id);
});

test('weights must be grams in a sane range', () => {
  for (const w of [-5, 0, 'abc', 80000]) assert.throws(() => W.receive({ tracking: 'SF200', weight_g: w }, staff), /grams/);
  assert.strictEqual(db.parcels.find((x) => x.tracking === 'SF200').status, 'expected', 'a refused scan records nothing');
});

test('last parcel in: readback says to photograph and pack', () => {
  const r = W.receive({ tracking: 'SF200', weight_g: 120 }, staff);
  assert.match(r.readback.next, /All parcels are here/);
});
