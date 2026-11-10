// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * China warehouse: inbound parcels from Taobao sellers → receive/QC/shelve →
 * consolidate per buyer order → outbound international shipment.
 * Note: per the Distribution Platform agreement (cl. 6.1) goods count as DELIVERED once signed
 * for at your China warehouse. After they leave it, Taobao returns are no longer possible —
 * so QC must happen here, before packing.
 */
const db = require('../db');
const notify = require('../notify');
const orders = require('./orders');
const { httpError } = require('../auth');

const PARCEL_LABEL = { expected: 'Expected', received: 'Received', qc_failed: 'QC failed', packed: 'Packed' };

function normTracking(t) { return String(t || '').trim().toUpperCase().replace(/\s+/g, ''); }

/** Scan a tracking number at the dock. Unknown parcels are recorded for manual matching. */
function receive({ tracking, location, weight_g, qc = 'pass', notes }, staff) {
  const tr = normTracking(tracking);
  if (!tr) throw httpError(400, 'Tracking number is required');
  let p = db.parcels.find((x) => normTracking(x.tracking) === tr);
  const patch = {
    status: qc === 'fail' ? 'qc_failed' : 'received',
    location: String(location || '').slice(0, 40) || null,
    weight_g: weight_g ? Number(weight_g) : null,
    notes: String(notes || '').slice(0, 300) || null,
    received_at: Date.now(), received_by: staff.id
  };
  if (!p) {
    p = db.parcels.insert({ tracking: tr, order_id: null, unmatched: true, ...patch });
    return { parcel: p, matched: false };
  }
  if (p.status === 'packed') throw httpError(409, 'Parcel is already packed in a shipment');
  p = db.parcels.update(p.id, patch);
  if (p.order_id) orders.recompute(p.order_id);
  return { parcel: p, matched: Boolean(p.order_id) };
}

function assign(parcelId, orderId) {
  const p = db.parcels.get(parcelId);
  const o = db.orders.get(orderId);
  if (!p || !o) throw httpError(404, 'Not found');
  const r = db.parcels.update(p.id, { order_id: o.id, unmatched: false });
  orders.recompute(o.id);
  return r;
}

/** Pack all received parcels of an order into one outbound shipment. */
function ship(orderId, { carrier, tracking, weight_g }, staff) {
  const o = db.orders.get(orderId);
  if (!o) throw httpError(404, 'Order not found');
  if (o.status !== 'ready_to_ship') throw httpError(409, 'Order is not ready to ship (all parcels must be received and pass QC)');
  if (!carrier || !tracking) throw httpError(400, 'Carrier and tracking number are required');
  const parcels = db.parcels.all((p) => p.order_id === o.id && p.status === 'received');
  const s = db.shipments.insert({
    order_id: o.id, parcel_ids: parcels.map((p) => p.id), carrier: String(carrier).slice(0, 60),
    tracking: String(tracking).slice(0, 60), weight_g: weight_g ? Number(weight_g) : null,
    destination: { country: o.shipping_address.country, city: o.shipping_address.city },
    shipped_at: Date.now(), shipped_by: staff.id, status: 'in_transit'
  });
  for (const p of parcels) db.parcels.update(p.id, { status: 'packed', shipment_id: s.id });
  db.orders.update(o.id, (x) => ({ ...x, status: 'shipped', shipment_id: s.id, timeline: [...x.timeline, { at: Date.now(), event: 'shipped', tracking: s.tracking }] }));
  // Settle the shipping price with the real weight (overpaid → wallet credit, underpaid → amount due)
  const grams = Number(weight_g) || parcels.reduce((a, p) => a + (Number(p.weight_g) || 0), 0);
  try { require('./shipping').settleAfterWeighing(db.orders.get(o.id), grams); } catch (e) { console.error('[shipping] settle failed', e.message); }
  notify.orderShipped(db.orders.get(o.id), [{ carrier: s.carrier, number: s.tracking }]);
  return s;
}

function markDelivered(orderId) {
  const o = db.orders.get(orderId);
  if (!o || o.status !== 'shipped') throw httpError(409, 'Order has not been shipped yet');
  if (o.shipment_id) db.shipments.update(o.shipment_id, { status: 'delivered', delivered_at: Date.now() });
  for (const l of db.ledger.all((x) => x.order_id === o.id && x.status === 'pending_payout')) db.ledger.update(l.id, { status: 'payable' });
  const out = db.orders.update(o.id, (x) => ({ ...x, status: 'delivered', timeline: [...x.timeline, { at: Date.now(), event: 'delivered' }] }));
  notify.orderDelivered(out);
  return out;
}

/** Inventory overview = what is physically in the warehouse right now. */
function inventory() {
  const parcels = db.parcels.all((p) => ['received', 'qc_failed'].includes(p.status) || p.unmatched);
  const byLocation = {};
  for (const p of parcels) (byLocation[p.location || '—'] = byLocation[p.location || '—'] || []).push(p.id);
  return {
    counts: {
      expected: db.parcels.all((p) => p.status === 'expected').length,
      in_stock: parcels.filter((p) => p.status === 'received').length,
      qc_failed: parcels.filter((p) => p.status === 'qc_failed').length,
      unmatched: parcels.filter((p) => p.unmatched).length,
      ready_orders: db.orders.all((o) => o.status === 'ready_to_ship').length,
      in_transit: db.shipments.all((s) => s.status === 'in_transit').length
    },
    by_location: byLocation
  };
}

function parcelView(p) {
  const o = p.order_id ? db.orders.get(p.order_id) : null;
  const line = o?.lines.find((l) => l.mp_sku_id === p.mp_sku_id);
  return { ...p, status_label: PARCEL_LABEL[p.status] || p.status, order_status: o?.status, item: line ? `${line.title} — ${line.props} × ${line.qty}` : null, shop: db.sellers.get(p.seller_id)?.shop_name };
}

function lists() {
  const readyOrders = db.orders.all((o) => ['ready_to_ship', 'awaiting_parcels', 'attention'].includes(o.status)).map((o) => {
    const ps = db.parcels.all((p) => p.order_id === o.id);
    return { id: o.id, status: o.status, status_label: orders.ORDER_STATUS_LABEL[o.status], destination: `${o.shipping_address.city}, ${o.shipping_address.country}`, recipient: o.shipping_address.name, parcels_total: ps.length, parcels_received: ps.filter((p) => p.status === 'received').length, items: o.lines.reduce((a, l) => a + l.qty, 0) };
  });
  return {
    expected: db.parcels.all((p) => p.status === 'expected').map(parcelView),
    in_stock: db.parcels.all((p) => p.status === 'received' || p.status === 'qc_failed' || p.unmatched).map(parcelView),
    orders: readyOrders,
    shipments: db.shipments.all().slice(-50).reverse()
  };
}

module.exports = { receive, assign, ship, markDelivered, inventory, lists, PARCEL_LABEL };
