// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * NextSmartShip (NSS) as Kinan's China warehouse + international shipping.
 *
 *  1. Paid order with warehouse items (Taobao / manual) → each item is registered at NSS as a product
 *     (SKU, barcode, customs) and an NSS order is created with the customer's address (status "open").
 *     NSS supports order-first: the goods arrive later (Taobao sellers ship them to the NSS China warehouse).
 *  2. When NSS has stock for every item (checked regularly) the order is sent for fulfilment with the
 *     cheapest (or fastest) shipping option → NSS fetches a tracking number and ships.
 *  3. Tracking comes back by webhook (order.shipped, signed) and polling → the Kinan order becomes "shipped"
 *     and the customer gets the tracking link.
 * Orders paid with test payments are never sent automatically (NSS has no sandbox and charges real fees).
 */
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');
const nss = require('../nss/client');

const now = () => Date.now();
const money = (n) => Math.round(Number(n) * 100) / 100;
const PREFS = 'set_nss_prefs'; const HOOK = 'set_nss_webhook';
const CN_WAREHOUSE = Number(process.env.NSS_WAREHOUSE_ID || 1); // 1 = CN Warehouse

function prefs() { return { auto_create: true, auto_ship: true, shipping: 'cheapest', max_days: 20, ...(db.settings.get(PREFS) || {}) }; }
function savePrefs(b = {}) {
  const p = prefs();
  const doc = {
    auto_create: b.auto_create === undefined ? p.auto_create : Boolean(b.auto_create),
    auto_ship: b.auto_ship === undefined ? p.auto_ship : Boolean(b.auto_ship),
    shipping: ['cheapest', 'fastest', 'balanced'].includes(b.shipping) ? b.shipping : p.shipping,
    max_days: b.max_days === undefined ? p.max_days : Math.min(60, Math.max(3, Number(b.max_days) || 20))
  };
  return db.settings.get(PREFS) ? db.settings.update(PREFS, doc) : db.settings.insert({ id: PREFS, ...doc });
}
const enabled = () => nss.enabled();

// ---------------- products ----------------
/** Customs: a generic HS code and Chinese name per Kinan category (customs officers use generic descriptions). */
const CUSTOMS = {
  women: ['6204.49', '女装', 'polyester'], men: ['6203.43', '男装', 'polyester'], kids: ['6111.20', '童装', 'cotton'], shoes_bags: ['4202.92', '箱包鞋', 'synthetic'],
  beauty: ['3304.99', '化妆品', 'mixed'], home: ['3924.90', '家居用品', 'plastic'], electronics: ['8543.70', '电子产品', 'plastic'], phone: ['8517.79', '手机配件', 'plastic'],
  sports: ['9506.99', '运动用品', 'mixed'], toys: ['9503.00', '玩具', 'plastic'], car: ['8708.99', '汽车配件', 'metal'], other: ['3926.90', '日用品', 'mixed']
};
const customsFor = (l) => CUSTOMS[l?.category] || CUSTOMS.other;
const hash = (s, n = 10) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n).toUpperCase();
/** One NSS SKU per Kinan product option. */
const skuOf = (line) => `KN-${String(line.listing_id).replace(/[^A-Za-z0-9]/g, '').slice(-12)}-${hash(line.mp_sku_id, 8)}`;
const hasZh = (s) => /[一-鿿]/.test(String(s || ''));

async function ensureProduct(line) {
  const sku = skuOf(line);
  const key = `nss_p_${hash(sku, 16)}`;
  const known = db.settings.get(key);
  if (known && known.product_id) return { sku, product_id: known.product_id };
  const l = db.listings.get(line.listing_id) || {};
  const [hs, zh, material] = customsFor(l);
  const unit = Math.max(1, money(line.price));
  const body = {
    sku, name: String(`${line.title}${line.props ? ` (${line.props})` : ''}`).slice(0, 200), barcode: `KN${hash(sku, 12)}`,
    attribute: /battery|power bank|电池|充电宝/i.test(line.title) ? 'BATTERY_INCLUDED' : /magnet|磁/i.test(line.title) ? 'MAGNETIC' : 'GENERAL_CARGO',
    packaging: 'bare-packaged',
    customs: { name_en: String(line.title).replace(/[一-鿿]/g, '').trim().slice(0, 100) || zh, name_zh: hasZh(line.title) ? String(line.title).slice(0, 60) : zh, hs_code: hs, material, purpose: 'personal use',
      declared_values: [{ country: 'US', amount: unit, currency: 'USD' }, { country: 'OTHER', amount: unit, currency: 'USD' }] },
    ...(line.image && /^https:\/\//.test(line.image) ? { images: [line.image] } : {}),
    ...(l.weight_kg ? { estimated: { weight: Math.round(l.weight_kg * 1000), length: 200, width: 150, height: 80 } } : {}),
    sales_url: `${config.publicBaseUrl}/p/${line.listing_id}`
  };
  let productId;
  try { productId = (await nss.call('POST', '/products', { body })).data?.product_id; }
  catch (e) {
    // Already registered (e.g. database restored): look it up by SKU
    const list = await nss.call('GET', '/products', { query: { sku, page_size: 10 } }).catch(() => null);
    productId = (list?.data || []).find((p) => p.sku === sku)?.product_id;
    if (!productId) throw e;
  }
  db.settings.get(key) ? db.settings.update(key, { sku, product_id: productId }) : db.settings.insert({ id: key, sku, product_id: productId });
  return { sku, product_id: productId };
}

// ---------------- orders ----------------
const isTest = (o) => require('../payments/stripe').isTestPayment(o);
const warehouseLines = (o) => (o.lines || []).filter((l) => !l.direct);

function recipientOf(o) {
  const a = o.shipping_address || {};
  const parts = String(a.name || '').trim().split(/\s+/);
  const first = parts.shift() || 'Customer'; const last = parts.join(' ') || first;
  return {
    first_name: first.slice(0, 50), last_name: last.slice(0, 50), phone: String(a.phone || '').slice(0, 30), country_code: String(a.country_code || '').toUpperCase(),
    city: String(a.city || '').slice(0, 80), address1: String(a.line1 || '').slice(0, 200), ...(a.line2 ? { address2: String(a.line2).slice(0, 200) } : {}),
    zip: String(a.postal_code || '').trim().slice(0, 20) || '00000', ...(a.state ? { state_code: String(a.state).slice(0, 10) } : {}),
    ...(db.users.get(o.buyer_id)?.email ? { email: db.users.get(o.buyer_id).email } : {})
  };
}

const save = (orderId, patch) => db.orders.update(orderId, (x) => ({ ...x, nss: { ...(x.nss || {}), ...patch, updated_at: now() } }));
const log = (orderId, event, extra = {}) => db.orders.update(orderId, (x) => ({ ...x, timeline: [...(x.timeline || []), { at: now(), event, ...extra }] }));

/** Create the NSS order for the warehouse items of a paid Kinan order (once). */
async function createOrder(orderId, { force = false } = {}) {
  const o = db.orders.get(orderId);
  if (!o) throw httpError(404, 'Order not found');
  if (o.nss?.order_number) return o;
  if (!enabled()) throw httpError(503, 'NextSmartShip is not connected');
  if (!force && isTest(o)) throw httpError(409, 'This order was paid with a test payment — create it at NextSmartShip by hand if you really want to ship it');
  const lines = warehouseLines(o);
  if (!lines.length) throw httpError(409, 'This order has no items for the China warehouse');
  const items = new Map();
  for (const l of lines) { const p = await ensureProduct(l); items.set(p.sku, { sku: p.sku, product_id: p.product_id, qty: (items.get(p.sku)?.qty || 0) + l.qty }); }
  const body = { reference_number: o.id, warehouse_id: CN_WAREHOUSE, recipient: recipientOf(o), items: [...items.values()].map(({ sku, qty }) => ({ sku, qty })), note: `Kinan ${o.id.slice(-8).toUpperCase()}`, tags: ['kinan'] };
  try {
    const r = await nss.call('POST', '/orders', { body });
    save(o.id, { order_number: r.data?.order_number, status: 'open', items: [...items.values()], created_at: now(), error: null });
    log(o.id, 'nss_order_created', { nss: r.data?.order_number });
  } catch (e) { save(o.id, { error: e.message }); throw e; }
  return db.orders.get(o.id);
}

/** Shipping options for an NSS order, best first according to the admin's preference. */
async function options(orderId) {
  const o = db.orders.get(orderId);
  if (!o?.nss?.order_number) throw httpError(409, 'Create the order at NextSmartShip first');
  const r = await nss.call('GET', `/orders/${encodeURIComponent(o.nss.order_number)}/shipping-options`);
  const list = (r.data || []).map((x) => ({ route_id: x.route_id, channel_id: x.channel_id, name: x.route_name_en || x.route_name, fee: money(x.estimated_fee?.total), currency: x.estimated_fee?.currency || 'USD', min_days: x.min_transit_days, max_days: x.max_transit_days, weight_g: x.estimated_package?.charge_weight || null }));
  const p = prefs();
  const byFee = [...list].sort((a, b) => a.fee - b.fee);
  if (p.shipping === 'fastest') return [...list].sort((a, b) => (a.max_days ?? 99) - (b.max_days ?? 99) || a.fee - b.fee);
  if (p.shipping === 'balanced') return [...byFee.filter((x) => (x.max_days ?? 99) <= p.max_days), ...byFee.filter((x) => (x.max_days ?? 99) > p.max_days)];
  return byFee;
}

/** Send the order for fulfilment with the chosen (or best) shipping option. */
async function ship(orderId, { route_id, channel_id } = {}, by = 'auto') {
  const o = db.orders.get(orderId);
  if (!o?.nss?.order_number) throw httpError(409, 'Create the order at NextSmartShip first');
  if (!['open', 'on_hold'].includes(o.nss.status)) throw httpError(409, 'Already sent to NextSmartShip');
  if (o.hold) throw httpError(409, 'The customer asked us to store this order until they tap “Ship now”');
  let pick = route_id && channel_id ? { route_id: Number(route_id), channel_id: Number(channel_id) } : (await options(orderId))[0];
  if (!pick) throw httpError(422, 'NextSmartShip has no shipping option for this address and parcel');
  await nss.call('POST', `/orders/${encodeURIComponent(o.nss.order_number)}/fulfillments`, { body: { route_id: pick.route_id, channel_id: pick.channel_id } });
  save(o.id, { status: 'requested', route: pick.name || null, est_fee: pick.fee ?? null, requested_at: now(), error: null });
  log(o.id, 'nss_ship_requested', { by, route: pick.name || null });
  return db.orders.get(o.id);
}

/** Read the NSS order: status, tracking; marks the Kinan order shipped when NSS shipped it. */
async function sync(orderId) {
  const o = db.orders.get(orderId);
  if (!o?.nss?.order_number) return o;
  const d = (await nss.call('GET', `/orders/${encodeURIComponent(o.nss.order_number)}`)).data || {};
  const pk = (d.packages || []).filter((p) => p.nss_tracking_number || p.tracking_number || p.last_mile_tracking_number);
  save(o.id, { status: d.status || o.nss.status, hold_reason: d.hold_reason || '', packages: pk.map((p) => ({ tracking: p.nss_tracking_number || p.tracking_number, url: p.nss_tracking_url || p.last_mile_tracking_url || null, last_mile: p.last_mile_tracking_number || null, courier: p.last_mile_courier || null, status: p.delivery_status || '', ship_date: p.ship_date || null })) });
  if (d.status === 'on_hold' && o.nss.status !== 'on_hold') { try { require('../push').telegram(`⚠️ NextSmartShip order ${o.nss.order_number} (Kinan ${o.id.slice(-8)}) is on hold: ${d.hold_reason || 'shipping problem'}`); } catch { /* optional */ } }
  if (['fulfilled', 'partially_fulfilled'].includes(d.status) && pk.length && !o.shipment_id && !['cancelled', 'refunded', 'delivered'].includes(o.status)) markShipped(o.id);
  if (pk.length && pk.every((p) => p.delivery_status === 'delivered') && o.status === 'shipped') {
    db.orders.update(o.id, (x) => ({ ...x, status: 'delivered', delivered_at: now(), timeline: [...x.timeline, { at: now(), event: 'delivered', by: 'nss' }] }));
    for (const led of db.ledger.all((l) => l.order_id === o.id && l.status === 'pending_payout')) db.ledger.update(led.id, { status: 'payable' });
    require('../notify').orderDelivered(db.orders.get(o.id));
  }
  return db.orders.get(o.id);
}

function markShipped(orderId) {
  const o = db.orders.get(orderId); const p = (o.nss.packages || [])[0];
  const s = db.shipments.insert({ order_id: o.id, order_ids: [o.id], parcel_ids: [], carrier: p.courier || o.nss.route || 'NextSmartShip', tracking: p.tracking, url: p.url || null, last_mile: p.last_mile || null,
    weight_g: null, cost: o.nss.est_fee ?? null, label: null, destination: { country: o.shipping_address?.country, city: o.shipping_address?.city }, shipped_at: now(), shipped_by: 'nss', status: 'in_transit', via: 'nss' });
  db.orders.update(o.id, (x) => ({ ...x, status: 'shipped', shipment_id: s.id, timeline: [...x.timeline, { at: now(), event: 'shipped', tracking: s.tracking, by: 'nss' }] }));
  require('../notify').orderShipped(db.orders.get(o.id), (o.nss.packages || []).map((x) => ({ carrier: x.courier || 'NextSmartShip', number: x.tracking })));
}

async function cancel(orderId) {
  const o = db.orders.get(orderId);
  if (!o?.nss?.order_number || ['cancelled', 'fulfilled'].includes(o.nss.status)) return o;
  await nss.call('POST', `/orders/${encodeURIComponent(o.nss.order_number)}/cancellations`, { body: {} });
  save(o.id, { status: 'cancelled' });
  return db.orders.get(o.id);
}

/** Has NSS received stock for every item of the order? */
async function stockReady(o) {
  for (const it of o.nss.items || []) {
    const r = await nss.call('GET', `/inventory/${it.product_id}`).catch(() => null);
    const rows = Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : [];
    const avail = rows.filter((x) => !x.warehouse_id || x.warehouse_id === CN_WAREHOUSE).reduce((a, x) => a + (Number(x.available_qty) || 0) + (Number(x.committed_qty) || 0), 0);
    if (avail < it.qty) return false;
  }
  return true;
}

/** Paid order hook: create the NSS order automatically (real payments only). */
async function onPaid(orderId) {
  if (!enabled() || !prefs().auto_create) return null;
  const o = db.orders.get(orderId);
  if (!o || isTest(o) || !warehouseLines(o).length) return null;
  try { return await createOrder(orderId); } catch (e) { console.error('[nss] create order', o.id, e.message); return null; }
}

/** Every 30 minutes: ship orders whose goods arrived, and follow orders in progress. */
async function tick() {
  if (!enabled()) return;
  const p = prefs();
  for (const o of db.orders.all((x) => x.nss?.order_number && !['cancelled', 'refunded', 'delivered'].includes(x.status) && !['cancelled'].includes(x.nss.status))) {
    try {
      if (o.nss.status === 'open' && p.auto_ship && !o.hold && o.qc_review !== 'problem' && !isTest(o) && await stockReady(o)) await ship(o.id);
      else if (['requested', 'scheduled', 'fulfilling', 'partially_fulfilled', 'on_hold'].includes(o.nss.status) || (o.nss.status === 'fulfilled' && o.status === 'shipped')) await sync(o.id);
    } catch (e) { save(o.id, { error: e.message }); }
  }
}

// ---------------- webhook ----------------
function verify(raw, sig) {
  if (!sig || !process.env.NSS_CLIENT_SECRET) return false;
  const want = crypto.createHmac('sha256', process.env.NSS_CLIENT_SECRET).update(raw).digest('base64');
  const a = Buffer.from(want); const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function onWebhook(body) {
  const n = body?.data?.order_number || body?.order_number || body?.data?.order?.order_number;
  const o = n && db.orders.find((x) => x.nss?.order_number === n);
  if (!o) return { ignored: true };
  await sync(o.id);
  return { order: o.id };
}
async function registerWebhook() {
  if (!enabled() || !/^https:\/\//.test(config.publicBaseUrl)) return { skipped: true };
  const url = `${config.publicBaseUrl}/webhooks/nss`;
  const s = db.settings.get(HOOK);
  if (s && s.url === url) return s;
  const list = await nss.call('GET', '/webhooks');
  if (!(list.data || []).some((w) => w.endpoint === url && w.topic === 'order.shipped')) await nss.call('POST', '/webhooks', { body: { endpoint: url, topic: 'order.shipped' } });
  const doc = { url, at: now() };
  console.log(`[nss] webhook registered → ${url}`);
  return s ? db.settings.update(HOOK, doc) : db.settings.insert({ id: HOOK, ...doc });
}

async function status() {
  const out = { configured: enabled(), connected: false, balance: null, prefs: prefs(), webhook: db.settings.get(HOOK) || null, customer_code: process.env.NSS_CUSTOMER_CODE || null, error: null };
  if (!out.configured) return out;
  try { out.balance = (await nss.call('GET', '/balance')).data || null; out.connected = true; } catch (e) { out.error = e.message; }
  return out;
}

module.exports = { prefs, savePrefs, status, ensureProduct, createOrder, options, ship, sync, cancel, onPaid, tick, verify, onWebhook, registerWebhook, skuOf, recipientOf, CUSTOMS };
