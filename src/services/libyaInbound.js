'use strict';

const db = require('../db');
const libya = require('./libya');
const { httpError } = require('../auth');

const normalize = (value) => typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '';
const reference = (parcel) => 'KN-LY-' + parcel.id.toUpperCase();

function lookup(value) {
  const code = normalize(value);
  if (!code || code.length > 100) throw httpError(400, 'Invalid tracking number');
  const matches = db.ly_inbound.peek((p) => p.tracking === code || reference(p) === code || p.source_tracking.includes(code));
  if (matches.length > 1) throw httpError(409, 'Code matches several cartons. Scan the international carton label.');
  return matches[0] || null;
}

function register(user, body) {
  libya.need(user, 'stock');
  libya.need(user, 'orders');
  const tracking = normalize(body.tracking);
  if (!/^[A-Z0-9-]{1,80}$/.test(tracking) || tracking.startsWith('KN-LY-')) throw httpError(400, 'Invalid international tracking number');
  if (lookup(tracking)) throw httpError(409, 'Tracking number is already registered');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 200) throw httpError(400, 'Provide 1–200 carton items');
  const sourceTracking = Array.isArray(body.source_tracking) ? [...new Set(body.source_tracking.map(normalize))] : [];
  if (sourceTracking.length > 200 || sourceTracking.some((t) => !/^[A-Z0-9-]{1,80}$/.test(t) || t.startsWith('KN-LY-') || t === tracking)) throw httpError(400, 'Invalid source tracking numbers');
  if (db.ly_inbound.peek((p) => sourceTracking.includes(p.tracking)).length) throw httpError(409, 'A source code is already an international carton number');
  const allocated = new Map();
  for (const parcel of db.ly_inbound.peek()) {
    for (const item of parcel.items) {
      const key = item.order_id + ':' + item.line_index;
      allocated.set(key, (allocated.get(key) || 0) + item.qty);
    }
  }
  const items = body.items.map(({ order_id, line_index, qty }) => {
    const order = db.ly_orders.get(order_id);
    const line = Number.isInteger(line_index) && order?.lines[line_index];
    if (line?.route !== 'china' || !Number.isSafeInteger(qty) || qty < 1) throw httpError(400, 'Invalid China order line or quantity');
    const key = order_id + ':' + line_index;
    const total = (allocated.get(key) || 0) + qty;
    if (total > line.qty) throw httpError(409, 'Carton quantities exceed the order quantity');
    allocated.set(key, total);
    return { order_id, line_index, qty, title: line.title, props: line.props, variant_id: line.variant_id };
  });
  return view(db.ly_inbound.insert({ tracking, source_tracking: sourceTracking, items, created_by: user.id }));
}

function view(parcel) {
  return { ...parcel, status: parcel.received_at ? 'received' : 'expected', label: parcel.received_at ? reference(parcel) : null };
}

function scan(user, code) {
  libya.need(user, 'stock');
  const parcel = lookup(code);
  return parcel ? view(parcel) : { status: 'unmatched', tracking: normalize(code) };
}

function receive(user, code, quantities) {
  libya.need(user, 'stock');
  const parcel = lookup(code);
  if (!parcel) throw httpError(404, 'Carton is awaiting matching');
  if (parcel.received_at) {
    libya.inboundReceived(parcel);
    return view(parcel);
  }
  if (!Array.isArray(quantities) || quantities.length !== parcel.items.length ||
      parcel.items.some((item, index) => quantities[index] !== item.qty)) {
    if (Array.isArray(quantities) && quantities.length === parcel.items.length &&
        quantities.every((qty) => Number.isSafeInteger(qty) && qty >= 0)) {
      db.ly_inbound.update(parcel.id, { discrepancy: {
        at: parcel.discrepancy?.at || Date.now(), by: user.id,
        lines: parcel.items.filter((item, i) => quantities[i] !== item.qty).length,
      } });
    }
    throw httpError(409, 'Quantity discrepancy: hold the carton for manual review');
  }
  const received = db.ly_inbound.update(parcel.id, { received_at: Date.now(), received_by: user.id, discrepancy: null });
  libya.inboundReceived(received);
  return view(received);
}

module.exports = { register, scan, receive };
