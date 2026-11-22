// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Partner quotes and orders (Batch 2). PostgreSQL only — see migrations/001_partner_core.sql.
 *
 * POST /quotes   validates destination and basket, prices it from the store's price list, checks the KINAN
 *                contribution target (30% by default) and stores a locked quote with a short expiry. No stock is held.
 * POST /orders   needs an Idempotency-Key. One transaction stores: idempotency record → quote check → order (unique
 *                store + external_order_ref) → stock reservations for stock KINAN controls → outbox event → history →
 *                the response. Same key + same body returns the stored answer; same key + another body is 409.
 * Settlement is simulated in the sandbox (admin). Settled orders get exactly one fulfilment intent from a worker
 * that uses FOR UPDATE SKIP LOCKED, so several processes can run it. Supplier and warehouse calls come in Batch 3
 * and never run inside these transactions. */
'use strict';
const crypto = require('crypto');
const pg = require('./pg');
const pricing = require('./pricing');
const catalog = require('./catalog');
const { PartnerError } = catalog;

const TTL_MIN = () => Math.min(120, Math.max(1, Number(process.env.PARTNER_QUOTE_TTL_MIN) || 15));
const RES_MIN = () => Math.min(7 * 24 * 60, Math.max(5, Number(process.env.PARTNER_RESERVATION_MIN) || 60));
const rid = (p) => `${p}_${crypto.randomBytes(10).toString('base64url').replace(/[-_]/g, 'x')}`;
const bad = (field, code, detail) => new PartnerError(400, 'INVALID_INPUT', 'Invalid request body', undefined, { errors: [{ field, code, ...(detail ? { detail } : {}) }] });

// ---------- destinations (sandbox shipping model; live routes come with real carrier tariffs) ----------
const POSTAL = { DE: /^\d{5}$/, GB: /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/, FR: /^\d{5}$/, IT: /^\d{5}$/, ES: /^\d{5}$/, NL: /^\d{4}[A-Z]{2}$/, BE: /^\d{4}$/, AT: /^\d{4}$/, MT: /^[A-Z]{3}\d{4}$/, PL: /^\d{5}$/, SE: /^\d{5}$/, IE: /^[A-Z\d]{7}$/ };
const normPostal = (v) => String(v || '').toUpperCase().replace(/[\s-]/g, '');
// Synthetic tariffs per origin → destination: KINAN's cost per parcel, plus import handling KINAN pays for parcels from CN.
const TARIFF = {
  DE: { DE: { base: 390, per: 90, days: [2, 4] }, GB: { base: 690, per: 120, days: [4, 7] }, '*': { base: 590, per: 100, days: [3, 6] } },
  CN: { DE: { base: 590, per: 150, days: [7, 12], handling: 120 }, GB: { base: 640, per: 160, days: [8, 13], handling: 150 }, '*': { base: 620, per: 150, days: [8, 14], handling: 120 } }
};
const shipping = (from, country, grams) => { const t = (TARIFF[from] || TARIFF.CN); const s = t[country] || t['*']; return { cost: s.base + s.per * Math.max(1, Math.ceil(grams / 500)), handling: s.handling || 0, days: s.days }; };

/** Stable JSON (sorted keys) for request hashing. */
function canon(v) { if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`; if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`; return JSON.stringify(v); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Recipient data is encrypted at rest (AES-256-GCM). Live needs PARTNER_PII_KEY; the sandbox derives a key.
function piiKey(env) {
  if (process.env.PARTNER_PII_KEY) return crypto.createHash('sha256').update(process.env.PARTNER_PII_KEY).digest();
  if (env === 'live') throw new PartnerError(503, 'TEMPORARILY_UNAVAILABLE', 'Ordering not configured', 'Live ordering needs an encryption key for recipient data.');
  return crypto.createHash('sha256').update(`sandbox-pii:${catalog.secret()}`).digest();
}
function seal(env, obj) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', piiKey(env), iv); const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }; }
function open(env, box) { const d = crypto.createDecipheriv('aes-256-gcm', piiKey(env), Buffer.from(box.iv, 'base64')); d.setAuthTag(Buffer.from(box.tag, 'base64')); return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8')); }

// ---------- quotes ----------
async function createQuote(ctx, body = {}) {
  if (ctx.env === 'live') throw new PartnerError(422, 'UNSUPPORTED_DESTINATION', 'Live quotes are not available yet', 'Live tariffs, taxes and duties need owner approval first.');
  if (body.currency !== 'EUR') throw bad('currency', 'unsupported', 'EUR only');
  const country = String(body.destination?.country || '').toUpperCase();
  const postal = normPostal(body.destination?.postal_code);
  if (!/^[A-Z]{2}$/.test(country)) throw bad('destination.country', 'required');
  if (!(ctx.store.entitlements.markets || []).includes(country)) throw new PartnerError(422, 'UNSUPPORTED_DESTINATION', 'Destination not enabled', `Market ${country} is not enabled for your store.`);
  if (!postal || !(POSTAL[country] || /^[A-Z\d]{3,10}$/).test(postal)) throw bad('destination.postal_code', 'invalid', `Not a valid ${country} postal code`);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 50) throw bad('items', 'invalid', '1 to 50 lines');
  const merged = new Map();
  items.forEach((it, i) => {
    const q = Number(it?.quantity);
    if (typeof it?.variant_id !== 'string' || !/^kv_[A-Za-z0-9_]{1,80}$/.test(it.variant_id)) throw bad(`items[${i}].variant_id`, 'invalid');
    if (!Number.isInteger(q) || q < 1 || q > 999) throw bad(`items[${i}].quantity`, 'invalid', 'Whole number 1–999');
    merged.set(it.variant_id, (merged.get(it.variant_id) || 0) + q);
  });
  catalog.sync(ctx.env);
  const pl = ctx.store.price_list || { version: 1, markup_pct: 0 };
  const lines = []; const errors = []; const grams = {};
  for (const [variantId, qty] of merged) {
    const f = catalog.findVariant(ctx.env, variantId);
    if (!f || !catalog.entitled(ctx.store, f.base, country)) { errors.push({ field: variantId, code: 'not_available' }); continue; }
    const v = f.variant;
    if (v.stock <= 0) { errors.push({ field: variantId, code: 'out_of_stock' }); continue; }
    if (v.quantity_backed && v.stock < qty) { errors.push({ field: variantId, code: 'insufficient_stock', detail: `At most ${v.stock}` }); continue; }
    if (qty < (v.min_order_quantity || 1)) { errors.push({ field: variantId, code: 'below_minimum', detail: `Minimum ${v.min_order_quantity}` }); continue; }
    const unit = pricing.wholesaleUnit(v.cost_minor, pl);
    const from = f.base.ships_from || 'DE';
    grams[from] = (grams[from] || 0) + (v.weight_grams || 500) * qty;
    lines.push({ ships_from: from, variant_id: variantId, product_id: f.base.product_id, quantity: qty, unit_ex_tax_minor: unit, line_ex_tax_minor: unit * qty, cost_minor: v.cost_minor * qty, controlled: !!v.quantity_backed, stock_on_hand: v.stock });
  }
  if (errors.length) throw new PartnerError(422, 'BASKET_NOT_ELIGIBLE', 'Basket not eligible', 'Some lines cannot be supplied to this destination right now.', { errors });
  // One parcel per origin; each origin's shipping and handling is priced to the floor so the basket meets the target
  const parcels = Object.entries(grams).map(([from, g]) => ({ from, ...shipping(from, country, g) }));
  const ship = { cost: parcels.reduce((a, x) => a + x.cost, 0), handling: parcels.reduce((a, x) => a + x.handling, 0), days: [Math.max(...parcels.map((x) => x.days[0])), Math.max(...parcels.map((x) => x.days[1]))] };
  const items_ex_tax = lines.reduce((a, l) => a + l.line_ex_tax_minor, 0);
  const shipping_ex_tax = pricing.floorMinor(ship.cost);
  const handling = ship.handling ? pricing.floorMinor(ship.handling) : 0;
  const totals = { items_ex_tax_minor: items_ex_tax, shipping_ex_tax_minor: shipping_ex_tax, duties_minor: 0, handling_minor: handling, tax_minor: 0, payable_minor: items_ex_tax + shipping_ex_tax + handling };
  const costs = lines.reduce((a, l) => a + l.cost_minor, 0) + ship.cost + ship.handling;
  const k = pricing.contribution(items_ex_tax + shipping_ex_tax + handling, costs);
  const target = pricing.settings().target;
  if (k.margin + 1e-9 < target) throw new PartnerError(422, 'BASKET_NOT_ELIGIBLE', 'Basket not eligible', 'This basket cannot be priced within KINAN’s B2B terms. Contact your account manager.');
  const charges = [
    { type: 'items', payer: 'merchant', included_in_payable: true },
    { type: 'shipping', payer: 'merchant', included_in_payable: true },
    { type: 'duties', payer: 'none_expected', included_in_payable: true, note: 'Sandbox fixture: no duties expected for these routes' },
    ...(handling ? [{ type: 'import_handling', payer: 'merchant', included_in_payable: true, note: 'Parcels shipped from outside the EU' }] : []),
    { type: 'tax', payer: 'merchant', included_in_payable: true, note: 'Sandbox fixture: no tax collected' }
  ];
  const id = rid('pq'); const expires = new Date(Date.now() + TTL_MIN() * 60e3);
  await pg.q(`INSERT INTO partner_quote (id, env, store_id, price_list_version, currency, dest_country, dest_postal, lines, totals, charges, contribution_minor, margin_bp, expires_at)
              VALUES ($1,$2,$3,$4,'EUR',$5,$6,$7,$8,$9,$10,$11,$12)`,
  [id, ctx.env, ctx.store.id, pl.version || 1, country, postal, lines, totals, charges, k.contribution_minor, Math.floor(k.margin * 10000), expires]);
  return quoteView({ id, dest_country: country, dest_postal: postal, lines, totals, charges, price_list_version: pl.version || 1, expires_at: expires, created_at: new Date() }, ship.days, parcels.map((x) => x.from));
}
function quoteView(r, days, origins = ['DE']) {
  return {
    quote_id: r.id, version: 1, currency: 'EUR', expires_at: new Date(r.expires_at).toISOString(), created_at: new Date(r.created_at).toISOString(),
    destination: { country: r.dest_country, postal_code: r.dest_postal },
    items: r.lines.map((l) => ({ variant_id: l.variant_id, product_id: l.product_id, quantity: l.quantity, unit_ex_tax_minor: l.unit_ex_tax_minor, line_ex_tax_minor: l.line_ex_tax_minor })),
    totals: r.totals, tax_treatment: 'sandbox_no_tax', charges: r.charges,
    fulfillment_estimate: { ship_from: origins, parcels: origins.length, delivery_min_business_days: (days || [2, 4])[0], delivery_max_business_days: (days || [2, 4])[1] },
    price_list_version: r.price_list_version,
    charges_policy: 'no_additional_destination_charges_expected_in_sandbox'
  };
}

// ---------- orders ----------
function validateOrder(body) {
  if (typeof body.quote_id !== 'string' || !/^pq_[A-Za-z0-9]{6,64}$/.test(body.quote_id)) throw bad('quote_id', 'invalid');
  if (typeof body.external_order_ref !== 'string' || !/^[A-Za-z0-9._:#/-]{1,64}$/.test(body.external_order_ref)) throw bad('external_order_ref', 'invalid', '1–64 characters: letters, digits and . _ : # / -');
  const a = body.shipping_address || {};
  const str = (k, min, max, req = true) => { const v = a[k]; if (v === undefined || v === null || v === '') { if (req) throw bad(`shipping_address.${k}`, 'required'); return; } if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw bad(`shipping_address.${k}`, 'invalid'); };
  str('recipient', 2, 100); str('line1', 2, 140); str('line2', 0, 140, false); str('city', 1, 80); str('postal_code', 3, 12); str('country', 2, 2); str('phone', 5, 30, false); str('email', 5, 160, false);
  const allowed = ['recipient', 'line1', 'line2', 'city', 'postal_code', 'country', 'phone', 'email', 'region'];
  for (const k of Object.keys(a)) if (!allowed.includes(k)) throw bad(`shipping_address.${k}`, 'unknown_field');
}

function orderView(r, env) {
  const c = r.commercial; const to = r.ship_to ? open(env || r.env, r.ship_to) : {};
  return {
    order_id: r.id, external_order_ref: r.external_order_ref, quote_id: r.quote_id, version: r.version,
    status: { payment: r.payment_state, fulfillment: r.fulfillment_state },
    currency: 'EUR', items: c.items, totals: c.totals,
    ship_to: { recipient: to.recipient, city: to.city, postal_code: to.postal_code, country: to.country },
    created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString(),
    links: { self: `/api/partner/v1/orders/${r.id}` }
  };
}

async function outbox(c, env, storeId, type, orderRow) {
  await c.query(`INSERT INTO partner_outbox (env, store_id, event_id, type, resource_id, resource_version, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [env, storeId, rid('evt'), type, orderRow.id, orderRow.version, { order_id: orderRow.id, external_order_ref: orderRow.external_order_ref, payment: orderRow.payment_state, fulfillment: orderRow.fulfillment_state }]);
}
const history = (c, orderId, field, from, to, reason, actor) => c.query('INSERT INTO partner_order_history (order_id, field, from_state, to_state, reason_code, actor) VALUES ($1,$2,$3,$4,$5,$6)', [orderId, field, from, to, reason, actor]);

/**
 * Create a B2B order exactly once. Returns { status, body, replayed }.
 * `hooks.afterCommit` exists for crash tests only (it runs after COMMIT, before the answer is returned).
 */
async function createOrder(ctx, body = {}, idemKey, hooks = {}) {
  if (typeof idemKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idemKey)) throw new PartnerError(400, 'INVALID_INPUT', 'Idempotency-Key header required', 'Send a unique Idempotency-Key (8–128 characters) for every new order and reuse it for retries.', { errors: [{ field: 'Idempotency-Key', code: 'required' }] });
  validateOrder(body);
  const hash = sha(canon(body));
  const env = ctx.env; const storeId = ctx.store.id;
  // Bring controlled stock levels into SQL before the transaction (never lowers on_hand below what is reserved)
  const qrow = (await pg.q('SELECT lines FROM partner_quote WHERE id = $1 AND env = $2 AND store_id = $3', [body.quote_id, env, storeId])).rows[0];
  if (qrow) for (const l of qrow.lines.filter((x) => x.controlled)) {
    const f = catalog.findVariant(env, l.variant_id); const onHand = f ? f.variant.stock : 0;
    await pg.q(`INSERT INTO partner_stock (env, variant_id, on_hand) VALUES ($1,$2,$3)
                ON CONFLICT (env, variant_id) DO UPDATE SET on_hand = GREATEST(EXCLUDED.on_hand, partner_stock.reserved)`, [env, l.variant_id, onHand]);
  }
  let committedRow = null;
  try {
    const out = await pg.tx(async (c) => {
      const ins = await c.query(`INSERT INTO partner_idempotency (env, store_id, operation, key, request_hash) VALUES ($1,$2,'orders.create',$3,$4)
                                 ON CONFLICT DO NOTHING RETURNING key`, [env, storeId, idemKey, hash]);
      if (!ins.rowCount) {
        const prev = (await c.query(`SELECT request_hash, status, response FROM partner_idempotency WHERE env=$1 AND store_id=$2 AND operation='orders.create' AND key=$3 FOR UPDATE`, [env, storeId, idemKey])).rows[0];
        if (prev.request_hash !== hash) throw new PartnerError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different body', 'Use a new Idempotency-Key for a different order.');
        return { status: prev.status, body: prev.response, replayed: true };
      }
      const q = (await c.query('SELECT * FROM partner_quote WHERE id = $1 AND env = $2 AND store_id = $3 FOR SHARE', [body.quote_id, env, storeId])).rows[0];
      if (!q) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Quote not found', 'No quote with this id exists for your store.');
      if (new Date(q.expires_at).getTime() <= Date.now()) throw new PartnerError(409, 'QUOTE_EXPIRED', 'Quote expired', 'Request a fresh quote and order again.');
      const a = body.shipping_address;
      if (String(a.country).toUpperCase() !== q.dest_country || normPostal(a.postal_code) !== q.dest_postal) throw new PartnerError(409, 'QUOTE_MISMATCH', 'Address does not match the quote', 'The country and postal code must be the ones the quote was priced for. Request a fresh quote.');
      const id = rid('po');
      const commercial = { quote_id: q.id, price_list_version: q.price_list_version, items: q.lines.map((l) => ({ variant_id: l.variant_id, product_id: l.product_id, quantity: l.quantity, unit_ex_tax_minor: l.unit_ex_tax_minor, line_ex_tax_minor: l.line_ex_tax_minor })), totals: q.totals, charges: q.charges, margin_bp: q.margin_bp };
      const shipTo = { ...a, country: q.dest_country, postal_code: a.postal_code.trim() };
      const row = (await c.query(`INSERT INTO partner_order (id, env, store_id, external_order_ref, quote_id, commercial, ship_to) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, env, storeId, body.external_order_ref, q.id, commercial, seal(env, shipTo)])).rows[0];
      for (const l of q.lines.filter((x) => x.controlled)) {
        const up = await c.query('UPDATE partner_stock SET reserved = reserved + $3 WHERE env = $1 AND variant_id = $2 AND on_hand - reserved >= $3', [env, l.variant_id, l.quantity]);
        if (!up.rowCount) throw new PartnerError(409, 'STOCK_CHANGED', 'Stock changed', `There is no longer enough stock of ${l.variant_id}. Request a fresh quote.`);
        await c.query(`INSERT INTO partner_reservation (id, env, order_id, variant_id, qty, state, expires_at) VALUES ($1,$2,$3,$4,$5,'reserved', now() + ($6 || ' minutes')::interval)`, [rid('rsv'), env, id, l.variant_id, l.quantity, String(RES_MIN())]);
      }
      await history(c, id, 'payment', null, 'pending', 'created', `store:${storeId}`);
      await history(c, id, 'fulfillment', null, 'received', 'created', `store:${storeId}`);
      await outbox(c, env, storeId, 'order.updated', row);
      const view = orderView(row, env);
      await c.query(`UPDATE partner_idempotency SET status = 201, response = $4, resource_id = $5 WHERE env=$1 AND store_id=$2 AND operation='orders.create' AND key=$3`, [env, storeId, idemKey, view, id]);
      committedRow = row;
      return { status: 201, body: view, replayed: false };
    });
    if (committedRow && hooks.afterCommit) await hooks.afterCommit(out);
    return out;
  } catch (e) {
    if (e.code === '23505' && /external_order_ref/.test(`${e.constraint || ''} ${e.detail || ''} ${e.message}`)) throw new PartnerError(409, 'ORDER_REFERENCE_CONFLICT', 'Order reference already used', 'An order with this external_order_ref already exists for your store.');
    throw e;
  }
}

async function getOrder(ctx, id) {
  const r = (await pg.q('SELECT * FROM partner_order WHERE id = $1 AND env = $2 AND store_id = $3', [id, ctx.env, ctx.store.id])).rows[0];
  if (!r) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Order not found');
  return orderView(r, ctx.env);
}

async function listOrders(ctx, { limit, cursor, external_order_ref: ref } = {}) {
  const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 50));
  const scope = { s: ctx.store.id, e: ctx.env, t: 'orders' };
  let after = null; if (cursor) { const c = catalog.decodeCursor(cursor, scope); after = c; }
  const params = [ctx.env, ctx.store.id]; let where = 'env = $1 AND store_id = $2';
  if (ref) { params.push(String(ref)); where += ` AND external_order_ref = $${params.length}`; }
  if (after) { params.push(after.c, after.i); where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`; }
  params.push(n + 1);
  const rows = (await pg.q(`SELECT * FROM partner_order WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params)).rows;
  const page = rows.slice(0, n); const last = page[page.length - 1];
  return { data: page.map((r) => orderView(r, ctx.env)), next_cursor: rows.length > n ? catalog.encodeCursor({ ...scope, c: new Date(last.created_at).toISOString(), i: last.id }) : null };
}

// ---------- settlement (sandbox stub) and fulfilment intent ----------
async function settle(orderId, { mode = 'settled', actor = 'admin' } = {}) {
  if (!['settled', 'approved_terms'].includes(mode)) throw new PartnerError(400, 'INVALID_INPUT', 'mode must be settled or approved_terms');
  const row = await pg.tx(async (c) => {
    const o = (await c.query('SELECT * FROM partner_order WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Order not found');
    if (o.env !== 'sandbox') throw new PartnerError(403, 'INSUFFICIENT_SCOPE', 'Live settlement is recorded by finance, not simulated');
    if (o.payment_state !== 'pending') throw new PartnerError(409, 'INVALID_STATE', `Payment is already ${o.payment_state}`);
    const u = (await c.query('UPDATE partner_order SET payment_state = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [orderId, mode])).rows[0];
    await history(c, orderId, 'payment', 'pending', mode, 'sandbox_settlement', actor);
    await outbox(c, u.env, u.store_id, 'order.updated', u);
    return u;
  });
  await fulfilmentWorker(row.env);
  return row;
}

/** Give each settled order exactly one fulfilment intent; safe to run in several processes at once. */
async function fulfilmentWorker(env, limit = 20) {
  return pg.tx(async (c) => {
    const due = (await c.query(`SELECT * FROM partner_order WHERE env = $1 AND payment_state IN ('settled','approved_terms') AND fulfillment_state = 'received'
                                ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2`, [env, limit])).rows;
    for (const o of due) {
      await c.query('INSERT INTO partner_fulfillment_intent (order_id, env) VALUES ($1,$2) ON CONFLICT DO NOTHING', [o.id, env]);
      const u = (await c.query(`UPDATE partner_order SET fulfillment_state = 'confirmed', version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [o.id])).rows[0];
      await history(c, o.id, 'fulfillment', 'received', 'confirmed', 'payment_confirmed', 'worker');
      await outbox(c, env, o.store_id, 'order.updated', u);
    }
    return due.length;
  });
}

/** Release reservations of orders still unpaid after the reservation window and cancel those orders. */
async function sweepExpired(env) {
  return pg.tx(async (c) => {
    const rel = (await c.query(`UPDATE partner_reservation r SET state = 'released' FROM partner_order o
                                WHERE r.order_id = o.id AND r.env = $1 AND r.state = 'reserved' AND r.expires_at < now() AND o.payment_state = 'pending'
                                RETURNING r.order_id, r.variant_id, r.qty`, [env])).rows;
    for (const x of rel) await c.query('UPDATE partner_stock SET reserved = reserved - $3 WHERE env = $1 AND variant_id = $2', [env, x.variant_id, x.qty]);
    const ids = [...new Set(rel.map((x) => x.order_id))];
    for (const id of ids) {
      const u = (await c.query(`UPDATE partner_order SET fulfillment_state = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1 AND fulfillment_state = 'received' RETURNING *`, [id])).rows[0];
      if (u) { await history(c, id, 'fulfillment', 'received', 'cancelled', 'payment_timeout', 'sweeper'); await outbox(c, env, u.store_id, 'order.updated', u); }
    }
    return ids.length;
  });
}

async function purgeIdempotency(days = 30) { return (await pg.q(`DELETE FROM partner_idempotency WHERE created_at < now() - ($1 || ' days')::interval`, [String(days)])).rowCount; }

/** Admin list (no recipient data). */
async function adminList(env = 'sandbox', limit = 50) {
  const rows = (await pg.q(`SELECT id, store_id, external_order_ref, payment_state, fulfillment_state, version, commercial->'totals' AS totals, created_at FROM partner_order WHERE env = $1 ORDER BY created_at DESC LIMIT $2`, [env, limit])).rows;
  const counts = (await pg.q(`SELECT (SELECT count(*) FROM partner_outbox WHERE env = $1 AND dispatched_at IS NULL)::int AS outbox_pending, (SELECT count(*) FROM partner_reservation WHERE env = $1 AND state = 'reserved')::int AS reservations_open`, [env])).rows[0];
  return { orders: rows.map((r) => ({ ...r, created_at: new Date(r.created_at).getTime() })), ...counts };
}

module.exports = { createQuote, createOrder, getOrder, listOrders, settle, fulfilmentWorker, sweepExpired, purgeIdempotency, adminList, _canon: canon, _open: open };
