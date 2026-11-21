'use strict';
/* Tasks 16-17: seller statements reconcile commission and a partial refund; warehouse boxes combine only
   same-customer same-address orders, and a replayed "ship" does not book a second shipment. Synthetic data. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
for (const k of ['STRIPE_SECRET_KEY', 'DATABASE_URL']) delete process.env[k];
const db = require('../src/db');
const orders = require('../src/services/orders');
const money = require('../src/services/money');
const warehouse = require('../src/services/warehouse');

test('seller statement: sale net after commission, then a partial refund, reconcile to the cent', async () => {
  const s = db.sellers.insert({ shop_name: 'Atlas', status: 'active', commission_pct: 10 });
  const o = db.orders.insert({ buyer_id: 'usr_b', status: 'pending_payment', currency: 'usd', total: 50, subtotal: 50, payment: { provider: 'demo' },
    lines: [{ line_no: '1', seller_id: s.id, price: 30, qty: 1, title: 'Lamp' }, { line_no: '2', seller_id: s.id, price: 20, qty: 1, title: 'Bulb' }], sub_orders: [], timeline: [] });
  await orders.markPaid(o.id, { provider: 'demo' }).catch(() => {}); // procurement of these synthetic lines may fail: the ledger is written first
  const sale = db.ledger.find((x) => x.order_id === o.id && x.type === 'sale');
  assert.equal(sale.gross, 50); assert.equal(sale.commission, 5); assert.equal(sale.net, 45);
  assert.equal(money.sellerBalance(s.id).pending, 45);
  db.ledger.update(sale.id, { status: 'payable' }); // after delivery + return window
  db.orders.update(o.id, { status: 'delivered' });
  const ret = db.returns.insert({ order_id: o.id, buyer_id: 'usr_b', lines: ['2'], reason: 'damaged', value: 20, status: 'approved' });
  await money.decideReturn(ret.id, { action: 'refund', amount: 20 }, { id: 'usr_admin' });
  const bal = money.sellerBalance(s.id);
  assert.equal(bal.available, 25); // 45 earned − 20 refunded
  const lines = db.ledger.all((x) => x.seller_id === s.id).map((x) => x.net);
  assert.equal(Math.round(lines.reduce((a, n) => a + n, 0) * 100) / 100, 25);
});

test('warehouse: one box for two orders of the same customer and address; different address refused; replay refused', () => {
  const addr = { name: 'Ali', country_code: 'MT', country: 'Malta', city: 'Naxxar', line1: '40 Magro', postal_code: 'NXR 6015' };
  const mk = (buyer, a) => db.orders.insert({ buyer_id: buyer, status: 'ready_to_ship', currency: 'usd', total: 10, shipping_fee: 5, shipping_address: a, lines: [], sub_orders: [], timeline: [] });
  const a1 = mk('usr_1', addr); const a2 = mk('usr_1', { ...addr }); const other = mk('usr_1', { ...addr, line1: '1 Other St' }); const stranger = mk('usr_2', addr);
  const staff = { id: 'usr_wh' };
  assert.throws(() => warehouse.ship(a1.id, { carrier: 'DHL', tracking: 'T1', with: [other.id] }, staff), /same address/);
  assert.throws(() => warehouse.ship(a1.id, { carrier: 'DHL', tracking: 'T1', with: [stranger.id] }, staff), /same customer/);
  const s = warehouse.ship(a1.id, { carrier: 'DHL', tracking: 'T1', with: [a2.id] }, staff);
  assert.deepEqual(s.order_ids.sort(), [a1.id, a2.id].sort());
  assert.equal(db.orders.get(a2.id).shipment_id, s.id);
  assert.throws(() => warehouse.ship(a1.id, { carrier: 'DHL', tracking: 'T1' }, staff), /not ready to ship/);
  assert.equal(db.shipments.all((x) => x.order_ids.includes(a1.id)).length, 1);
});
