// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Partner fulfilment (Batch 3): handoff, shipments, cancellations and returns. PostgreSQL only (migration 002).
 *
 * Fulfilment states (partner_order.fulfillment_state):
 *   received → confirmed (paid or on terms; Batch 2 worker) → processing (handed to the supplier or warehouse)
 *   → partially_shipped / shipped (one shipment per ship-from origin) → delivered.  cancelled and exception are side exits.
 * Handoff: the worker claims pending intents, calls the adapter OUTSIDE any SQL transaction with a deterministic
 *   handoff reference (so a retried submission is recognised by the receiver), then records the result. In the
 *   sandbox the adapter is simulated. There is no live adapter yet: live intents stay pending for a manual handoff.
 * Cancellations: accepted at once before handoff (reservations released, any settled payment credited); after handoff
 *   KINAN must decide; after shipping the answer is 409 and the partner uses a return instead.
 * Returns (RMA): only for delivered parcels, within PARTNER_RETURN_WINDOW_DAYS (30) of delivery, up to the delivered
 *   quantity minus earlier returns. KINAN approves (with return instructions) or rejects, then marks received and credits.
 * Every change writes history and an outbox event (order.updated, shipment.updated, cancellation.updated, return.updated). */
'use strict';
const crypto = require('crypto');
const pg = require('./pg');
const orders = require('./orders');
const { PartnerError } = require('./catalog');
const { rid, J, emit, outbox, history, idempotent, bad } = orders.internal;

const RETURN_WINDOW_DAYS = () => Math.min(365, Math.max(1, Number(process.env.PARTNER_RETURN_WINDOW_DAYS) || 30));
const CANCEL_REASONS = ['customer_request', 'duplicate_order', 'address_issue', 'payment_issue', 'other'];
const RETURN_REASONS = ['damaged', 'defective', 'wrong_item', 'not_as_described', 'no_longer_needed', 'other'];
const PRE_HANDOFF = ['received', 'on_hold', 'confirmed'];
const notFound = () => new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Order not found');
const iso = (d) => (d ? new Date(d).toISOString() : null);
const note = (v, field) => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || v.length > 500) throw bad(field, 'invalid', 'Up to 500 characters'); return v.trim(); };

// ---------- adapters ----------
/** Sandbox handoff: remembers submissions so tests can prove each order reached the "supplier" once. */
const sandboxAdapter = {
  name: 'sandbox', submitted: new Map(), cancelled: new Set(),
  async submit({ handoff_ref: ref, order_id: orderId }) { const n = (this.submitted.get(ref)?.n || 0) + 1; this.submitted.set(ref, { order_id: orderId, n }); return { accepted: true, duplicate: n > 1 }; },
  async cancel(ref) { this.cancelled.add(ref); return { cancelled: true }; }
};
let adapters = { sandbox: sandboxAdapter, live: null };
/** Tests may swap an adapter (for example one that fails). */
function setAdapter(env, a) { adapters[env] = a; }
const handoffRef = (orderId) => `kh_${crypto.createHash('sha256').update(`partner-handoff:${orderId}`).digest('hex').slice(0, 24)}`;

/**
 * Hand confirmed orders to the supplier or warehouse. Safe in several processes: claiming uses SKIP LOCKED and a
 * 2-minute lease; the adapter is called outside transactions with a deterministic reference.
 */
async function handoffWorker(env, limit = 20) {
  const adapter = adapters[env];
  if (!adapter) return { handed_off: 0, skipped: 'no_adapter' };
  const claimed = await pg.tx(async (c) => (await c.query(`
    UPDATE partner_fulfillment_intent SET attempts = attempts + 1, updated_at = now(), adapter = $2
     WHERE order_id IN (SELECT i.order_id FROM partner_fulfillment_intent i WHERE i.env = $1 AND i.state = 'pending'
                          AND (i.attempts = 0 OR i.updated_at < now() - interval '2 minutes') ORDER BY i.created_at FOR UPDATE SKIP LOCKED LIMIT $3)
     RETURNING order_id`, [env, adapter.name, limit])).rows);
  let n = 0;
  for (const { order_id: orderId } of claimed) {
    const ref = handoffRef(orderId);
    let result; try { result = await adapter.submit({ handoff_ref: ref, order_id: orderId, env }); } catch (e) { result = { error: String(e.message || e).slice(0, 300) }; }
    const lateCancel = await pg.tx(async (c) => {
      const o = (await c.query('SELECT * FROM partner_order WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
      const i = (await c.query('SELECT * FROM partner_fulfillment_intent WHERE order_id = $1 FOR UPDATE', [orderId])).rows[0];
      if (result.error) { await c.query('UPDATE partner_fulfillment_intent SET last_error = $2, handoff_ref = $3, updated_at = now() WHERE order_id = $1', [orderId, result.error, ref]); return false; }
      if (i.state !== 'pending' || o.fulfillment_state !== 'confirmed') { await c.query('UPDATE partner_fulfillment_intent SET handoff_ref = $2, updated_at = now() WHERE order_id = $1', [orderId, ref]); return o.fulfillment_state === 'cancelled'; }
      await c.query(`UPDATE partner_fulfillment_intent SET state = 'submitted', handoff_ref = $2, last_error = NULL, updated_at = now() WHERE order_id = $1`, [orderId, ref]);
      const u = (await c.query(`UPDATE partner_order SET fulfillment_state = 'processing', version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [orderId])).rows[0];
      await history(c, orderId, 'fulfillment', 'confirmed', 'processing', 'handed_off', `adapter:${adapter.name}`);
      await outbox(c, env, u.store_id, 'order.updated', u);
      n += 1; return false;
    });
    // The order was cancelled while the submission was in flight: withdraw it at the receiver (outside the transaction).
    if (lateCancel && adapter.cancel) await adapter.cancel(ref).catch(() => {});
  }
  return { handed_off: n };
}

// ---------- shared ----------
async function lockOrder(c, ctx, orderId) {
  const o = (await c.query('SELECT * FROM partner_order WHERE id = $1 AND env = $2 AND store_id = $3 FOR UPDATE', [orderId, ctx.env, ctx.store.id])).rows[0];
  if (!o) throw notFound(); return o;
}
async function ownOrder(ctx, orderId) {
  const o = (await pg.q('SELECT * FROM partner_order WHERE id = $1 AND env = $2 AND store_id = $3', [orderId, ctx.env, ctx.store.id])).rows[0];
  if (!o) throw notFound(); return o;
}
async function setFulfilment(c, o, to, reason, actor, extra = '') {
  const u = (await c.query(`UPDATE partner_order SET fulfillment_state = $2, version = version + 1, updated_at = now()${extra} WHERE id = $1 RETURNING *`, [o.id, to])).rows[0];
  await history(c, o.id, 'fulfillment', o.fulfillment_state, to, reason, actor);
  await outbox(c, u.env, u.store_id, 'order.updated', u);
  return u;
}
async function setPayment(c, o, to, reason, actor) {
  const u = (await c.query('UPDATE partner_order SET payment_state = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [o.id, to])).rows[0];
  await history(c, o.id, 'payment', o.payment_state, to, reason, actor);
  await outbox(c, u.env, u.store_id, 'order.updated', u);
  return u;
}
/** Release open reservations of an order (cancellation) or commit them (packed and shipped). */
async function reservations(c, o, to, variantIds) {
  const rows = (await c.query(`UPDATE partner_reservation SET state = $2 WHERE order_id = $1 AND state = 'reserved' ${variantIds ? 'AND variant_id = ANY($3)' : ''} RETURNING variant_id, qty`, variantIds ? [o.id, to, variantIds] : [o.id, to])).rows;
  for (const r of rows) {
    if (to === 'released') await c.query('UPDATE partner_stock SET reserved = reserved - $3 WHERE env = $1 AND variant_id = $2', [o.env, r.variant_id, r.qty]);
    else await c.query('UPDATE partner_stock SET reserved = reserved - $3, on_hand = on_hand - $3 WHERE env = $1 AND variant_id = $2', [o.env, r.variant_id, r.qty]);
  }
  return rows.length;
}

// ---------- shipments ----------
function shipmentView(s) {
  return {
    shipment_id: s.id, order_id: s.order_id, version: s.version, state: s.state, ship_from: s.ship_from,
    carrier: s.carrier, service: s.service || null, tracking_number: s.tracking_number, tracking_url: s.tracking_url || null,
    items: s.items, events: (s.events || []).map((e) => ({ at: e.at, state: e.state, ...(e.description ? { description: e.description } : {}) })),
    shipped_at: iso(s.shipped_at), delivered_at: iso(s.delivered_at), created_at: iso(s.created_at), updated_at: iso(s.updated_at)
  };
}
async function listShipments(ctx, orderId) {
  await ownOrder(ctx, orderId);
  const rows = (await pg.q('SELECT * FROM partner_shipment WHERE order_id = $1 ORDER BY created_at, id', [orderId])).rows;
  return { data: rows.map(shipmentView) };
}
/** The order's lines grouped by ship-from origin (from the accepted quote). */
async function parcels(c, o) {
  const q = (await c.query('SELECT lines FROM partner_quote WHERE id = $1', [o.quote_id])).rows[0];
  const by = {};
  for (const l of q.lines) (by[l.ships_from || 'DE'] ||= []).push({ variant_id: l.variant_id, product_id: l.product_id, quantity: l.quantity, controlled: !!l.controlled });
  return by;
}
const CARRIER = { DE: { carrier: 'DHL (sandbox)', service: 'Paket' }, CN: { carrier: 'Cainiao (sandbox)', service: 'Standard import, duties paid' } };
async function emitShipment(c, s) { await emit(c, s.env, s.store_id, 'shipment.updated', s.id, s.version, shipmentView(s)); }

/** Ship one origin (or every unshipped origin): creates the shipment, commits controlled reservations. */
async function ship(c, o, shipFrom, actor) {
  if (!['processing', 'partially_shipped'].includes(o.fulfillment_state)) throw new PartnerError(409, 'INVALID_STATE', `Order is ${o.fulfillment_state}`, 'Only orders handed to fulfilment (processing) can ship.');
  const open = (await c.query(`SELECT 1 FROM partner_cancellation WHERE order_id = $1 AND state = 'requested'`, [o.id])).rowCount;
  if (open) throw new PartnerError(409, 'INVALID_STATE', 'A cancellation request is pending', 'Decide the cancellation first.');
  const groups = await parcels(c, o);
  const done = new Set((await c.query('SELECT ship_from FROM partner_shipment WHERE order_id = $1', [o.id])).rows.map((r) => r.ship_from));
  const todo = Object.keys(groups).filter((f) => !done.has(f) && (!shipFrom || f === shipFrom));
  if (!todo.length) throw new PartnerError(409, 'INVALID_STATE', 'Nothing left to ship for this origin');
  const now = new Date().toISOString(); const made = [];
  for (const from of todo) {
    const lines = groups[from];
    await reservations(c, o, 'committed', lines.filter((l) => l.controlled).map((l) => l.variant_id));
    const k = CARRIER[from] || { carrier: 'Carrier (sandbox)' };
    const s = (await c.query(`INSERT INTO partner_shipment (id, env, store_id, order_id, ship_from, carrier, service, tracking_number, items, state, events, shipped_at)
                              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'in_transit',$10, now()) RETURNING *`,
    [rid('ps'), o.env, o.store_id, o.id, from, k.carrier, k.service || null, `SBX${crypto.randomInt(1e9, 9.99e9)}${from}`, J(lines.map(({ variant_id: v, quantity }) => ({ variant_id: v, quantity }))),
      J([{ at: now, state: 'label_created' }, { at: now, state: 'in_transit', description: `Left the ${from} origin` }])])).rows[0];
    await emitShipment(c, s); made.push(s);
  }
  const all = Object.keys(groups).every((f) => done.has(f) || todo.includes(f));
  await setFulfilment(c, o, all ? 'shipped' : 'partially_shipped', 'shipment_created', actor);
  return made;
}

async function deliver(c, o, shipFrom, actor, state = 'delivered') {
  const rows = (await c.query(`SELECT * FROM partner_shipment WHERE order_id = $1 AND state IN ('label_created','in_transit','out_for_delivery','exception') ${shipFrom ? 'AND ship_from = $2' : ''} FOR UPDATE`, shipFrom ? [o.id, shipFrom] : [o.id])).rows;
  if (!rows.length) throw new PartnerError(409, 'INVALID_STATE', 'No shipment in transit');
  const now = new Date().toISOString();
  for (const s of rows) {
    const ev = [...s.events, { at: now, state, ...(state === 'exception' ? { description: 'Carrier reported a delivery problem (sandbox)' } : {}) }];
    const u = (await c.query(`UPDATE partner_shipment SET state = $2, events = $3, version = version + 1, updated_at = now(), delivered_at = ${state === 'delivered' ? 'now()' : 'delivered_at'} WHERE id = $1 RETURNING *`, [s.id, state, J(ev)])).rows[0];
    await emitShipment(c, u);
  }
  if (state === 'exception') return setFulfilment(c, o, 'exception', 'shipment_exception', actor);
  const left = (await c.query(`SELECT count(*)::int AS n FROM partner_shipment WHERE order_id = $1 AND state <> 'delivered'`, [o.id])).rows[0].n;
  const groups = Object.keys(await parcels(c, o)).length;
  const shipped = (await c.query('SELECT count(*)::int AS n FROM partner_shipment WHERE order_id = $1', [o.id])).rows[0].n;
  if (!left && shipped === groups) return setFulfilment(c, o, 'delivered', 'all_parcels_delivered', actor, ', delivered_at = now()');
  if (o.fulfillment_state === 'exception') return setFulfilment(c, o, shipped === groups ? 'shipped' : 'partially_shipped', 'exception_resolved', actor);
  return o;
}

// ---------- cancellations ----------
function cancellationView(x) {
  return { cancellation_id: x.id, order_id: x.order_id, version: x.version, state: x.state, reason_code: x.reason_code, note: x.note || null, decision_reason: x.decision_reason || null, decided_at: iso(x.decided_at), created_at: iso(x.created_at), updated_at: iso(x.updated_at) };
}
async function emitCancellation(c, x) { await emit(c, x.env, x.store_id, 'cancellation.updated', x.id, x.version, cancellationView(x)); }

/** Apply an accepted cancellation inside the caller's transaction (order already locked). */
async function applyCancel(c, o, actor) {
  await reservations(c, o, 'released');
  await c.query(`UPDATE partner_fulfillment_intent SET state = 'failed', last_error = 'cancelled', updated_at = now() WHERE order_id = $1 AND state IN ('pending','submitted')`, [o.id]);
  let u = await setFulfilment(c, o, 'cancelled', 'cancellation_accepted', actor);
  if (['settled', 'approved_terms'].includes(u.payment_state)) u = await setPayment(c, u, 'credited', 'cancellation_credit', actor);
  return u;
}

async function requestCancellation(ctx, orderId, body = {}, idemKey) {
  const reason = body.reason_code;
  if (!CANCEL_REASONS.includes(reason)) throw bad('reason_code', 'invalid', CANCEL_REASONS.join(', '));
  const n = note(body.note, 'note');
  let withdraw = null;
  try {
    const out = await idempotent(ctx, `cancellations.create:${orderId}`, idemKey, body, async (c) => {
      const o = await lockOrder(c, ctx, orderId);
      if (o.fulfillment_state === 'cancelled') throw new PartnerError(409, 'ORDER_NOT_CANCELLABLE', 'Order already cancelled');
      if (['partially_shipped', 'shipped', 'delivered', 'exception'].includes(o.fulfillment_state)) throw new PartnerError(409, 'ORDER_NOT_CANCELLABLE', 'Order already shipped', 'Parcels are on their way. Request a return after delivery instead.');
      const immediate = PRE_HANDOFF.includes(o.fulfillment_state);
      let x = (await c.query(`INSERT INTO partner_cancellation (id, env, store_id, order_id, state, reason_code, note, decided_at, decision_reason)
                              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [rid('pc'), o.env, o.store_id, o.id, immediate ? 'accepted' : 'requested', reason, n, immediate ? new Date() : null, immediate ? 'before_handoff' : null])).rows[0];
      if (immediate) {
        const i = (await c.query('SELECT handoff_ref FROM partner_fulfillment_intent WHERE order_id = $1', [o.id])).rows[0];
        if (i?.handoff_ref) withdraw = i.handoff_ref; // a submission may have reached the receiver
        await applyCancel(c, o, `store:${ctx.store.id}`);
      }
      await emitCancellation(c, x);
      x = cancellationView(x);
      return { status: 201, body: x, id: x.cancellation_id };
    });
    if (withdraw && adapters[ctx.env]?.cancel) await adapters[ctx.env].cancel(withdraw).catch(() => {});
    return out;
  } catch (e) {
    if (e.code === '23505' && /partner_cancellation_open/.test(`${e.constraint || ''} ${e.message}`)) throw new PartnerError(409, 'CANCELLATION_PENDING', 'A cancellation already exists for this order', 'Read it with GET /orders/{order_id}/cancellations.');
    throw e;
  }
}

async function listCancellations(ctx, orderId) {
  await ownOrder(ctx, orderId);
  return { data: (await pg.q('SELECT * FROM partner_cancellation WHERE order_id = $1 ORDER BY created_at', [orderId])).rows.map(cancellationView) };
}

/** KINAN's decision on a cancellation requested after handoff. */
async function decideCancellation(id, { accept, reason, actor = 'admin' } = {}) {
  let withdraw = null; let envOf = null;
  const x = await pg.tx(async (c) => {
    const cur = (await c.query('SELECT * FROM partner_cancellation WHERE id = $1', [id])).rows[0];
    if (!cur) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Cancellation not found');
    const o = (await c.query('SELECT * FROM partner_order WHERE id = $1 FOR UPDATE', [cur.order_id])).rows[0];
    const k = (await c.query('SELECT * FROM partner_cancellation WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (k.state !== 'requested') throw new PartnerError(409, 'INVALID_STATE', `Cancellation is already ${k.state}`);
    if (accept && ['partially_shipped', 'shipped', 'delivered'].includes(o.fulfillment_state)) throw new PartnerError(409, 'INVALID_STATE', 'The order has shipped; reject the cancellation and use a return.');
    const u = (await c.query(`UPDATE partner_cancellation SET state = $2, decision_reason = $3, decided_at = now(), version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, accept ? 'accepted' : 'rejected', String(reason || (accept ? 'accepted_by_kinan' : 'already_in_fulfilment')).slice(0, 200)])).rows[0];
    if (accept) {
      const i = (await c.query('SELECT handoff_ref FROM partner_fulfillment_intent WHERE order_id = $1', [o.id])).rows[0];
      withdraw = i?.handoff_ref || null; envOf = o.env;
      await applyCancel(c, o, actor);
    }
    await emitCancellation(c, u);
    return u;
  });
  if (withdraw && adapters[envOf]?.cancel) await adapters[envOf].cancel(withdraw).catch(() => {});
  return cancellationView(x);
}

// ---------- returns ----------
function returnView(r) {
  return {
    return_id: r.id, rma_number: r.rma_number, order_id: r.order_id, version: r.version, state: r.state, reason_code: r.reason_code,
    items: r.items, note: r.note || null, decision_reason: r.decision_reason || null, instructions: r.instructions || null,
    credit_minor: Number(r.credit_minor) || 0, currency: 'EUR', created_at: iso(r.created_at), updated_at: iso(r.updated_at)
  };
}
async function emitReturn(c, r) { await emit(c, r.env, r.store_id, 'return.updated', r.id, r.version, returnView(r)); }

async function requestReturn(ctx, orderId, body = {}, idemKey) {
  const reason = body.reason_code;
  if (!RETURN_REASONS.includes(reason)) throw bad('reason_code', 'invalid', RETURN_REASONS.join(', '));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 50) throw bad('items', 'invalid', '1 to 50 lines');
  const want = new Map();
  items.forEach((it, i) => {
    const q = Number(it?.quantity);
    if (typeof it?.variant_id !== 'string' || !/^kv_[A-Za-z0-9_]{1,80}$/.test(it.variant_id)) throw bad(`items[${i}].variant_id`, 'invalid');
    if (!Number.isInteger(q) || q < 1 || q > 999) throw bad(`items[${i}].quantity`, 'invalid');
    want.set(it.variant_id, (want.get(it.variant_id) || 0) + q);
  });
  const n = note(body.note, 'note');
  return idempotent(ctx, `returns.create:${orderId}`, idemKey, body, async (c) => {
    const o = await lockOrder(c, ctx, orderId);
    const windowMs = RETURN_WINDOW_DAYS() * 864e5;
    const delivered = (await c.query(`SELECT items, delivered_at FROM partner_shipment WHERE order_id = $1 AND state = 'delivered'`, [o.id])).rows;
    if (!delivered.length) throw new PartnerError(409, 'RETURN_NOT_ALLOWED', 'Nothing delivered yet', 'Returns open once a parcel is delivered. Before shipping, cancel the order instead.');
    const avail = new Map();
    for (const s of delivered) {
      if (Date.now() - new Date(s.delivered_at).getTime() > windowMs) continue;
      for (const l of s.items) avail.set(l.variant_id, (avail.get(l.variant_id) || 0) + l.quantity);
    }
    for (const r of (await c.query(`SELECT items FROM partner_return WHERE order_id = $1 AND state <> 'rejected'`, [o.id])).rows) for (const l of r.items) avail.set(l.variant_id, (avail.get(l.variant_id) || 0) - l.quantity);
    const errors = [];
    for (const [v, q] of want) { const a = avail.get(v) || 0; if (q > a) errors.push({ field: v, code: a > 0 ? 'quantity_exceeds_returnable' : 'not_returnable', detail: `Returnable now: ${Math.max(0, a)}` }); }
    if (errors.length) throw new PartnerError(409, 'RETURN_NOT_ALLOWED', 'Return not possible for these lines', `Delivered items can be returned within ${RETURN_WINDOW_DAYS()} days of delivery, up to the quantity not yet returned.`, { errors });
    const unit = new Map(o.commercial.items.map((l) => [l.variant_id, l.unit_ex_tax_minor]));
    const lines = [...want].map(([v, q]) => ({ variant_id: v, quantity: q }));
    let r = (await c.query(`INSERT INTO partner_return (id, env, store_id, order_id, rma_number, state, reason_code, items, note, credit_minor)
                            VALUES ($1,$2,$3,$4,$5,'requested',$6,$7,$8,$9) RETURNING *`,
    [rid('pr'), o.env, o.store_id, o.id, `RMA-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, reason, J(lines), n, lines.reduce((a, l) => a + (unit.get(l.variant_id) || 0) * l.quantity, 0)])).rows[0];
    await history(c, o.id, 'return', null, 'requested', reason, `store:${ctx.store.id}`);
    await emitReturn(c, r);
    r = returnView(r);
    return { status: 201, body: r, id: r.return_id };
  });
}

async function listReturns(ctx, orderId) {
  await ownOrder(ctx, orderId);
  return { data: (await pg.q('SELECT * FROM partner_return WHERE order_id = $1 ORDER BY created_at', [orderId])).rows.map(returnView) };
}

const SANDBOX_RETURN_TO = { name: 'KINAN Returns (sandbox)', line1: 'Sandboxweg 1', city: 'Berlin', postal_code: '10115', country: 'DE' };
const NEXT = { approve: ['requested', 'approved'], reject: ['requested', 'rejected'], receive: ['approved', 'received'], credit: ['received', 'credited'] };
/** KINAN's steps on a return: approve (with instructions) or reject, then receive, then credit. */
async function decideReturn(id, { action, reason, actor = 'admin' } = {}) {
  const step = NEXT[action]; if (!step) throw new PartnerError(400, 'INVALID_INPUT', 'action must be approve, reject, receive or credit');
  const r = await pg.tx(async (c) => {
    const cur = (await c.query('SELECT order_id FROM partner_return WHERE id = $1', [id])).rows[0];
    if (!cur) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Return not found');
    const o = (await c.query('SELECT * FROM partner_order WHERE id = $1 FOR UPDATE', [cur.order_id])).rows[0];
    const x = (await c.query('SELECT * FROM partner_return WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (x.state !== step[0]) throw new PartnerError(409, 'INVALID_STATE', `Return is ${x.state}; ${action} needs ${step[0]}`);
    const instructions = action === 'approve' ? { method: 'merchant_ships', return_to: o.env === 'sandbox' ? SANDBOX_RETURN_TO : null, reference: x.rma_number, note: 'Write the RMA number on the parcel. Keep proof of postage.' } : x.instructions;
    const u = (await c.query(`UPDATE partner_return SET state = $2, instructions = $3, decision_reason = COALESCE($4, decision_reason), version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, step[1], J(instructions), reason ? String(reason).slice(0, 200) : (action === 'reject' ? 'not_eligible' : null)])).rows[0];
    await history(c, o.id, 'return', x.state, step[1], action, actor);
    if (action === 'credit') {
      const ordered = o.commercial.items.reduce((a, l) => a + l.quantity, 0);
      const back = (await c.query(`SELECT items FROM partner_return WHERE order_id = $1 AND state = 'credited'`, [o.id])).rows.reduce((a, rr) => a + rr.items.reduce((b, l) => b + l.quantity, 0), 0);
      const to = back >= ordered ? 'credited' : 'partially_credited';
      if (o.payment_state !== to) await setPayment(c, o, to, 'return_credit', actor);
    }
    await emitReturn(c, u);
    return u;
  });
  return returnView(r);
}

// ---------- sandbox simulator (partners and KINAN admin) ----------
const ACTIONS = ['handoff', 'ship', 'deliver', 'exception', 'accept_cancellation', 'reject_cancellation', 'approve_return', 'reject_return', 'receive_return', 'credit_return'];
/** Move a sandbox order forward so partners can test every state and event. Never available for live orders. */
async function simulate(ctx, orderId, body = {}) {
  if (ctx.env !== 'sandbox') throw new PartnerError(403, 'INSUFFICIENT_SCOPE', 'Sandbox only', 'The simulator works with sandbox keys and sandbox orders only.');
  const action = body.action;
  if (!ACTIONS.includes(action)) throw bad('action', 'invalid', ACTIONS.join(', '));
  const from = body.ship_from === undefined ? null : String(body.ship_from).toUpperCase();
  if (from !== null && !/^[A-Z]{2}$/.test(from)) throw bad('ship_from', 'invalid');
  const actor = ctx.actor || `sandbox:${ctx.store.id}`;
  await ownOrder(ctx, orderId);
  if (action === 'handoff') { await orders.fulfilmentWorker('sandbox'); await handoffWorker('sandbox'); }
  else if (['ship', 'deliver', 'exception'].includes(action)) {
    await pg.tx(async (c) => { const o = await lockOrder(c, ctx, orderId); if (action === 'ship') await ship(c, o, from, actor); else await deliver(c, o, from, actor, action === 'exception' ? 'exception' : 'delivered'); });
  } else if (action.endsWith('_cancellation')) {
    const k = (await pg.q(`SELECT id FROM partner_cancellation WHERE order_id = $1 AND state = 'requested'`, [orderId])).rows[0];
    if (!k) throw new PartnerError(409, 'INVALID_STATE', 'No cancellation request is waiting for a decision');
    await decideCancellation(k.id, { accept: action === 'accept_cancellation', actor });
  } else {
    const step = action.replace('_return', ''); const need = NEXT[step][0];
    const r = (await pg.q('SELECT id FROM partner_return WHERE order_id = $1 AND state = $2 ORDER BY created_at LIMIT 1', [orderId, need])).rows[0];
    if (!r) throw new PartnerError(409, 'INVALID_STATE', `No return is ${need}`);
    await decideReturn(r.id, { action: step, actor });
  }
  return orders.getOrder(ctx, orderId);
}

/** Admin overview: what needs a KINAN decision, plus handoff health. No recipient data. */
async function adminQueues(env = 'sandbox') {
  const cancellations = (await pg.q(`SELECT k.id, k.order_id, k.reason_code, k.created_at, o.store_id, o.external_order_ref, o.fulfillment_state FROM partner_cancellation k JOIN partner_order o ON o.id = k.order_id WHERE k.env = $1 AND k.state = 'requested' ORDER BY k.created_at`, [env])).rows;
  const returns = (await pg.q(`SELECT r.id, r.rma_number, r.order_id, r.state, r.reason_code, r.items, r.credit_minor, r.created_at, o.store_id, o.external_order_ref FROM partner_return r JOIN partner_order o ON o.id = r.order_id WHERE r.env = $1 AND r.state IN ('requested','approved','received') ORDER BY r.created_at`, [env])).rows;
  const handoff = (await pg.q(`SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending, count(*) FILTER (WHERE state = 'pending' AND last_error IS NOT NULL)::int AS failing FROM partner_fulfillment_intent WHERE env = $1`, [env])).rows[0];
  const ms = (x) => ({ ...x, created_at: new Date(x.created_at).getTime(), ...(x.credit_minor !== undefined ? { credit_minor: Number(x.credit_minor) } : {}) });
  return { cancellations: cancellations.map(ms), returns: returns.map(ms), handoff, live_adapter: !!adapters.live };
}

module.exports = {
  handoffWorker, setAdapter, sandboxAdapter, handoffRef,
  listShipments, requestCancellation, listCancellations, decideCancellation, requestReturn, listReturns, decideReturn,
  simulate, adminQueues, ACTIONS, CANCEL_REASONS, RETURN_REASONS,
  _views: { shipmentView, cancellationView, returnView }
};
