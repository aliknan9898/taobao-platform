// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Public order tracking: anyone with the order reference AND the email on the order can follow it
   without signing in. The answer is customer-safe: steps, carrier numbers and the next action,
   never the address, phone, prices, supplier names or internal ids. A wrong reference and a wrong
   email give the same answer, so the form cannot be used to find out which orders exist. */
'use strict';
const db = require('../db');
const { httpError } = require('../auth');

const NOT_FOUND = 'No order matches that reference and email. Check both and try again.';

/** "#kn-1a2b3c4d", "1A2B 3C4D" or the full id → the 8-character reference shown to customers. */
function normRef(v) {
  const s = String(v || '').replace(/[\s#-]/g, '').toUpperCase();
  return s.length >= 8 ? s.slice(-8) : '';
}
const refOf = (o) => String(o.id).slice(-8).toUpperCase();
const normEmail = (v) => String(v || '').trim().toLowerCase();

// What the customer should know or do in each state.
const NEXT = {
  pending_payment: 'Finish paying to start your order — sign in to your account to pay.',
  paid: 'Nothing to do. We are buying your items from the suppliers.',
  procuring: 'Nothing to do. Your items are being bought and sent to our warehouse.',
  awaiting_parcels: 'Nothing to do. We check every item at our warehouse before it ships.',
  ready_to_ship: 'Nothing to do. Your parcel is packed and leaves soon.',
  shipped: 'Your parcel is on its way. Use the carrier number below for the latest steps.',
  delivered: 'Delivered. If something is wrong, sign in to request a return.',
  cancelled: 'This order was cancelled. Any payment is returned to your card or wallet.',
  refunded: 'This order was refunded.',
  attention: 'Our team is sorting out a problem with this order. We will email you; nothing to do now.'
};
const DIRECT_LABEL = { AE_TO_BUY: 'Being ordered', AE_PLACED: 'Being ordered', AE_PAID: 'Ordered — preparing', AE_SHIPPED: 'On its way to you', AE_DELIVERED: 'Delivered', AE_CANCELLED: 'Being reviewed' };

function find(ref, email) {
  const r = normRef(ref); const e = normEmail(email);
  if (!r || !e || !e.includes('@')) return null;
  return db.orders.all((o) => refOf(o) === r).find((o) => {
    const buyer = o.buyer_id ? db.users.get(o.buyer_id) : null;
    return [buyer?.email, o.email, o.shipping_address?.email].some((x) => x && normEmail(x) === e);
  }) || null;
}

function view(o) {
  const couriers = require('./couriers');
  const { ORDER_STATUS_LABEL } = require('./orders');
  const shipment = o.shipment_id ? db.shipments.get(o.shipment_id) : null;
  const parcels = [];
  if (shipment && shipment.tracking) parcels.push({ kind: 'consolidated', label: 'From our warehouse', carrier: shipment.carrier || null, number: shipment.tracking, url: shipment.url || couriers.trackingUrl(shipment.carrier, shipment.tracking), track: shipment.track ? { stage: shipment.track.status, events: (shipment.track.events || []).slice(0, 25).map(({ text, at }) => ({ text, at })) } : null, items: o.lines.filter((l) => !l.direct).reduce((a, l) => a + l.qty, 0) });
  for (const s of o.sub_orders || []) {
    if (!s.direct) continue;
    parcels.push({
      kind: 'direct', label: DIRECT_LABEL[s.status] || 'Being ordered',
      carrier: s.logistics?.[0]?.carrier || null, number: s.logistics?.[0]?.tracking || null,
      url: s.logistics?.[0] ? couriers.trackingUrl(s.logistics[0].carrier, s.logistics[0].tracking) : null,
      track: s.track ? { stage: s.track.status || 0, events: (s.track.events || []).slice(0, 25).map((e) => ({ text: e.text, place: e.place, at: e.at })) } : null,
      items: o.lines.filter((l) => (s.line_nos || []).includes(l.line_no)).reduce((a, l) => a + l.qty, 0)
    });
  }
  return {
    ref: refOf(o), status: o.status, status_label: ORDER_STATUS_LABEL[o.status] || o.status,
    next: NEXT[o.status] || NEXT.attention, placed_at: o.created_at,
    items: o.lines.reduce((a, l) => a + l.qty, 0),
    lines: o.lines.map((l) => ({ title: l.title, qty: l.qty })),
    parcels,
    timeline: (o.timeline || []).filter((t) => t && t.event).slice(-12).map((t) => ({ at: t.at, event: t.event })),
    updated_at: o.updated_at || o.created_at
  };
}

/** Look up and refresh carrier steps (bounded wait); throws a single generic 404 on any mismatch. */
async function lookup({ ref, email } = {}) {
  const o = find(ref, email);
  if (!o) throw httpError(404, NOT_FOUND);
  const fresh = await require('./tracking').freshen(o.id);
  return view(fresh || o);
}

module.exports = { lookup, normRef, find, view, NOT_FOUND };
