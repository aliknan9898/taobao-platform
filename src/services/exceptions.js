// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* One queue of everything that went wrong across the apps: supplier orders, carriers, the warehouse,
   product syncs and money. Items are derived from the live records every time (fixing the cause
   removes the item); staff can only assign an item to someone and leave a note.
   Each item says which provider it concerns, what kind of result it is and whether the existing
   "retry purchase" action may be used on it. */
'use strict';
const db = require('../db');
const { httpError } = require('../auth');

const DAY = 86400e3;
const ref = (o) => String(o.id).slice(-8).toUpperCase();
const OPEN = ['paid', 'procuring', 'attention', 'awaiting_parcels', 'ready_to_ship', 'shipped'];
const SEV = { high: 0, medium: 1, low: 2 };

/** Is the existing procure action allowed and useful for this supplier order? */
function retryOf(o, s) {
  if (!['paid', 'procuring', 'attention'].includes(o.status)) return { eligible: false, why: 'Order is not waiting for a purchase' };
  if (!s.direct && s.status === 'CREATE_FAILED') return { eligible: true, why: 'Creating the purchase order failed' };
  if (s.direct && s.status === 'AE_TO_BUY' && !(s.purchase_ids || []).length) return { eligible: true, why: 'No supplier order was placed yet' };
  return { eligible: false, why: 'A supplier order already exists — fix it with the supplier' };
}

function collect() {
  const out = [];
  const add = (x) => out.push({ severity: 'medium', provider: null, order_ref: null, order_id: null, retry: { eligible: false, why: '' }, ...x });
  const orders = db.orders.all((o) => OPEN.includes(o.status) || o.qc_review === 'problem');
  for (const o of orders) {
    if (o.status === 'attention') add({ key: `order:${o.id}`, area: 'order', result: 'stuck', severity: 'high', title: `Order ${ref(o)} needs attention`, detail: (o.timeline || []).slice(-1)[0]?.event || '', order_ref: ref(o), order_id: o.id, at: o.updated_at || o.created_at });
    if (o.qc_review === 'problem') add({ key: `qc:${o.id}`, area: 'warehouse', result: 'review', severity: 'high', title: `Order ${ref(o)}: customer reported a problem with the QC photos`, detail: String(o.qc_note || '').slice(0, 160), order_ref: ref(o), order_id: o.id, at: o.qc_at || o.updated_at });
    for (const s of o.sub_orders || []) {
      const provider = s.direct ? (s.source || 'aliexpress') : (s.source || 'taobao');
      const k = `${o.id}:${s.outer_purchase_id || s.seller_id}`;
      if (s.error) add({ key: `supplier:${k}`, area: 'supplier', provider, result: 'failed', severity: 'high', title: `Order ${ref(o)}: ${provider} purchase problem`, detail: String(s.error).slice(0, 200), order_ref: ref(o), order_id: o.id, retry: retryOf(o, s), at: s.updated_at || o.updated_at || o.created_at });
      else if (/WAIT_BUYER_P/.test(s.status || '') && s.pay_deadline && Number(s.pay_deadline) - Date.now() < 6 * 3600e3) add({ key: `paydue:${k}`, area: 'supplier', provider, result: 'action', severity: 'high', title: `Order ${ref(o)}: supplier payment deadline is close`, detail: `Purchase ${s.outer_purchase_id || ''}`, order_ref: ref(o), order_id: o.id, at: Number(s.pay_deadline) });
      else if (s.direct && s.status === 'AE_TO_BUY' && o.status !== 'pending_payment') add({ key: `tobuy:${k}`, area: 'supplier', provider, result: 'action', title: `Order ${ref(o)}: ${provider} item still to order`, detail: '', order_ref: ref(o), order_id: o.id, retry: retryOf(o, s), at: o.paid_at || o.created_at });
      const stage = s.track?.status;
      if (stage === 13 || stage === 14) add({ key: `carrier:${k}`, area: 'carrier', provider: 'carrier', result: 'failed', severity: 'high', title: `Order ${ref(o)}: ${stage === 14 ? 'parcel going back to sender' : 'delivery failed'}`, detail: (s.track.events || [])[0]?.text || '', order_ref: ref(o), order_id: o.id, at: s.track.at || o.updated_at });
      else if (s.direct && s.status === 'AE_SHIPPED' && s.track?.at && (s.logistics || []).length && !(s.track.events || []).length && Date.now() - (o.paid_at || o.created_at) > 10 * DAY) add({ key: `notrack:${k}`, area: 'carrier', provider: 'carrier', result: 'stuck', severity: 'low', title: `Order ${ref(o)}: no carrier updates yet`, detail: (s.logistics || []).map((x) => x.tracking).join(', '), order_ref: ref(o), order_id: o.id, at: s.track.at });
    }
  }
  // Warehouse
  for (const p of db.parcels.all((x) => x.unmatched && x.status !== 'packed')) add({ key: `unmatched:${p.id}`, area: 'warehouse', result: 'action', title: `Parcel ${p.tracking} received but not matched to an order`, detail: p.location ? `Location ${p.location}` : '', at: p.received_at });
  for (const p of db.parcels.all((x) => x.status === 'qc_failed')) { const o = p.order_id ? db.orders.get(p.order_id) : null; add({ key: `qcfail:${p.id}`, area: 'warehouse', result: 'failed', severity: 'high', title: `Parcel ${p.tracking} failed quality check`, detail: p.notes || '', order_ref: o ? ref(o) : null, order_id: o?.id || null, at: p.received_at }); }
  for (const carton of db.ly_inbound.peek((x) => x.discrepancy && !x.received_at)) {
    add({ key: `carton:${carton.id}`, area: 'warehouse', result: 'review', severity: 'high',
      title: `Libya carton ${carton.tracking}: quantity discrepancy`,
      detail: `${carton.discrepancy.lines} line(s) differ. Recount the carton before confirming receipt.`, at: carton.discrepancy.at });
  }
  for (const booking of db.shipment_bookings.peek((x) => ['uncertain', 'booked'].includes(x.status) ||
      (x.status === 'pending' && Date.now() - x.created_at > 2 * 60e3))) {
    if (db.shipments.find((s) => s.booking_id === booking.id)) continue;
    const order = db.orders.get(booking.order_id);
    add({ key: `booking:${booking.id}`, booking_id: booking.id, booking_confirmed: booking.status === 'booked', area: 'warehouse', provider: booking.carrier,
      result: 'review', severity: 'high', title: `Order ${ref({ id: booking.order_id })}: carrier booking requires review`,
      detail: booking.status === 'booked'
        ? `Carrier tracking ${booking.carrier_result?.tracking || 'unavailable'}. Resolve the order issue, then finalize the saved label.`
        : 'Check the carrier for an active label. Release the booking only after the carrier confirms no label is active.',
      order_ref: order ? ref(order) : null, order_id: order?.id || null, at: booking.created_at });
  }
  for (const shipment of db.shipments.peek((row) => row.status === 'in_transit' &&
      (row.track?.status === 13 || row.track?.status === 14 || (!row.track?.events?.length && Date.now() - row.shipped_at > 10 * DAY)))) {
    const stage = shipment.track?.status;
    const order = db.orders.get(shipment.order_id);
    const issue = stage === 13 ? 'delivery failed' : stage === 14 ? 'return to sender' : 'no carrier events after 10 days';
    add({ key: `warehouse-tracking:${shipment.id}`, area: 'warehouse', provider: shipment.carrier,
      result: stage === 13 || stage === 14 ? 'failed' : 'stuck',
      severity: stage === 13 || stage === 14 ? 'high' : 'medium',
      title: `Shipment ${shipment.tracking}: ${issue}`, detail: 'Check the current status with the carrier.',
      order_ref: order ? ref(order) : null, order_id: order?.id || null, at: shipment.shipped_at });
  }
  // Product syncs, one row per provider
  const syncFail = {};
  for (const l of db.listings.all((x) => x.sync_error && ['active', 'pending_review', 'unavailable'].includes(x.status))) (syncFail[l.source || 'taobao'] = syncFail[l.source || 'taobao'] || []).push(l);
  for (const [provider, ls] of Object.entries(syncFail)) add({ key: `sync:${provider}`, area: 'catalog', provider, result: 'failed', severity: ls.length > 20 ? 'medium' : 'low', title: `${ls.length} ${provider} product(s): last price/stock update failed`, detail: [...new Set(ls.map((l) => String(l.sync_error).slice(0, 60)))].slice(0, 3).join(' · '), at: Math.max(...ls.map((l) => l.sync_tried_at || l.last_synced_at || 0)) });
  const losing = db.listings.all((l) => l.price_alert?.skus?.length);
  if (losing.length) add({ key: 'margin', area: 'catalog', result: 'review', title: `${losing.length} product(s) cost more than their selling price`, detail: '', at: Math.max(...losing.map((l) => l.price_alert.at || 0)) });
  // Money
  const payReq = db.payouts.all((p) => p.status === 'requested');
  if (payReq.length) add({ key: 'payouts', area: 'finance', result: 'action', title: `${payReq.length} seller withdrawal(s) to pay`, detail: '', at: Math.min(...payReq.map((p) => p.created_at)) });
  const retReq = db.returns.all((r) => r.status === 'requested');
  if (retReq.length) add({ key: 'returns', area: 'finance', result: 'review', title: `${retReq.length} return request(s) to review`, detail: '', at: Math.min(...retReq.map((r) => r.created_at)) });
  return out;
}

const META = () => db.exceptions_meta;

/** Filtered queue, most severe and oldest first, with who it is assigned to. */
function list({ area = '', provider = '', result = '', mine = '' } = {}, user = null) {
  const meta = Object.fromEntries(META().all().map((m) => [m.key, m]));
  const users = {};
  const name = (id) => { if (!id) return null; if (!(id in users)) { const u = db.users.get(id); users[id] = u ? (u.name || u.email) : null; } return users[id]; };
  let items = collect().map((x) => { const m = meta[x.key]; return { ...x, assignee_id: m?.assignee_id || null, assignee: name(m?.assignee_id), note: m?.note || '' }; });
  const all = items;
  if (area) items = items.filter((x) => x.area === area);
  if (provider) items = items.filter((x) => x.provider === provider);
  if (result) items = items.filter((x) => x.result === result);
  if (mine && user) items = items.filter((x) => x.assignee_id === user.id);
  items.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (a.at || 0) - (b.at || 0));
  const facet = (k) => Object.entries(all.reduce((m, x) => { if (x[k]) m[x[k]] = (m[x[k]] || 0) + 1; return m; }, {})).map(([v, n]) => ({ value: v, count: n }));
  return { total: all.length, items, facets: { area: facet('area'), provider: facet('provider'), result: facet('result') }, staff: db.users.all((u) => ['admin', 'procurement', 'finance', 'support', 'warehouse'].includes(u.role)).map((u) => ({ id: u.id, name: u.name || u.email, role: u.role })) };
}

/** Assign an item to a staff member and/or leave a note. The key must belong to a current item. */
function assign(key, { assignee_id, note } = {}, by) {
  const k = String(key || '');
  if (!collect().some((x) => x.key === k)) throw httpError(404, 'This exception is no longer open');
  if (assignee_id) { const u = db.users.get(String(assignee_id)); if (!u || !['admin', 'procurement', 'finance', 'support', 'warehouse'].includes(u.role)) throw httpError(400, 'Choose a staff member'); }
  const cur = META().find((m) => m.key === k);
  const patch = { key: k, assignee_id: assignee_id === undefined ? cur?.assignee_id || null : (assignee_id || null), note: note === undefined ? cur?.note || '' : String(note).slice(0, 300), by: by?.id || null, at: Date.now() };
  return cur ? META().update(cur.id, patch) : META().insert(patch);
}

module.exports = { list, assign, collect, retryOf };
