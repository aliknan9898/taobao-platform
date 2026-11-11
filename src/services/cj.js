// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * CJdropshipping as a supplier that ships DIRECT to the customer (like AliExpress).
 *
 *  Products  search CJ's catalog or paste a CJ link / SKU → import with prices (cost + markup);
 *            prices and stock follow CJ (webhooks + a daily check).
 *  Checkout  the customer pays CJ's real shipping price to their country (cheapest or fastest method).
 *  Orders    after payment Kinan creates the CJ order with the customer's address and pays it from the
 *            CJ wallet balance automatically; status and tracking come back by webhook and polling.
 *  Safety    orders paid with test payments become CJ *sandbox* orders — nothing real is bought.
 *
 * CJ order statuses are mapped to the shared "direct" sub-order statuses (AE_* codes) so the rest of
 * Kinan (order page, warehouse, reports) treats CJ and AliExpress parts the same way.
 */
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');
const cj = require('../cj/client');

const money = (n) => Math.round(Number(n) * 100) / 100;
const now = () => Date.now();
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const PREFS = 'set_cj_prefs';
const HOOKS = 'set_cj_webhooks';

// ---------------- settings ----------------
function prefs() {
  return { shipping: 'cheapest', auto_pay: true, markup_pct: 40, max_days: 20, ...(db.settings.get(PREFS) || {}) };
}
function savePrefs(b = {}) {
  const p = prefs();
  const doc = {
    shipping: ['cheapest', 'fastest', 'balanced'].includes(b.shipping) ? b.shipping : p.shipping,
    auto_pay: b.auto_pay === undefined ? p.auto_pay : Boolean(b.auto_pay),
    markup_pct: b.markup_pct === undefined ? p.markup_pct : Math.min(500, Math.max(0, Number(b.markup_pct) || 0)),
    max_days: b.max_days === undefined ? p.max_days : Math.min(60, Math.max(3, Number(b.max_days) || 20))
  };
  const { id, created_at, updated_at, ...cur } = db.settings.get(PREFS) || {};
  void id; void created_at; void updated_at; void cur;
  return db.settings.get(PREFS) ? db.settings.update(PREFS, doc) : db.settings.insert({ id: PREFS, ...doc });
}

let balanceCache = null;
async function balance(force = false) {
  if (!force && balanceCache && now() - balanceCache.at < 5 * 60e3) return balanceCache.v;
  const d = await cj.call('GET', '/shopping/pay/getBalance');
  const v = { amount: Number(d?.amount) || 0, bonus: Number(d?.noWithdrawalAmount) || 0, frozen: Number(d?.freezeAmount) || 0, currency: 'USD' };
  balanceCache = { at: now(), v };
  return v;
}

async function status() {
  const out = { configured: cj.enabled(), connected: false, open_id: null, balance: null, prefs: prefs(), webhooks: db.settings.get(HOOKS) || null, error: null };
  if (!out.configured) return out;
  try { await cj.token(); out.connected = true; out.open_id = cj.openId(); out.balance = await balance(); } catch (e) { out.error = e.message; }
  return out;
}

// ---------------- products ----------------
/** Accepts a CJ product link (…-p-<pid>.html), a product id, or a CJ SKU. */
function parseRef(input) {
  const s = String(input || '').trim();
  const m = s.match(/-p-([A-Za-z0-9-]{8,64})\.html/i) || s.match(/[?&](?:pid|id)=([A-Za-z0-9-]{8,64})/i);
  if (m) return { pid: m[1] };
  if (/^CJ[A-Z0-9]{4,40}$/i.test(s)) return { productSku: s.toUpperCase() };
  if (/^[A-Za-z0-9-]{8,64}$/.test(s)) return { pid: s };
  throw httpError(400, 'Paste a CJdropshipping product link, product ID or SKU');
}

const list = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { return JSON.parse(v); } catch { return []; } }
  if (typeof v === 'string' && v) return v.split(',');
  return [];
};
const httpsImg = (u) => { const s = String(u || '').trim().replace(/^http:\/\//, 'https://'); return /^https:\/\/\S{8,500}$/.test(s) ? s : null; };
const stripHtml = (h) => String(h || '').replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const sumInv = (arr) => list(arr).reduce((a, x) => a + (Number(x.totalInventory ?? x.totalInventoryNum ?? x.storageNum ?? x.cjInventory) || 0), 0);

/** CJ product (from /product/query) → Kinan's shape. Costs are in USD. */
function normalize(p) {
  if (!p || !(p.pid || p.id)) throw httpError(404, 'Product not found on CJdropshipping');
  const pid = String(p.pid || p.id);
  const images = [...new Set([p.bigImage, p.bigimg, ...list(p.productImageSet), ...list(p.productImage), ...list(p.newImgList)].map(httpsImg).filter(Boolean))].slice(0, 10);
  const invByVid = new Map(list(p.variantInventory).map((x) => [String(x.vid), sumInv(x.inventory)]));
  const vars = list(p.variants || p.stanProducts);
  // Option names, e.g. productKeyEn "Color-Size" + variantKey "Sky blue-S" → Color: Sky blue, Size: S
  const keys = String(p.productKeyEn || p.productKey || '').split(/[-–]/).map((x) => x.trim()).filter(Boolean);
  const optsOf = (key) => {
    const parts = String(key || '').split('-').map((x) => x.trim());
    if (!key || !keys.length) return null;
    if (keys.length === 1) return [{ name: keys[0], value: String(key).trim() }];
    if (parts.length < keys.length) return null;
    // extra dashes belong to the first value ("T-shirt-M" with Style-Size → "T-shirt", "M")
    const head = parts.slice(0, parts.length - keys.length + 1).join('-');
    return [head, ...parts.slice(parts.length - keys.length + 1)].map((value, i) => ({ name: keys[i], value }));
  };
  const skus = vars.map((v) => {
    const vid = String(v.vid || v.id || '');
    const cost = Number(v.variantSellPrice ?? v.sellPrice ?? p.sellPrice);
    const inv = v.inventories ? sumInv(v.inventories) : invByVid.has(vid) ? invByVid.get(vid) : null;
    return {
      cj_vid: vid, mp_sku_id: `cj_${vid}`, cj_sku: str(v.variantSku, 80), props: str(v.variantKey || v.variantNameEn || v.variantName || '', 120),
      opts: optsOf(v.variantKey),
      cost_sale: money(cost), stock: inv === null ? 999 : Math.max(0, Math.floor(inv)),
      weight_g: Number(v.variantWeight) || Number(p.productWeight) || null, image: httpsImg(v.variantImage || v.img)
    };
  }).filter((s) => s.cj_vid && s.cost_sale > 0);
  if (!skus.length) throw httpError(422, 'This CJ product has no options with a price');
  return {
    cj_pid: pid, cj_sku: str(p.productSku, 80), title: str(p.productNameEn || p.nameEn || p.productName, 200),
    description: stripHtml(p.description).slice(0, 5000), images: images.length ? images : skus.map((s) => s.image).filter(Boolean).slice(0, 6),
    weight_kg: Number(p.productWeight) ? Math.round(Number(p.productWeight)) / 1000 : null,
    category: str(p.categoryName, 80), source_link: `https://cjdropshipping.com/product/-p-${pid}.html`, skus
  };
}

async function fetchProduct(ref) {
  const q = typeof ref === 'string' ? parseRef(ref) : ref;
  return normalize(await cj.call('GET', '/product/query', { query: q }));
}

const suggested = (cost, pct) => { const v = cost * (1 + (Number(pct ?? prefs().markup_pct) || 0) / 100); return Math.max(money(cost + 0.5), Math.ceil(v) - 0.01); };

async function preview(seller, ref) {
  const p = await fetchProduct(ref);
  const pct = seller?.default_markup_pct ?? prefs().markup_pct;
  return { ...p, skus: p.skus.map((s) => ({ ...s, suggested_price: suggested(s.cost_sale, pct) })) };
}

/** Catalog search (CJ listV2). */
async function search({ q, page = 1, size = 20, category, country } = {}) {
  const d = await cj.call('GET', '/product/listV2', { query: { keyWord: str(q, 100), page: Math.max(1, Math.min(1000, Number(page) || 1)), size: Math.max(1, Math.min(50, Number(size) || 20)), categoryId: category, countryCode: country } });
  const items = list(d?.content).flatMap((c) => list(c.productList)).map((x) => ({
    pid: String(x.id || x.pid), title: x.nameEn || x.productNameEn || '', sku: x.sku || x.productSku || '', image: httpsImg(x.bigImage || x.productImage), cost: Number(x.sellPrice) || null,
    stock: x.warehouseInventoryNum ?? null, suggested_price: Number(x.sellPrice) ? suggested(Number(String(x.sellPrice).split('-')[0])) : null
  }));
  return { items, page: Number(page) || 1, total: Number(d?.totalRecords) || items.length };
}

let catCache = null;
async function categories() {
  if (catCache && now() - catCache.at < 86400e3) return catCache.v;
  const d = await cj.call('GET', '/product/getCategory');
  const out = [];
  const walk = (arr, path = []) => { for (const c of list(arr)) { const name = c.categoryFirstName || c.categorySecondName || c.categoryName || c.name; const id = c.categoryId || c.id; const kids = c.categoryFirstList || c.categorySecondList || c.children; if (id && !kids) out.push({ id: String(id), name: [...path, name].filter(Boolean).join(' › ') }); if (kids) walk(kids, [...path, name]); } };
  walk(d);
  catCache = { at: now(), v: out };
  return out;
}

/** Import (or re-import) a CJ product for a shop. Kinan's own shop goes live at once; sellers' products are reviewed. */
async function publish(seller, { ref, prices = {}, title, description, category, markup_pct } = {}) {
  if (seller.status !== 'active') throw httpError(403, 'Seller account is awaiting admin approval');
  const p = await fetchProduct(ref);
  const existing = db.listings.find((l) => l.seller_id === seller.id && l.source === 'cj' && l.cj_pid === p.cj_pid);
  const pct = markup_pct ?? seller.default_markup_pct ?? prefs().markup_pct;
  const skus = p.skus.map((s) => {
    const price = prices[s.mp_sku_id] !== undefined && prices[s.mp_sku_id] !== '' ? money(prices[s.mp_sku_id]) : suggested(s.cost_sale, pct);
    if (!(price > 0)) throw httpError(400, `Invalid price for ${s.props || 'an option'}`);
    return { ...s, price };
  });
  const newTitle = str(title || p.title, 200);
  const newDesc = String(description ?? p.description).replace(/<[^>]*>/g, '').slice(0, 5000);
  const own = Boolean(seller.system);
  const keep = existing && existing.review?.state === 'approved' && existing.title === newTitle && (existing.description || '') === newDesc;
  const doc = {
    category: require('./shipping').cleanCategory(category ?? existing?.category),
    seller_id: seller.id, source: 'cj', fulfillment: 'direct', cj_pid: p.cj_pid, cj_sku: p.cj_sku, source_link: p.source_link,
    taobao_item_id: null, mp_id: null, item_type: 'CJ', title: newTitle, description: newDesc, custom_description: true,
    images: p.images, own_images: existing?.own_images || [], weight_kg: p.weight_kg, begin_amount: 1, currency: config.currency, skus,
    last_synced_at: now(), sync_error: null,
    ...(own ? { status: 'active', review: { state: 'approved', decided_at: now(), note: 'Kinan shop (CJ)' } } : keep ? { status: existing.status } : { status: 'pending_review', review: { state: 'pending', submitted_at: now() } })
  };
  return existing ? db.listings.update(existing.id, doc) : db.listings.insert(doc);
}

/** Follow CJ's cost and stock. Missing options get stock 0; a product CJ removed becomes unavailable. */
async function resync(l) {
  if (!cj.enabled() || l.source !== 'cj' || !l.cj_pid) return l;
  try {
    const p = await fetchProduct({ pid: l.cj_pid });
    const by = new Map(p.skus.map((s) => [s.cj_vid, s]));
    const skus = l.skus.map((s) => { const f = by.get(s.cj_vid); return f ? { ...s, cost_sale: f.cost_sale, stock: f.stock, opts: f.opts, image: f.image || s.image || null } : { ...s, stock: 0 }; });
    return db.listings.update(l.id, { skus, last_synced_at: now(), sync_error: null, ...(l.status === 'unavailable' && skus.some((s) => s.stock > 0) ? { status: 'active' } : {}) });
  } catch (e) {
    if (e.status === 404 || /not found/i.test(e.message)) return db.listings.update(l.id, { status: l.status === 'active' ? 'unavailable' : l.status, sync_error: 'Removed on CJdropshipping', last_synced_at: now() });
    return db.listings.update(l.id, { sync_error: e.message, last_synced_at: now() });
  }
}

/** Daily: re-check the CJ products that were not refreshed for a day (CJ allows 1 call per second). */
async function resyncStale(max = 200) {
  if (!cj.enabled()) return 0;
  const stale = db.listings.all((l) => l.source === 'cj' && ['active', 'paused', 'unavailable', 'private'].includes(l.status) && now() - (l.last_synced_at || 0) > 22 * 3600e3)
    .sort((a, b) => (a.last_synced_at || 0) - (b.last_synced_at || 0)).slice(0, max);
  for (const l of stale) await resync(l);
  return stale.length;
}

// ---------------- shipping at checkout ----------------
const fcache = new Map();
/** CJ's shipping options for these variants to a country (cached 6 hours). */
async function freightOptions(countryCode, items) {
  const key = `${countryCode}|${items.map((i) => `${i.vid}x${i.qty}`).sort().join(',')}`;
  const c = fcache.get(key); if (c && now() - c.at < 6 * 3600e3) return c.v;
  const d = await cj.call('POST', '/logistic/freightCalculate', { body: { startCountryCode: 'CN', endCountryCode: countryCode, products: items.map((i) => ({ vid: i.vid, quantity: i.qty })) } });
  const v = list(d).map((o) => {
    const m = String(o.logisticAging || '').match(/(\d+)\D+(\d+)/) || String(o.logisticAging || '').match(/(\d+)/);
    return { method: o.logisticName, fee: money(Number(o.totalPostageFee ?? o.logisticPrice) || 0), days: o.logisticAging || '', min: m ? Number(m[1]) : null, max: m ? Number(m[2] || m[1]) : null };
  }).filter((o) => o.method && o.fee >= 0);
  fcache.set(key, { at: now(), v });
  if (fcache.size > 2000) fcache.delete(fcache.keys().next().value);
  return v;
}

/**
 * Shipping for one piece of this product to a country, when it is already known (kept on the product for 3 days);
 * otherwise CJ is asked in the background (1 request per second) and null is returned for now.
 */
const SHIP_TTL = 3 * 86400e3;
const warm = new Set(); let warming = false;
const cheapestVid = (l) => [...(l.skus || [])].filter((x) => x.cj_vid).sort((a, b) => a.price - b.price)[0]?.cj_vid || null;
function cachedFee(l, countryCode) {
  if (!countryCode || l.source !== 'cj') return null;
  const k = l.cj_ship && l.cj_ship[countryCode];
  if (k && now() - k.at < SHIP_TTL && k.vid === cheapestVid(l)) return k.fee;
  if (cj.enabled() && warm.size < 1000) { warm.add(`${countryCode}|${l.id}`); if (!warming) warmUp(); }
  return null;
}
async function warmUp() {
  warming = true;
  try {
    while (warm.size) {
      const key = warm.values().next().value; warm.delete(key);
      const [cc, id] = key.split('|'); const l = db.listings.get(id); const vid = l && cheapestVid(l);
      if (!vid) continue;
      const k = l.cj_ship && l.cj_ship[cc]; if (k && now() - k.at < SHIP_TTL && k.vid === vid) continue;
      try {
        const o = choose(await freightOptions(cc, [{ vid, qty: 1 }]));
        db.listings.update(id, (x) => ({ ...x, cj_ship: { ...(x.cj_ship || {}), [cc]: { fee: o ? o.fee : FALLBACK, vid, at: now(), estimated: !o } } }));
      } catch { /* try again on a later visit */ }
    }
  } finally { warming = false; }
}
/** A customer saved their address: work out CJ shipping to their country for every CJ product in the shop. */
function prepareCountry(countryCode) {
  if (!/^[A-Z]{2}$/.test(String(countryCode || '')) || !cj.enabled()) return { pending: 0 };
  let n = 0;
  for (const l of db.listings.all((x) => x.source === 'cj' && x.status === 'active')) if (cachedFee(l, countryCode) === null) n++;
  return { pending: n };
}

function choose(options) {
  if (!options.length) return null;
  const p = prefs();
  const byPrice = [...options].sort((a, b) => a.fee - b.fee);
  if (p.shipping === 'fastest') return [...options].sort((a, b) => (a.max ?? 99) - (b.max ?? 99) || a.fee - b.fee)[0];
  if (p.shipping === 'balanced') return byPrice.find((o) => (o.max ?? 99) <= p.max_days) || byPrice[0];
  return byPrice[0];
}

const FALLBACK = Number(process.env.CJ_FALLBACK_SHIPPING ?? 8);
/** Shipping for the CJ lines of a cart [{ listing_id, mp_sku_id, qty }] to a country. */
async function quote(items, countryCode) {
  const lines = items.map((it) => {
    const l = db.listings.get(it.listing_id);
    if (!l || l.source !== 'cj') return null;
    const s = l.skus.find((x) => x.mp_sku_id === it.mp_sku_id) || l.skus[0];
    return s?.cj_vid ? { vid: s.cj_vid, qty: Math.max(1, Math.floor(Number(it.qty) || 1)) } : null;
  }).filter(Boolean);
  if (!lines.length) return null;
  if (!countryCode) return { fee: 0, method: null, days: null, pending_country: true };
  try {
    const opt = choose(await freightOptions(countryCode, lines));
    if (!opt) return { fee: money(FALLBACK), method: null, days: null, estimated: true, note: 'CJ has no shipping method to this country for these items' };
    return { fee: opt.fee, method: opt.method, days: opt.days };
  } catch (e) {
    return { fee: money(FALLBACK), method: null, days: null, estimated: true, note: e.message };
  }
}

// ---------------- orders ----------------
const STATUS = { CREATED: 'AE_PLACED', IN_CART: 'AE_PLACED', UNPAID: 'AE_PLACED', PENDING: 'AE_PAID', PROCESSING: 'AE_PAID', UNSHIPPED: 'AE_PAID', SHIPPED: 'AE_SHIPPED', DELIVERED: 'AE_DELIVERED', CANCELLED: 'AE_CANCELLED' };
const LABEL = { AE_TO_BUY: 'To order on CJ', AE_PLACED: 'Created on CJ — waiting for payment', AE_PAID: 'Paid — CJ is preparing it', AE_SHIPPED: 'Shipped to the customer', AE_DELIVERED: 'Delivered', AE_CANCELLED: 'Cancelled on CJ' };

function newDirectSub(o, sellerId, lines) {
  return {
    seller_id: sellerId, order_id: o.id, outer_purchase_id: `CJ${o.id.slice(-8).toUpperCase()}${sellerId.slice(-4).toUpperCase()}`,
    line_nos: lines.map((l) => l.line_no), direct: true, source: 'cj', status: 'AE_TO_BUY', purchase_ids: [], logistics: [], error: null,
    links: lines.map((l) => ({ title: l.title, props: l.props, qty: l.qty, link: l.source_link || '' }))
  };
}

const isTest = (o) => require('../payments/stripe').isTestPayment(o) || process.env.CJ_SANDBOX === '1';

/** Create the CJ order with the CUSTOMER's address, then pay it from the CJ balance (if allowed). */
async function place(o, sub, lines) {
  if (!cj.enabled()) { sub.error = 'CJdropshipping is not connected — order it by hand on cjdropshipping.com'; return sub; }
  const a = o.shipping_address || {};
  if (!a.country_code) { sub.error = 'Customer country is not recognised'; return sub; }
  if (lines.some((l) => !l.cj_vid)) { sub.error = 'An item has no CJ variant — check the product'; return sub; }
  const items = lines.map((l) => ({ vid: l.cj_vid, qty: l.qty }));
  let method = o.cj_shipping?.method;
  if (!method) { try { method = choose(await freightOptions(a.country_code, items))?.method; } catch { /* below */ } }
  if (!method) { sub.error = 'CJ has no shipping method to this country for these items'; return sub; }
  const body = {
    orderNumber: `${o.id}-${sub.seller_id.slice(-4)}`.slice(0, 50), shippingCountryCode: a.country_code, shippingCountry: a.country || a.country_code,
    shippingProvince: str(a.state || a.city, 50), shippingCity: str(a.city, 50), shippingCustomerName: str(a.name, 50), shippingAddress: str(a.line1, 500),
    shippingAddress2: str(a.line2, 200), shippingZip: str(a.postal_code, 20), shippingPhone: str(a.phone, 30), logisticName: method, fromCountryCode: 'CN',
    payType: 3, remark: `Kinan ${o.id.slice(-8).toUpperCase()} — no invoice or prices in the parcel please`,
    products: lines.map((l) => ({ vid: l.cj_vid, quantity: l.qty, storeLineItemId: `${o.id}-${l.line_no}` })),
    ...(isTest(o) ? { isSandbox: 1 } : {})
  };
  try {
    const d = await cj.call('POST', '/shopping/order/createOrderV2', { body });
    if (!d?.orderId) throw new Error('CJ did not return an order number');
    sub.purchase_ids = [String(d.orderId)]; sub.shipment_order_id = d.shipmentOrderId ? String(d.shipmentOrderId) : null;
    sub.cj_amount = Number(d.actualPayment ?? d.orderAmount) || null; sub.cj_method = method; sub.sandbox = Boolean(body.isSandbox);
    sub.status = 'AE_PLACED'; sub.error = Array.isArray(d.interceptOrderReasons) && d.interceptOrderReasons.length ? `CJ: ${d.interceptOrderReasons.join(', ')}` : null; sub.placed_at = now();
  } catch (e) { sub.error = e.message.startsWith('CJ') ? e.message : `CJ: ${e.message}`; return sub; }
  if (prefs().auto_pay) await pay(sub);
  return sub;
}

/** Pay a created CJ order from the CJ wallet. On failure (usually low balance) the order waits and the owner is told. */
async function pay(sub) {
  if (!sub.purchase_ids?.length) throw httpError(409, 'This part has no CJ order yet');
  try {
    if (sub.shipment_order_id) await cj.call('POST', '/shopping/pay/payBalanceV2', { body: { shipmentOrderId: sub.shipment_order_id } });
    else await cj.call('POST', '/shopping/pay/payBalance', { body: { orderId: sub.purchase_ids[0] } });
    sub.status = 'AE_PAID'; sub.error = null; sub.paid_at = now(); balanceCache = null;
  } catch (e) {
    sub.error = `Not paid on CJ: ${e.message}. Top up the CJ balance, then press “Pay on CJ”.`;
    require('../push').telegram(`⚠️ CJ order ${sub.purchase_ids[0]} could not be paid (${e.message}). Top up your CJ balance: https://cjdropshipping.com/my.html#/myWallet`);
  }
  return sub;
}

/** Status and tracking from CJ. */
async function sync(sub) {
  if (!cj.enabled() || !sub.purchase_ids?.length) return sub;
  const d = await cj.call('GET', '/shopping/order/getOrderDetail', { query: { orderId: sub.purchase_ids[0] } });
  applyOrder(sub, d);
  sub.synced_at = now();
  return sub;
}

function applyOrder(sub, d) {
  if (!d) return sub;
  const st = STATUS[String(d.orderStatus || '').toUpperCase()];
  const rank = ['AE_TO_BUY', 'AE_PLACED', 'AE_PAID', 'AE_SHIPPED', 'AE_DELIVERED'];
  if (st === 'AE_CANCELLED') sub.status = st;
  else if (st && rank.indexOf(st) >= rank.indexOf(sub.status)) sub.status = st; // never go backwards
  const tn = d.trackNumber || d.trackingNumber;
  if (tn) sub.logistics = [{ carrier: d.trackingProvider || d.logisticName || 'CJ', tracking: String(tn), url: d.trackingUrl || null, method: d.logisticName || null }];
  if (sub.status === 'AE_PAID' || sub.status === 'AE_SHIPPED') sub.error = null;
  return sub;
}

/** Cancel the CJ part when the customer's order is cancelled: only possible before it is paid on CJ. */
async function cancel(sub) {
  if (sub.status === 'AE_TO_BUY' || !sub.purchase_ids?.length) { sub.status = 'AE_CANCELLED'; return sub; }
  if (sub.status !== 'AE_PLACED') throw httpError(409, 'The CJ part is already paid — ask CJ support to cancel it first, then refund the customer');
  await cj.call('DELETE', '/shopping/order/deleteOrder', { query: { orderId: sub.purchase_ids[0] } });
  sub.status = 'AE_CANCELLED';
  return sub;
}

// ---------------- webhooks ----------------
/** CJ signs with Base64(HmacSHA256(key = openId, message = raw body)). */
function verify(rawBody, signHeader) {
  const id = cj.openId();
  if (!id || !signHeader) return false;
  const want = crypto.createHmac('sha256', String(id)).update(rawBody).digest('base64');
  const a = Buffer.from(want); const b = Buffer.from(String(signHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const seen = new Map();
/** Handle one webhook message (already verified). Returns what changed, for logs and tests. */
function handleWebhook(msg) {
  if (!msg || typeof msg !== 'object') return { ignored: 'empty' };
  if (msg.messageId) { if (seen.has(msg.messageId)) return { ignored: 'duplicate' }; seen.set(msg.messageId, now()); if (seen.size > 5000) seen.delete(seen.keys().next().value); }
  const t = String(msg.type || '').toUpperCase(); const p = msg.params || {};
  const orders = require('./orders');
  if (t === 'ORDER' || t === 'LOGISTIC') {
    const cjId = String(p.cjOrderId || p.orderId || '');
    const nums = [p.orderNumber, ...(p.storeOrderNumbers || [])].filter(Boolean).map(String);
    const hit = orders.findSub((s) => s.source === 'cj' && ((cjId && (s.purchase_ids || []).includes(cjId)) || nums.some((n) => n.startsWith(s.order_id))));
    if (!hit) return { ignored: 'unknown order' };
    const sub = { ...hit.sub };
    if (t === 'ORDER') applyOrder(sub, p);
    else {
      const tn = p.trackingNumber || p.trackNumber;
      if (tn) sub.logistics = [{ carrier: p.trackingProvider || p.logisticName || 'CJ', tracking: String(tn), url: p.trackingUrl || null, method: p.logisticName || null }];
      if (Number(p.trackingStatus) === 12) sub.status = 'AE_DELIVERED';
      else if (tn && ['AE_PLACED', 'AE_PAID'].includes(sub.status)) sub.status = 'AE_SHIPPED';
      if (Number(p.trackingStatus) === 13) sub.error = 'Delivery problem reported by the carrier — check the tracking';
    }
    db.orders.update(hit.order.id, (x) => ({ ...x, sub_orders: x.sub_orders.map((s) => (s.outer_purchase_id === sub.outer_purchase_id ? sub : s)) }));
    orders.recompute(hit.order.id);
    return { order: hit.order.id, status: sub.status };
  }
  if (t === 'PRODUCT' || t === 'VARIANT') {
    const pid = String(p.pid || p.productId || '');
    const ls = db.listings.all((l) => l.source === 'cj' && l.cj_pid === pid);
    for (const l of ls) {
      if (Number(p.productStatus) === 2 || msg.messageType === 'DELETE') db.listings.update(l.id, { status: l.status === 'active' ? 'unavailable' : l.status, sync_error: 'Off sale on CJdropshipping' });
      else resync(l).catch(() => {});
    }
    return { products: ls.length };
  }
  if (t === 'STOCK') {
    let n = 0;
    for (const [vid, whs] of Object.entries(p)) {
      const qty = list(whs).reduce((a, w) => a + (Number(w.storageNum) || 0), 0);
      for (const l of db.listings.all((x) => x.source === 'cj' && x.skus.some((s) => s.cj_vid === vid))) { db.listings.update(l.id, (x) => ({ ...x, skus: x.skus.map((s) => (s.cj_vid === vid ? { ...s, stock: qty } : s)) })); n++; }
    }
    return { stock_updates: n };
  }
  return { ignored: t || 'unknown type' };
}

/** CJ products imported before options were grouped: fetch them again once to get option names and pictures. */
async function upgradeOptions() {
  if (!cj.enabled()) return 0;
  const old = db.listings.all((l) => l.source === 'cj' && l.skus.some((s) => s.opts === undefined));
  for (const l of old) await resync(l);
  if (old.length) console.log(`[cj] grouped options for ${old.length} product(s)`);
  return old.length;
}

// ---------------- best sellers, added automatically ----------------
const AUTO = 'set_cj_auto'; const AUTO_STATE = 'set_cj_auto_state';
function autoPrefs() { return { enabled: true, count: 30, max_cost: 40, min_stock: 20, every_days: 7, ...(db.settings.get(AUTO) || {}) }; }
function saveAutoPrefs(b = {}) {
  const p = autoPrefs();
  const doc = {
    enabled: b.enabled === undefined ? p.enabled : Boolean(b.enabled),
    count: b.count === undefined ? p.count : Math.min(200, Math.max(1, Math.floor(Number(b.count) || 30))),
    max_cost: b.max_cost === undefined ? p.max_cost : Math.min(500, Math.max(1, Number(b.max_cost) || 40)),
    min_stock: b.min_stock === undefined ? p.min_stock : Math.min(10000, Math.max(0, Math.floor(Number(b.min_stock) || 0))),
    every_days: b.every_days === undefined ? p.every_days : Math.min(60, Math.max(1, Math.floor(Number(b.every_days) || 7)))
  };
  return db.settings.get(AUTO) ? db.settings.update(AUTO, doc) : db.settings.insert({ id: AUTO, ...doc });
}
const autoState = () => db.settings.get(AUTO_STATE) || { running: false };
const setState = (patch) => { const cur = db.settings.get(AUTO_STATE); return cur ? db.settings.update(AUTO_STATE, patch) : db.settings.insert({ id: AUTO_STATE, ...patch }); };

/** Kinan's shop sells to Arab families: products that do not fit are never added automatically. */
const BLOCK = /\b(sex|sexy|adult|erotic|lingerie|vibrator|dildo|condom|nipple|bdsm|fetish|alcohol|wine|beer|whisky|vodka|cigarette|e-?cig|vape|hookah tobacco|knife|knives|dagger|gun|pistol|rifle|airsoft|weapon|crossbow|slingshot|ammo|pork|bacon|cross necklace|tarot|ouija|casino|replica|counterfeit)\b/i;

/** Kinan category from CJ's category name and the title. */
function guessCategory(text) {
  const t = String(text || '').toLowerCase();
  const rules = [
    ['phone', /phone|iphone|samsung|charger|charging|cable|power bank|earbud|airpod|screen protector|case for/], ['car', /\bcar\b|vehicle|auto |motorcycle|bike light|dashboard/],
    ['electronics', /electronic|bluetooth|speaker|headphone|camera|led|usb|smart watch|smartwatch|projector|keyboard|mouse|computer|gadget/],
    ['beauty', /beauty|makeup|cosmetic|skin|hair|nail|lash|lipstick|perfume|massag|teeth|shaver|trimmer/], ['kids', /baby|kid|child|infant|toddler|maternity/],
    ['toys', /toy|puzzle|game|doll|lego|plush|fidget/], ['shoes_bags', /shoe|sneaker|boot|sandal|slipper|bag|backpack|wallet|handbag|luggage/],
    ['sports', /sport|fitness|yoga|gym|outdoor|camping|hiking|fishing|cycling|swim/], ['women', /women|woman|dress|skirt|blouse|bra|ladies|girl/],
    ['men', /\bmen\b|\bman\b|mens|men's|beard/], ['home', /home|kitchen|house|bath|bedding|storage|decor|lamp|garden|pet|cleaning|organizer|cup|bottle|tool/]
  ];
  return (rules.find(([, re]) => re.test(t)) || ['other'])[0];
}

/**
 * Add CJ's top products (trending, most-listed) to the Kinan shop, skipping ones already there, too expensive,
 * low on stock or not suitable. Runs in the background; progress is kept in settings.
 */
async function importBestSellers(opts = {}, by = 'auto') {
  if (!cj.enabled()) throw httpError(503, 'CJdropshipping is not connected');
  if (autoState().running && now() - (autoState().started_at || 0) < 3 * 3600e3) return autoState();
  const p = { ...autoPrefs(), ...opts };
  const kinan = require('./buyforme').systemSeller();
  const have = new Set(db.listings.all((l) => l.source === 'cj').map((l) => l.cj_pid));
  const st = { running: true, started_at: now(), by, target: p.count, added: 0, skipped: 0, checked: 0, error: null, added_titles: [] };
  setState(st);
  try {
    for (let page = 1; page <= 15 && st.added < p.count; page++) {
      const d = await cj.call('GET', '/product/listV2', { query: { page, size: 50, productFlag: 0, orderBy: 1, sort: 'desc', endSellPrice: p.max_cost, startWarehouseInventory: p.min_stock || undefined } });
      const items = list(d?.content).flatMap((c) => list(c.productList));
      if (!items.length) break;
      for (const x of items) {
        if (st.added >= p.count) break;
        const pid = String(x.id || x.pid || ''); st.checked++;
        const title = x.nameEn || x.productNameEn || '';
        const cost = Number(String(x.sellPrice ?? '').split(/[-–]/)[0]);
        if (!pid || have.has(pid) || BLOCK.test(title) || !(cost > 0) || cost > p.max_cost || !(x.bigImage || x.productImage)) { st.skipped++; continue; }
        have.add(pid);
        try {
          const l = await publish(kinan, { ref: { pid }, category: guessCategory(`${x.threeCategoryName || x.categoryName || ''} ${title}`) });
          if (!l.skus.some((k) => k.stock >= Math.min(p.min_stock, 1)) || BLOCK.test(`${l.title} ${l.description}`)) { db.listings.update(l.id, { status: 'paused', sync_error: 'Added automatically but out of stock or not suitable' }); st.skipped++; continue; }
          db.listings.update(l.id, { cj_auto: true, cj_listed: Number(x.listedNum) || null, auto_added_at: now() });
          st.added++; st.added_titles = [...st.added_titles, l.title].slice(-50);
        } catch (e) { st.skipped++; st.last_item_error = e.message; }
        setState({ ...st });
      }
    }
  } catch (e) { st.error = e.message; }
  st.running = false; st.done_at = now();
  setState({ ...st });
  console.log(`[cj] best sellers: added ${st.added}, skipped ${st.skipped}${st.error ? ` — ${st.error}` : ''}`);
  if (st.added) try { require('../push').telegram(`🛍️ CJ best sellers: ${st.added} new product(s) added to the Kinan shop.`); } catch { /* optional */ }
  return st;
}

/** Hourly check: add new best sellers every N days (the first time soon after CJ is connected). */
async function autoTick() {
  const p = autoPrefs();
  if (!cj.enabled() || !p.enabled) return null;
  const s = autoState();
  if (s.running && now() - (s.started_at || 0) < 3 * 3600e3) return null;
  if (s.done_at && now() - s.done_at < p.every_days * 86400e3) return null;
  return importBestSellers({}, 'auto');
}

/** Tell CJ where to send product, stock, order and logistics updates (once per site address). */
async function registerWebhooks() {
  if (!cj.enabled() || !/^https:\/\//.test(config.publicBaseUrl)) return { skipped: true };
  const url = `${config.publicBaseUrl}/webhooks/cj`;
  const s = db.settings.get(HOOKS);
  if (s && s.url === url && s.key_hint === String(process.env.CJ_API_KEY).slice(-6)) return s;
  const on = { type: 'ENABLE', callbackUrls: [url] };
  await cj.call('POST', '/webhook/set', { body: { product: on, stock: on, order: on, logistics: on } });
  const doc = { url, key_hint: String(process.env.CJ_API_KEY).slice(-6), at: now() };
  console.log(`[cj] webhooks registered → ${url}`);
  return s ? db.settings.update(HOOKS, doc) : db.settings.insert({ id: HOOKS, ...doc });
}

module.exports = {
  prefs, savePrefs, status, balance, parseRef, normalize, fetchProduct, preview, search, categories, publish, resync, resyncStale,
  freightOptions, cachedFee, prepareCountry, choose, quote, newDirectSub, place, pay, sync, applyOrder, cancel, verify, handleWebhook, registerWebhooks, upgradeOptions, autoPrefs, saveAutoPrefs, autoState, importBestSellers, autoTick, guessCategory, BLOCK, STATUS, LABEL
};
