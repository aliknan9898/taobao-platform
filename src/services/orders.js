// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Buyer orders → per-seller Taobao purchase orders → China warehouse → outbound shipment.
 *
 * Lifecycle (order.status):
 *  pending_payment → paid → procuring → awaiting_parcels → ready_to_ship → shipped → delivered
 *  side exits: cancelled, refunded, attention (needs a human)
 */
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { call } = require('../taobao/client');
const { tokenFor } = require('../taobao/sellerAuth');
const API = require('../taobao/apis');
const stripe = require('../payments/stripe');
const catalog = require('./catalog');
const shop = require('./shop');
const aliexpress = require('./aliexpress');
const notify = require('../notify');
const { httpError } = require('../auth');
const { countryCode, countryName } = require('../countries');

const money = (n) => Math.round(Number(n) * 100) / 100;
const pick = (o, ...k) => { for (const x of k) if (o && o[x] !== undefined && o[x] !== null) return o[x]; return undefined; };
const ids = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
const now = () => Date.now();
const log = (order, event, extra = {}) => [...(order.timeline || []), { at: now(), event, ...extra }];

const TB_STATUS_LABEL = {
  ...aliexpress.LABEL,
  MANUAL_TO_BUY: 'To buy by hand on Taobao', MANUAL_BOUGHT: 'Bought — waiting for Taobao to ship',
  LOCAL_PENDING: 'Submitting', BULIDING: 'Being created', BUILDING: 'Being created',
  WAIT_BUYER_P: 'Awaiting seller payment', WAIT_BUYER_PAY: 'Awaiting seller payment',
  WAIT_SELLER_SEND_GOODS: 'Paid, awaiting Taobao shipment', WAIT_BUYER_CONFIRM_GOODS: 'Shipped to warehouse',
  TRADE_CLOSED: 'Closed', CREATE_FAILED: 'Creation failed'
};
const ORDER_STATUS_LABEL = {
  pending_payment: 'Awaiting payment', paid: 'Paid', procuring: 'Buying from Taobao',
  awaiting_parcels: 'Awaiting parcels at warehouse', ready_to_ship: 'Ready to ship',
  shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded', attention: 'Needs attention'
};

function outerId() {
  return `PO${new Date().toISOString().slice(2, 10).replace(/-/g, '')}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

// ---------------- Checkout ----------------

function validateAddress(a) {
  // Accept a country code (new checkout) or a country name (older apps)
  if (a && a.country_code && !a.country) a = { ...a, country: countryName(String(a.country_code).toUpperCase()) };
  const need = ['name', 'phone', 'country', 'city', 'line1'];
  const miss = need.filter((k) => !a || !String(a[k] || '').trim());
  if (miss.length) throw httpError(400, `Shipping address is missing: ${miss.join(', ')}`);
  const out = Object.fromEntries([...need, 'postal_code', 'line2', 'state'].map((k) => [k, String(a[k] || '').slice(0, 200)]));
  out.country_code = countryCode(a.country_code) || countryCode(a.country);
  if (out.country_code) out.country = countryName(out.country_code);
  return out;
}

async function checkout(buyer, { items, shipping_address }) {
  if (!Array.isArray(items) || !items.length) throw httpError(400, 'Cart is empty');
  if (items.length > 100) throw httpError(400, 'Too many items');
  const address = validateAddress(shipping_address);

  const lines = [];
  for (const it of items) {
    const qty = Math.floor(Number(it.qty));
    if (!(qty >= 1 && qty <= 999)) throw httpError(400, 'Invalid quantity');
    let l = db.listings.get(it.listing_id);
    if (!l || !(l.status === 'active' || (l.status === 'private' && l.private_for === buyer.id))) throw httpError(409, 'An item in the cart is no longer available');
    const seller = db.sellers.get(l.seller_id);
    if (!seller || seller.status !== 'active') throw httpError(409, 'The shop of one of the items is unavailable');
    // Fresh stock/cost before taking money
    if (now() - (l.last_synced_at || 0) > 10 * 60e3) l = await catalog.resync(l.id);
    const sku = l.skus.find((s) => s.mp_sku_id === String(it.mp_sku_id));
    if (!sku) throw httpError(409, 'Variant not found');
    if (sku.stock < qty) throw httpError(409, `Not enough stock: ${l.title} (${sku.props})`);
    if (qty < (l.begin_amount || 1)) throw httpError(400, `Minimum order quantity is ${l.begin_amount}`);
    lines.push({
      line_no: String(lines.length + 1), listing_id: l.id, seller_id: l.seller_id,
      mp_id: l.mp_id, mp_sku_id: sku.mp_sku_id, title: l.title, props: sku.props,
      ...(l.source === 'manual' ? { manual: true, source_link: l.source_link || '' } : {}),
      ...(l.fulfillment === 'direct' ? { direct: true, source: 'aliexpress', source_link: l.source_link || '', ae_product_id: l.ae_product_id || null, ae_sku_attr: sku.ae_sku_attr || '', cost_sale: sku.cost_sale ?? null } : {}),
      image: (l.own_images || []).length ? catalog.photoUrl(l, 0, l.own_images[0]) : (l.images || [])[0] || null,
      ...(l.source === 'manual' || (l.source === 'aliexpress' && !sku.ae_sku_id) ? { own_stock: true } : {}), // typed-in stock, not synced from an API
      qty, price: sku.price, cost_cny: sku.cost_cny
    });
  }
  const subtotal = money(lines.reduce((s, x) => s + x.price * x.qty, 0));
  const ship = require('./shipping').quote(lines.map((l) => ({ listing_id: l.listing_id, qty: l.qty })), address.country_code || address.country);
  const shipping = money(ship.fee);
  const order = db.orders.insert({
    buyer_id: buyer.id, lines, currency: config.currency, subtotal, shipping_fee: shipping,
    total: money(subtotal + shipping), shipping_address: address, shipping_quote: { weight_kg: ship.weight_kg, chargeable_kg: ship.chargeable_kg ?? null, zone: ship.zone, days: ship.days },
    status: 'pending_payment', sub_orders: [], timeline: [{ at: now(), event: 'created' }]
  });
  const payment = await stripe.createPaymentIntent(order);
  return db.orders.update(order.id, { payment });
}

// ---------------- Payment confirmed ----------------

async function markPaid(orderId, { provider, intent_id }) {
  const o = db.orders.get(orderId);
  if (!o) throw httpError(404, 'Order not found');
  if (o.status !== 'pending_payment') return o; // idempotent (webhooks retry)
  if (o.payment?.intent_id && intent_id && o.payment.intent_id !== intent_id) throw httpError(400, 'Payment mismatch');

  // Ledger: per seller gross, platform commission, seller net (paid out via Stripe Connect)
  const bySeller = groupBy(o.lines, 'seller_id');
  for (const [sellerId, lines] of Object.entries(bySeller)) {
    const s = db.sellers.get(sellerId);
    if (s?.system) continue; // Kinan's own shop (buy-for-me): no seller to pay
    const gross = money(lines.reduce((a, l) => a + l.price * l.qty, 0));
    const commission = money(gross * (Number(s?.commission_pct ?? config.defaultCommissionPct) / 100));
    // Items Kinan buys itself (AliExpress, manual Taobao) — their purchase cost is deducted from the seller's earnings.
    // API Taobao items are paid by the seller from their own Distribution account, so nothing is deducted.
    const cost = money(lines.reduce((a, l) => a + (l.direct ? Number(l.cost_sale || 0) : l.manual && l.cost_cny ? l.cost_cny / config.cnyRate : 0) * l.qty, 0));
    db.ledger.insert({ order_id: o.id, seller_id: sellerId, type: 'sale', currency: o.currency, gross, commission, cost, net: money(gross - commission - cost), status: 'pending_payout' });
  }
  db.orders.update(o.id, (x) => ({ ...x, status: 'paid', paid_at: now(), payment: { ...x.payment, provider, status: 'succeeded' }, timeline: log(x, 'paid') }));
  notify.orderPaid(db.orders.get(o.id));
  adjustStock(o, -1);
  await procure(o.id);
  return db.orders.get(o.id);
}

// ---------------- Card payments (Stripe) ----------------

/** Make sure an unpaid order has a live Stripe PaymentIntent for its current total (orders made in test mode, or before cards were switched on, get a new one). */
async function cardPayment(orderId, buyer) {
  const o = db.orders.get(orderId);
  if (!o || o.buyer_id !== buyer.id) throw httpError(404, 'Not found');
  if (o.status !== 'pending_payment') throw httpError(409, 'This order is already paid');
  if (stripe.demoMode()) throw httpError(409, 'Card payments are not switched on yet');
  const p = o.payment || {};
  const want = stripe.toMinor(o.total, o.currency);
  if (p.provider === 'stripe' && p.client_secret && (p.amount === undefined || p.amount === want)) {
    // Reuse it unless Stripe says it can no longer be paid
    const pi = await stripe.retrieveIntent(p.intent_id).catch(() => null);
    if (pi && pi.status === 'succeeded') return { paid: true, order: await stripePaid(pi) };
    if (pi && !['canceled'].includes(pi.status) && pi.amount === want) return { client_secret: p.client_secret };
  }
  const attempt = (p.attempt || 0) + 1;
  const payment = await stripe.createPaymentIntent(o, attempt);
  db.orders.update(o.id, { payment: { ...payment, attempt } });
  return { client_secret: payment.client_secret };
}

/**
 * A Stripe PaymentIntent succeeded (webhook, or the buyer's browser right after paying). Checks the order, amount and currency.
 * If the money cannot be used — order cancelled, already paid another way, or wrong amount — it is refunded automatically.
 */
async function stripePaid(pi) {
  const orderId = pi.metadata && pi.metadata.order_id;
  const o = orderId && db.orders.get(orderId);
  if (!o) { console.warn('[stripe] payment for unknown order', pi.id); return null; }
  const amountOk = pi.amount_received === stripe.toMinor(o.total, o.currency) && String(pi.currency).toLowerCase() === String(o.currency).toLowerCase();
  if (o.status === 'pending_payment' && amountOk) {
    if (o.payment?.intent_id !== pi.id) db.orders.update(o.id, (x) => ({ ...x, payment: { ...x.payment, provider: 'stripe', intent_id: pi.id } }));
    return markPaid(o.id, { provider: 'stripe', intent_id: pi.id });
  }
  if (o.payment?.provider === 'stripe' && o.payment.intent_id === pi.id && o.status !== 'pending_payment' && o.status !== 'cancelled') return o; // already recorded
  // Money we must give back
  const why = !amountOk ? 'amount mismatch' : o.status === 'cancelled' ? 'order was cancelled' : 'order already paid another way';
  try {
    await stripe.refundIntent(pi.id, 'duplicate');
    db.orders.update(o.id, (x) => ({ ...x, timeline: log(x, 'card_payment_refunded', { intent: pi.id, why }) }));
    console.warn(`[stripe] refunded ${pi.id} for order ${o.id}: ${why}`);
  } catch (e) { console.error(`[stripe] could not refund ${pi.id} (${why}):`, e.message); }
  return db.orders.get(o.id);
}

/** Called by the buyer's browser after Stripe confirms: checks with Stripe so the order shows as paid at once. */
async function confirmCard(orderId, buyer) {
  const o = db.orders.get(orderId);
  if (!o || o.buyer_id !== buyer.id) throw httpError(404, 'Not found');
  if (o.status !== 'pending_payment' || o.payment?.provider !== 'stripe') return o;
  const pi = await stripe.retrieveIntent(o.payment.intent_id);
  if (pi && pi.status === 'succeeded') return (await stripePaid(pi)) || db.orders.get(o.id);
  return db.orders.get(o.id);
}

/** Pay an order in full from the buyer's Kinan wallet balance. */
async function payWithWallet(orderId, buyer) {
  const o = db.orders.get(orderId);
  if (!o || o.buyer_id !== buyer.id) throw httpError(404, 'Not found');
  if (o.status !== 'pending_payment') throw httpError(409, 'This order is already paid');
  if (shop.walletOf(buyer.id).balance < o.total) throw httpError(409, 'Your wallet balance is not enough for this order');
  if (o.payment?.provider === 'stripe') await stripe.cancelIntent(o.payment.intent_id);
  shop.walletEntry(buyer.id, -o.total, `Payment for order ${o.id.slice(-8).toUpperCase()}`, { order_id: o.id, kind: 'payment' });
  db.orders.update(o.id, (x) => ({ ...x, payment: { ...x.payment, provider: 'wallet', intent_id: `wallet_${o.id}` } }));
  return markPaid(o.id, { provider: 'wallet', intent_id: `wallet_${o.id}` });
}

/** Products typed in by hand keep their own stock count: take it when paid, give it back on cancel. */
function adjustStock(o, sign) {
  for (const line of o.lines.filter((x) => x.own_stock)) {
    db.listings.update(line.listing_id, (l) => ({ ...l, skus: l.skus.map((s) => (s.mp_sku_id === line.mp_sku_id ? { ...s, stock: Math.max(0, (Number(s.stock) || 0) + sign * line.qty) } : s)) }));
  }
}

// ---------------- Procurement on Taobao (per seller) ----------------

function buildPurchasePayload(subOrder, lines) {
  const w = config.warehouse;
  const payload = {
    outer_purchase_id: subOrder.outer_purchase_id,
    purchase_amount: (lines.reduce((s, l) => s + l.cost_cny * l.qty, 0)).toFixed(2),
    seller_order_number: subOrder.order_id,
    order_source: 'taobao',
    order_line_list: lines.map((l, i) => ({ itemId: String(l.mp_id), skuId: String(l.mp_sku_id), quantity: l.qty, orderLineNo: String(i + 1) })),
    // Privacy: Taobao sellers only see the China warehouse, never the end buyer's address
    receiver: { name: w.name, mobile: w.mobile, state: w.state, city: w.city, district: w.district, detail_address: w.detail_address, zip: w.zip, country: w.country },
    warehouse_address_info: w,
    channel_order_type: config.channelOrderType,
    support_partial_success: false,
    order_remark: `#${subOrder.order_id.slice(-10)}`.slice(0, 35)
  };
  return API.ORDER_CREATE_WRAPPER ? { [API.ORDER_CREATE_WRAPPER]: payload } : payload;
}

async function procure(orderId) {
  const o = db.orders.get(orderId);
  if (!o || !['paid', 'procuring', 'attention'].includes(o.status)) return o;
  const subs = [...(o.sub_orders || [])];

  // AliExpress items ship straight to the customer: one direct sub-order per seller
  for (const [sellerId, lines] of Object.entries(groupBy(o.lines.filter((l) => l.direct), 'seller_id'))) {
    let sub = subs.find((s) => s.direct && s.seller_id === sellerId);
    if (sub && !(sub.status === 'AE_TO_BUY' && !sub.purchase_ids?.length)) continue;
    if (!sub) { sub = aliexpress.newDirectSub(o, sellerId, lines); subs.push(sub); }
    db.orders.update(o.id, { sub_orders: subs });
    await aliexpress.place(db.orders.get(o.id), sub, lines);
    db.orders.update(o.id, { sub_orders: subs });
  }

  const bySeller = groupBy(o.lines.filter((l) => !l.direct), 'seller_id');
  for (const [sellerId, lines] of Object.entries(bySeller)) {
    let sub = subs.find((s) => !s.direct && s.seller_id === sellerId);
    if (sub && sub.status !== 'CREATE_FAILED') continue;
    if (!sub) { sub = { seller_id: sellerId, order_id: o.id, outer_purchase_id: outerId(), line_nos: lines.map((l) => l.line_no), status: 'LOCAL_PENDING', purchase_ids: [] }; subs.push(sub); }
    if (lines.some((l) => l.manual)) {
      // Manually listed products: Kinan's team buys them on Taobao by hand (see markManualBought)
      Object.assign(sub, { manual: true, status: 'MANUAL_TO_BUY', error: null, links: lines.map((l) => ({ title: l.title, props: l.props, qty: l.qty, link: l.source_link || '' })) });
      db.orders.update(o.id, { sub_orders: subs });
      continue;
    }
    // Persist the idempotency key BEFORE calling Taobao
    db.orders.update(o.id, { sub_orders: subs });
    try {
      const token = await tokenFor(sellerId);
      const r = await call(API.ORDER_CREATE, buildPurchasePayload(sub, lines), { accessToken: token });
      const d = r.data || r.result || r;
      sub.purchase_ids = ids(pick(d, 'purchase_order_ids', 'purchase_order_id', 'purchase_id', 'purchaseOrderId'));
      sub.status = 'BULIDING';
      sub.error = null;
    } catch (e) {
      sub.status = 'CREATE_FAILED';
      sub.error = /GOODS_UN_BUILD_RELATION|B-10-00-005/.test(String(e.code) + e.message)
        ? 'Check mp_id/mp_sku_id, channel PANAMA_DG, and that the seller connected their Distribution Platform account'
        : e.message;
    }
    db.orders.update(o.id, { sub_orders: subs });
  }
  const anyFailed = subs.some((s) => s.status === 'CREATE_FAILED' || (s.direct && s.error));
  db.orders.update(o.id, (x) => ({ ...x, status: anyFailed ? 'attention' : 'procuring', timeline: log(x, anyFailed ? 'procure_failed' : 'procure_started') }));

  for (const s of subs) if (s.status !== 'CREATE_FAILED' && !s.manual && !s.direct) { try { await syncSub(o.id, s.outer_purchase_id); } catch { /* later */ } }
  for (const s of subs) {
    const seller = db.sellers.get(s.seller_id);
    if (seller?.auto_pay && s.status !== 'CREATE_FAILED' && !s.manual && !s.direct) { try { await paySub(o.id, s.outer_purchase_id); } catch { /* shown in UI */ } }
  }
  return db.orders.get(o.id);
}

function normalizePO(po) {
  return {
    purchase_id: String(pick(po, 'purchase_id', 'purchase_order_id', 'id') ?? ''),
    status: pick(po, 'status', 'purchase_order_status'),
    total_cny: pick(po, 'purchase_amount', 'total_fee', 'actual_pay_fee'),
    pay_deadline: pick(po, 'pay_timeout_time', 'expected_close_time', 'timeout_time', 'close_time'),
    logistics: (pick(po, 'sub_purchase_orders', 'purchase_order_lines', 'order_lines', 'sku_list') || []).flatMap((l) =>
      (Array.isArray(l.logistic_orders) ? l.logistic_orders : []).map((x) => ({
        carrier: pick(x, 'logistic_company_name', 'company_name'),
        tracking: String(pick(x, 'logistic_number', 'tracking_number', 'mail_no') ?? ''),
        mp_sku_id: String(pick(l, 'sku_id', 'mp_sku_id') ?? '')
      })).filter((x) => x.tracking))
  };
}

/** Source of truth: /purchase/orders/query with the seller's token. */
async function syncSub(orderId, outer) {
  const o = db.orders.get(orderId);
  const sub = o?.sub_orders.find((s) => s.outer_purchase_id === outer);
  if (!sub) throw httpError(404, 'Purchase order not found');
  if (sub.manual) return o; // nothing to ask Taobao: updated by hand
  if (sub.direct) {
    await aliexpress.sync(sub);
    db.orders.update(o.id, (x) => ({ ...x, sub_orders: x.sub_orders.map((s) => (s.outer_purchase_id === outer ? sub : s)) }));
    return recompute(o.id);
  }
  const token = await tokenFor(sub.seller_id);
  const params = sub.purchase_ids.length ? { [API.ORDER_QUERY_PARAM]: sub.purchase_ids.join(',') } : { outer_purchase_id: outer };
  const r = await call(API.ORDER_QUERY, params, { accessToken: token });
  const d = r.data || r.result || r;
  const pos = (pick(d, 'purchase_orders', 'list', 'orders') || (Array.isArray(d) ? d : [d])).map(normalizePO).filter((p) => p.purchase_id);
  if (!pos.length) return o;

  const st = pos.map((p) => p.status);
  sub.status = st.find((s) => /WAIT_BUYER_P/.test(s)) || st.find((s) => /BU?ILDING/.test(s)) || st.find((s) => s === 'WAIT_SELLER_SEND_GOODS') || st[0];
  sub.purchase_ids = pos.map((p) => p.purchase_id);
  sub.pay_deadline = pos.map((p) => p.pay_deadline).find(Boolean) || null;
  sub.total_cny = pos.reduce((a, p) => a + Number(p.total_cny || 0), 0) || sub.total_cny;
  sub.logistics = pos.flatMap((p) => p.logistics);
  sub.synced_at = now();

  // Every tracking number becomes an expected inbound parcel in the warehouse
  for (const lg of sub.logistics) {
    if (!db.parcels.find((p) => p.tracking === lg.tracking)) {
      db.parcels.insert({ order_id: o.id, seller_id: sub.seller_id, outer_purchase_id: outer, tracking: lg.tracking, carrier: lg.carrier, mp_sku_id: lg.mp_sku_id, status: 'expected' });
    }
  }
  db.orders.update(o.id, (x) => ({ ...x, sub_orders: x.sub_orders.map((s) => (s.outer_purchase_id === outer ? sub : s)) }));
  return recompute(o.id);
}

/** Seller (or admin) submits payment from the seller's distribution account. Async: confirm via sync. */
async function paySub(orderId, outer) {
  const o = db.orders.get(orderId);
  const sub = o?.sub_orders.find((s) => s.outer_purchase_id === outer);
  if (!sub || !sub.purchase_ids.length) throw httpError(400, 'No purchase order is ready for payment');
  const token = await tokenFor(sub.seller_id);
  const r = await call(API.ORDER_PAY, { [API.ORDER_PAY_PARAM]: sub.purchase_ids.join(',') }, { accessToken: token });
  const d = r.data || r;
  sub.pay_submitted = ids(d.will_pay_purchase_order_ids);
  sub.pay_failed = ids(d.pay_failure_purchase_order_ids);
  sub.pay_requested_at = now();
  db.orders.update(o.id, (x) => ({ ...x, sub_orders: x.sub_orders.map((s) => (s.outer_purchase_id === outer ? sub : s)), timeline: log(x, 'seller_pay_submitted', { outer }) }));
  setTimeout(() => syncSub(o.id, outer).catch(() => {}), 5000).unref?.();
  return { submitted: sub.pay_submitted, failed: sub.pay_failed };
}

/**
 * Admin bought a manual sub-order on Taobao by hand. With the domestic tracking number the parcel
 * becomes "expected" in the warehouse, exactly like an API order.
 */
function markManualBought(orderId, { outer_purchase_id, taobao_order_no, tracking, carrier } = {}, by) {
  const o = db.orders.get(orderId);
  if (!o) throw httpError(404, 'Order not found');
  if (['pending_payment', 'cancelled', 'refunded', 'shipped', 'delivered'].includes(o.status)) throw httpError(409, 'This order is not being bought');
  const sub = o.sub_orders.find((s) => s.manual && (!outer_purchase_id || s.outer_purchase_id === outer_purchase_id));
  if (!sub) throw httpError(404, 'No manual purchase in this order');
  const tr = String(tracking || '').trim().slice(0, 60);
  if (taobao_order_no !== undefined) sub.purchase_ids = ids(String(taobao_order_no).slice(0, 200));
  if (tr) {
    sub.logistics = [...(sub.logistics || []).filter((x) => x.tracking !== tr), { carrier: String(carrier || '').slice(0, 40), tracking: tr }];
    if (!db.parcels.find((p) => p.tracking === tr)) db.parcels.insert({ order_id: o.id, seller_id: sub.seller_id, outer_purchase_id: sub.outer_purchase_id, tracking: tr, carrier: String(carrier || '').slice(0, 40), status: 'expected' });
  }
  sub.status = (sub.logistics || []).length ? 'WAIT_BUYER_CONFIRM_GOODS' : 'MANUAL_BOUGHT';
  sub.bought_at = sub.bought_at || now();
  db.orders.update(o.id, (x) => ({ ...x, status: x.status === 'paid' || x.status === 'attention' ? 'procuring' : x.status, sub_orders: x.sub_orders.map((s) => (s.outer_purchase_id === sub.outer_purchase_id ? sub : s)), timeline: log(x, tr ? 'manual_shipped_to_warehouse' : 'manual_bought', { by }) }));
  return recompute(o.id);
}

/** Derive the buyer-facing order status from sub-orders + parcels + shipment. */
function recompute(orderId) {
  const o = db.orders.get(orderId);
  if (!o || ['pending_payment', 'cancelled', 'refunded', 'delivered'].includes(o.status)) return o;
  const all = o.sub_orders || [];
  const subs = all.filter((s) => !s.direct);          // go through the China warehouse
  const direct = all.filter((s) => s.direct);         // AliExpress → customer
  if (o.status === 'shipped' && subs.length) return o; // warehouse part already left; delivery is confirmed by staff
  let status = o.status;
  if (subs.some((s) => s.status === 'CREATE_FAILED' || s.status === 'TRADE_CLOSED') || direct.some((s) => s.status === 'AE_CANCELLED' || (s.error && s.status === 'AE_TO_BUY'))) status = 'attention';
  else if (subs.length) {
    if (subs.every((s) => s.status === 'WAIT_BUYER_CONFIRM_GOODS')) {
      const parcels = db.parcels.all((p) => p.order_id === o.id);
      const allIn = parcels.length > 0 && parcels.every((p) => p.status === 'received');
      status = parcels.some((p) => p.status === 'qc_failed') ? 'attention' : allIn ? 'ready_to_ship' : 'awaiting_parcels';
    } else status = 'procuring';
  } else if (direct.length) {
    // AliExpress-only order: it is shipped/delivered when every AliExpress part is
    if (direct.every((s) => s.status === 'AE_DELIVERED')) status = 'delivered';
    else if (direct.every((s) => ['AE_SHIPPED', 'AE_DELIVERED'].includes(s.status))) status = 'shipped';
    else status = 'procuring';
  }
  if (status === o.status) return o;
  if (status === 'delivered') for (const l of db.ledger.all((x) => x.order_id === o.id && x.status === 'pending_payout')) db.ledger.update(l.id, { status: 'payable' });
  const updated = db.orders.update(o.id, (x) => ({ ...x, status, timeline: log(x, `status:${status}`) }));
  if (status === 'shipped') notify.orderShipped(updated, direct.flatMap((s) => (s.logistics || []).map((t) => ({ carrier: t.carrier, number: t.tracking }))));
  if (status === 'delivered') notify.orderDelivered(updated);
  return updated;
}

/** Admin: AliExpress part of an order — place it via the API, or record what was done by hand. */
async function updateDirect(orderId, { outer_purchase_id, place, ...manual } = {}, by) {
  const o = db.orders.get(orderId);
  if (!o) throw httpError(404, 'Order not found');
  if (['pending_payment', 'cancelled', 'refunded'].includes(o.status)) throw httpError(409, 'This order is not active');
  const sub = o.sub_orders.find((s) => s.direct && (!outer_purchase_id || s.outer_purchase_id === outer_purchase_id));
  if (!sub) throw httpError(404, 'No AliExpress part in this order');
  if (place) {
    if (!aliexpress.apiReady()) throw httpError(503, 'AliExpress API is not connected — order it by hand and enter the order number');
    if (sub.status !== 'AE_TO_BUY') throw httpError(409, 'Already ordered on AliExpress');
    await aliexpress.place(o, sub, o.lines.filter((l) => sub.line_nos.includes(l.line_no)));
  } else aliexpress.manualUpdate(sub, manual);
  const saved = db.orders.update(o.id, (x) => ({ ...x, status: x.status === 'paid' || x.status === 'attention' ? 'procuring' : x.status, sub_orders: x.sub_orders.map((s) => (s.outer_purchase_id === sub.outer_purchase_id ? sub : s)), timeline: log(x, `aliexpress:${sub.status}`, { by }) }));
  if (sub.status === 'AE_SHIPPED' && (sub.logistics || []).length && saved.lines.some((l) => !l.direct)) notify.orderShipped(saved, sub.logistics.map((t) => ({ carrier: t.carrier, number: t.tracking })));
  return recompute(o.id);
}

async function cancelOrder(orderId, by) {
  const o = db.orders.get(orderId);
  if (!o) throw httpError(404, 'Order not found');
  if (['shipped', 'delivered', 'cancelled', 'refunded'].includes(o.status)) throw httpError(409, 'This order cannot be cancelled');
  if (o.sub_orders.some((s) => s.direct && s.status !== 'AE_TO_BUY')) {
    throw httpError(409, 'Part of this order was already ordered on AliExpress — cancel it there first, then refund the customer');
  }
  if (o.sub_orders.some((s) => s.status === 'WAIT_BUYER_CONFIRM_GOODS')) {
    throw httpError(409, 'A Taobao seller already shipped part of this order — use the after-sales (refund) flow');
  }
  for (const s of o.sub_orders) {
    for (const pid of s.purchase_ids || []) {
      try { await call(API.ORDER_CANCEL, { [API.ORDER_CANCEL_PARAM]: pid }, { accessToken: await tokenFor(s.seller_id) }); } catch { /* reported in timeline */ }
    }
  }
  if (o.status !== 'pending_payment') {
    if (o.payment?.provider === 'wallet') shop.walletEntry(o.buyer_id, o.total, `Refund for order ${o.id.slice(-8).toUpperCase()}`, { order_id: o.id, kind: 'refund' });
    else await stripe.refund(o);
  } else if (o.payment?.provider === 'stripe') await stripe.cancelIntent(o.payment.intent_id);
  for (const led of db.ledger.all((l) => l.order_id === o.id)) db.ledger.update(led.id, { status: 'void' });
  if (o.status !== 'pending_payment') adjustStock(o, +1);
  return db.orders.update(o.id, (x) => ({ ...x, status: x.status === 'pending_payment' ? 'cancelled' : 'refunded', timeline: log(x, 'cancelled', { by }) }));
}

async function syncOpen() {
  for (const o of db.orders.all((x) => ['procuring', 'awaiting_parcels', 'attention', 'ready_to_ship', 'shipped'].includes(x.status) && (['procuring', 'awaiting_parcels', 'attention'].includes(x.status) || (x.sub_orders || []).some((s) => s.direct)))) {
    for (const s of o.sub_orders) {
      if (s.manual || ['CREATE_FAILED', 'TRADE_CLOSED'].includes(s.status)) continue;
      if (s.direct && !['AE_PLACED', 'AE_PAID', 'AE_SHIPPED'].includes(s.status)) continue;
      try { await syncSub(o.id, s.outer_purchase_id); } catch { /* keep going */ }
    }
  }
}

function findSub(pred) {
  for (const o of db.orders.all((x) => (x.sub_orders || []).length)) {
    const s = o.sub_orders.find(pred);
    if (s) return { order: o, sub: s };
  }
  return null;
}

function groupBy(arr, k) { return arr.reduce((m, x) => ((m[x[k]] = m[x[k]] || []).push(x), m), {}); }

function decorate(o) {
  return o && {
    ...o, status_label: ORDER_STATUS_LABEL[o.status] || o.status,
    sub_orders: (o.sub_orders || []).map((s) => ({ ...s, status_label: TB_STATUS_LABEL[s.status] || s.status, shop: db.sellers.get(s.seller_id)?.shop_name }))
  };
}

/** Buyer view hides cost, Taobao IDs and seller-side details. */
function buyerView(o) {
  const shipment = o.shipment_id ? db.shipments.get(o.shipment_id) : null;
  return {
    id: o.id, status: o.status, status_label: ORDER_STATUS_LABEL[o.status], currency: o.currency,
    subtotal: o.subtotal, shipping_fee: o.shipping_fee, total: o.total, created_at: o.created_at,
    shipping_due: o.shipping_due || 0, shipping_settled: o.shipping_settled ? { result: o.shipping_settled.result, diff: o.shipping_settled.diff, actual_weight_kg: o.shipping_settled.actual_weight_kg } : null, shipping_days: o.shipping_quote?.days || null,
    lines: o.lines.map(({ line_no, title, props, qty, price, image, listing_id, direct }) => ({ line_no, title, props, qty, price, image, listing_id, direct: Boolean(direct) })),
    shipping_address: o.shipping_address,
    payment: { provider: o.payment?.provider, client_secret: o.status === 'pending_payment' ? o.payment?.client_secret : undefined },
    tracking: shipment ? { carrier: shipment.carrier, number: shipment.tracking, shipped_at: shipment.shipped_at, url: require('./couriers').trackingUrl(shipment.carrier, shipment.tracking) } : null,
    // AliExpress parts travel separately, straight to the customer
    direct: (o.sub_orders || []).filter((s) => s.direct).map((s) => ({
      status: s.status, label: { AE_TO_BUY: 'Being ordered', AE_PLACED: 'Being ordered', AE_PAID: 'Ordered — preparing', AE_SHIPPED: 'On its way to you', AE_DELIVERED: 'Delivered', AE_CANCELLED: 'Being reviewed' }[s.status] || 'Being ordered',
      items: o.lines.filter((l) => s.line_nos.includes(l.line_no)).map((l) => l.title), tracking: (s.logistics || []).map((x) => ({ carrier: x.carrier, number: x.tracking, url: require('./couriers').trackingUrl(x.carrier, x.tracking) }))
    })),
    all_direct: (o.lines || []).every((l) => l.direct),
    timeline: (o.timeline || []).map((t) => ({ at: t.at, event: t.event }))
  };
}

/** Seller view: only their lines & sub-order, never the buyer's personal address. */
function sellerView(o, sellerId) {
  const lines = o.lines.filter((l) => l.seller_id === sellerId);
  const sub = (o.sub_orders || []).find((s) => s.seller_id === sellerId && !s.direct) || (o.sub_orders || []).find((s) => s.seller_id === sellerId);
  return {
    id: o.id, status: o.status, status_label: ORDER_STATUS_LABEL[o.status], created_at: o.created_at, currency: o.currency,
    lines: lines.map(({ title, props, qty, price, cost_cny }) => ({ title, props, qty, price, cost_cny })),
    revenue: money(lines.reduce((a, l) => a + l.price * l.qty, 0)),
    cost_cny: money(lines.reduce((a, l) => a + l.cost_cny * l.qty, 0)),
    purchase: sub ? { direct: Boolean(sub.direct), manual: Boolean(sub.manual), outer_purchase_id: sub.outer_purchase_id, purchase_ids: sub.purchase_ids, status: sub.status, status_label: TB_STATUS_LABEL[sub.status] || sub.status, pay_deadline: sub.pay_deadline, error: sub.error, logistics: sub.logistics || [] } : null
  };
}

module.exports = {
  cardPayment, stripePaid, confirmCard,
  checkout, markPaid, payWithWallet, markManualBought, updateDirect, procure, syncSub, paySub, recompute, cancelOrder, syncOpen, findSub,
  decorate, buyerView, sellerView, ORDER_STATUS_LABEL, TB_STATUS_LABEL, buildPurchasePayload
};
