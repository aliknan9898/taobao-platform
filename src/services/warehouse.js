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

const money = (n) => Math.round(Number(n) * 100) / 100;
const sameAddress = (a, b) => ['country_code', 'city', 'line1', 'postal_code', 'name'].every((k) => String(a?.[k] || '').trim().toLowerCase() === String(b?.[k] || '').trim().toLowerCase());

/**
 * Pack all received parcels of an order into one outbound shipment.
 * `with` = other ready orders of the same customer and address to put in the same box (consolidation):
 * the customer paid shipping per order, so the saving from one combined box goes back to their wallet.
 */
function ship(orderId, { carrier, tracking, weight_g, cost, label, with: withIds = [] }, staff) {
  const o = db.orders.get(orderId);
  if (!o) throw httpError(404, 'Order not found');
  const group = [o, ...[...new Set((Array.isArray(withIds) ? withIds : []).map(String))].filter((id) => id !== o.id).map((id) => db.orders.get(id))];
  for (const x of group) {
    if (!x) throw httpError(404, 'Order not found');
    if (x.status !== 'ready_to_ship') throw httpError(409, `Order ${x.id.slice(-8)} is not ready to ship (all parcels must be received and pass QC)`);
    if (x.hold) throw httpError(409, `Order ${x.id.slice(-8)}: the customer asked us to store it until they tap “Ship now”`);
    if (x.qc_review === 'problem') throw httpError(409, `Order ${x.id.slice(-8)}: the customer reported a problem with the check photos — Kinan support must resolve it first`);
    if (x !== o && (x.buyer_id !== o.buyer_id || !sameAddress(x.shipping_address, o.shipping_address))) throw httpError(400, 'Only orders of the same customer going to the same address can share a box');
  }
  if (!carrier || !tracking) throw httpError(400, 'Carrier and tracking number are required');
  const parcels = db.parcels.all((p) => group.some((x) => x.id === p.order_id) && p.status === 'received');
  const s = db.shipments.insert({
    order_id: o.id, order_ids: group.map((x) => x.id), parcel_ids: parcels.map((p) => p.id), carrier: String(carrier).slice(0, 60),
    tracking: String(tracking).slice(0, 60), weight_g: weight_g ? Number(weight_g) : null,
    cost: Number(cost) > 0 ? Math.round(Number(cost) * 100) / 100 : null, // what Kinan paid the courier (for profit reports)
    label: label || null,
    destination: { country: o.shipping_address.country, city: o.shipping_address.city },
    shipped_at: Date.now(), shipped_by: staff.id, status: 'in_transit'
  });
  for (const p of parcels) db.parcels.update(p.id, { status: 'packed', shipment_id: s.id });
  for (const x of group) db.orders.update(x.id, (y) => ({ ...y, status: 'shipped', shipment_id: s.id, timeline: [...y.timeline, { at: Date.now(), event: 'shipped', tracking: s.tracking, ...(group.length > 1 ? { combined: group.length } : {}) }] }));
  // Settle the shipping price with the real weight (overpaid → wallet credit, underpaid → amount due)
  const grams = Number(weight_g) || parcels.reduce((a, p) => a + (Number(p.weight_g) || 0), 0);
  try {
    if (group.length === 1) require('./shipping').settleAfterWeighing(db.orders.get(o.id), grams);
    else settleGroup(group.map((x) => db.orders.get(x.id)), grams);
  } catch (e) { console.error('[shipping] settle failed', e.message); }
  for (const x of group) notify.orderShipped(db.orders.get(x.id), [{ carrier: s.carrier, number: s.tracking }]);
  return s;
}

/** One box for several orders: compare one combined shipping price with what was paid in total. */
function settleGroup(group, grams) {
  const shipping = require('./shipping'); const shop = require('./shop');
  const st = shipping.settings();
  if (st.mode !== 'weight' || !grams) return null;
  const paid = money(group.reduce((a, x) => a + (Number(x.shipping_fee) || 0), 0));
  const actual = shipping.priceFor(grams / 1000, group[0].shipping_address?.country_code).fee;
  const diff = money(actual - paid);
  const rec = { actual_weight_kg: Math.round(grams) / 1000, actual_fee: actual, diff, combined: group.map((x) => x.id), at: Date.now() };
  const ref = group.map((x) => x.id.slice(-8).toUpperCase()).join(', ');
  if (Math.abs(diff) < st.settle_tolerance) { for (const x of group) db.orders.update(x.id, { shipping_settled: { ...rec, result: 'within_tolerance' } }); return rec; }
  if (diff < 0) {
    shop.walletEntry(group[0].buyer_id, -diff, `Combined shipping saving — orders ${ref} shipped in one box`, { order_id: group[0].id, kind: 'shipping_refund' });
    for (const x of group) db.orders.update(x.id, { shipping_settled: { ...rec, result: 'credited' } });
  } else {
    db.orders.update(group[0].id, { shipping_due: diff, shipping_settled: { ...rec, result: 'due' } });
    for (const x of group.slice(1)) db.orders.update(x.id, { shipping_settled: { ...rec, result: 'due_on_other_order' } });
  }
  return rec;
}

// ---------------- Check photos (QC) ----------------
const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/** Warehouse adds photos of the received items; the customer looks at them before the box ships. */
function addQcPhotos(orderId, images, staff) {
  const o = db.orders.get(orderId);
  if (!o) throw httpError(404, 'Order not found');
  if (['pending_payment', 'cancelled', 'refunded', 'shipped', 'delivered'].includes(o.status)) throw httpError(409, 'Photos can be added only while the order is in the warehouse');
  const list = (Array.isArray(images) ? images : []).map(String);
  if (!list.length) throw httpError(400, 'Add at least one photo');
  if ((o.qc_photos || []).length + list.length > 8) throw httpError(400, 'Up to 8 photos per order');
  for (const im of list) { if (!IMG.test(im)) throw httpError(400, 'Photos must be JPEG, PNG or WebP'); if (im.length > 500 * 1024) throw httpError(400, 'A photo is too large'); }
  const out = db.orders.update(o.id, (x) => ({ ...x, qc_photos: [...(x.qc_photos || []), ...list.map((data) => ({ data, at: Date.now(), by: staff.id }))], qc_review: 'pending', qc_at: Date.now(), timeline: [...x.timeline, { at: Date.now(), event: 'qc_photos' }] }));
  try { notify.qcPhotos && notify.qcPhotos(out); } catch { /* email is best effort */ }
  return { photos: out.qc_photos.length, review: out.qc_review };
}

function qcPhoto(order, n) {
  const ph = (order.qc_photos || [])[Number(n) || 0];
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(ph?.data || '');
  return m ? { type: m[1], body: Buffer.from(m[2], 'base64') } : null;
}

/** Customer: photos look right (ship it) or something is wrong (Kinan support looks before it ships). */
function qcDecision(order, buyer, { ok, note }) {
  if (order.buyer_id !== buyer.id) throw httpError(404, 'Not found');
  if (!(order.qc_photos || []).length) throw httpError(409, 'There are no check photos for this order yet');
  if (['shipped', 'delivered'].includes(order.status)) throw httpError(409, 'This order has already shipped');
  const review = ok ? 'approved' : 'problem';
  if (!ok) require('../push').telegram(`⚠️ Customer reported a problem with the warehouse photos — order ${order.id.slice(-8).toUpperCase()}: ${String(note || '').slice(0, 200)}`);
  return db.orders.update(order.id, (x) => ({ ...x, qc_review: review, qc_note: ok ? null : String(note || '').slice(0, 500), timeline: [...x.timeline, { at: Date.now(), event: `qc_${review}` }] }));
}

// ---------------- Storage: ship several orders together ----------------
/** Customer taps “Ship now”: all their stored orders are released and marked to share one box. */
function releaseStored(buyer) {
  const held = db.orders.all((o) => o.buyer_id === buyer.id && o.hold && !['cancelled', 'refunded', 'shipped', 'delivered'].includes(o.status));
  if (!held.length) throw httpError(409, 'You have no stored orders');
  const group = `grp_${Date.now().toString(36)}`;
  for (const o of held) db.orders.update(o.id, (x) => ({ ...x, hold: false, ship_group: group, timeline: [...x.timeline, { at: Date.now(), event: 'ship_requested' }] }));
  return { released: held.length, group };
}

/** Stored orders older than the free storage period are released automatically. */
function releaseExpired(days = Number(process.env.STORAGE_DAYS || 30)) {
  let n = 0;
  for (const o of db.orders.all((x) => x.hold && x.paid_at && Date.now() - x.paid_at > days * 86400e3)) {
    db.orders.update(o.id, (x) => ({ ...x, hold: false, ship_group: x.ship_group || `grp_auto_${x.buyer_id}`, timeline: [...x.timeline, { at: Date.now(), event: 'storage_ended' }] })); n++;
  }
  return n;
}

function markDelivered(orderId) {
  const o = db.orders.get(orderId);
  if (!o || o.status !== 'shipped') throw httpError(409, 'Order has not been shipped yet');
  if (o.shipment_id) db.shipments.update(o.shipment_id, { status: 'delivered', delivered_at: Date.now() });
  // Orders that travelled in the same box are delivered together
  const sh = o.shipment_id ? db.shipments.get(o.shipment_id) : null;
  for (const id of (sh?.order_ids || []).filter((id) => id !== o.id)) { const x = db.orders.get(id); if (x && x.status === 'shipped') { db.orders.update(x.id, { shipment_id: null }); markDelivered(x.id); db.orders.update(x.id, { shipment_id: sh.id }); } }
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
    return { id: o.id, status: o.status, status_label: orders.ORDER_STATUS_LABEL[o.status], destination: `${o.shipping_address.city}, ${o.shipping_address.country}`, recipient: o.shipping_address.name, parcels_total: ps.length, parcels_received: ps.filter((p) => p.status === 'received').length, items: o.lines.reduce((a, l) => a + l.qty, 0), weight_g: ps.reduce((a, p) => a + (Number(p.weight_g) || 0), 0) || null, country_code: o.shipping_address.country_code || null,
      hold: Boolean(o.hold), ship_group: o.ship_group || null, packaging: o.packaging || 'standard', qc_photos: (o.qc_photos || []).length, qc_review: o.qc_review || null, qc_note: o.qc_note || null,
      combine_with: db.orders.all((x) => x.id !== o.id && x.buyer_id === o.buyer_id && x.status === 'ready_to_ship' && !x.hold && sameAddress(x.shipping_address, o.shipping_address)).map((x) => x.id) };
  });
  return {
    expected: db.parcels.all((p) => p.status === 'expected').map(parcelView),
    in_stock: db.parcels.all((p) => p.status === 'received' || p.status === 'qc_failed' || p.unmatched).map(parcelView),
    orders: readyOrders,
    shipments: db.shipments.all().slice(-50).reverse().map((x) => ({ ...x, label: x.label ? { type: x.label.type } : null, tracking_url: require('./couriers').trackingUrl(x.carrier, x.tracking) }))
  };
}

module.exports = { receive, assign, ship, settleGroup, markDelivered, inventory, lists, addQcPhotos, qcPhoto, qcDecision, releaseStored, releaseExpired, PARCEL_LABEL };
