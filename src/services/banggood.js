// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Banggood as a supplier that ships DIRECT to the customer (like CJ and AliExpress).
 *
 *  Products  paste a Banggood link or product ID → options (poa), price per warehouse (CN / UK / US / HK),
 *            stock; imported with cost + markup. The warehouse closest to customers is preferred (UK first).
 *  Checkout  Banggood's real shipping price for the product to the customer's country (getShipments).
 *  Orders    after payment Kinan creates the Banggood order (importOrder) with the customer's address.
 *            Banggood's API has no payment call: the order is paid in the Banggood account, then
 *            status and tracking events come back by polling (getOrderInfo / getTrackInfo).
 */
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');
const bg = require('../banggood/client');

const money = (n) => Math.round(Number(n) * 100) / 100;
const now = () => Date.now();
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const PREFS = 'set_banggood_prefs';
const enabled = () => bg.enabled();

// ---------------- settings ----------------
function prefs() { return { markup_pct: 40, warehouse: 'auto', shipping: 'cheapest', max_days: 20, ...(db.settings.get(PREFS) || {}) }; }
function savePrefs(b = {}) {
  const p = prefs();
  const doc = {
    markup_pct: b.markup_pct === undefined ? p.markup_pct : Math.min(500, Math.max(0, Number(b.markup_pct) || 0)),
    warehouse: ['auto', 'UK', 'CN', 'US', 'HK'].includes(b.warehouse) ? b.warehouse : p.warehouse,
    shipping: ['cheapest', 'fastest', 'balanced'].includes(b.shipping) ? b.shipping : p.shipping,
    max_days: b.max_days === undefined ? p.max_days : Math.min(60, Math.max(3, Number(b.max_days) || 20))
  };
  return db.settings.get(PREFS) ? db.settings.update(PREFS, doc) : db.settings.insert({ id: PREFS, ...doc });
}
async function status() {
  const out = { configured: enabled(), connected: false, sandbox: process.env.BANGGOOD_SANDBOX === '1', prefs: prefs(), error: null, products: db.listings.all((l) => l.source === 'banggood').length };
  if (!out.configured) return out;
  try { await bg.token(); out.connected = true; } catch (e) { out.error = e.message; }
  return out;
}

// ---------------- products ----------------
/** Banggood link (…-p-1234567.html, ?products_id=…) or a product ID. */
function parseRef(input) {
  const s = String(input || '').trim();
  const m = s.match(/-p-(\d{5,12})\.html/i) || s.match(/[?&](?:products?_id|product_id|id)=(\d{5,12})/i);
  if (m) return m[1];
  if (/^\d{5,12}$/.test(s)) return s;
  throw httpError(400, 'Paste a Banggood product link or product ID');
}

const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const httpsImg = (u) => { const s = String(u || '').trim().replace(/^\/\//, 'https://').replace(/^http:\/\//, 'https://'); return /^https:\/\/\S{8,500}$/.test(s) ? s : null; };
const stripHtml = (h) => String(h || '').replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const WH_ORDER = ['UK', 'CN', 'HK', 'US'];

/** Which Banggood warehouse to use for a product: the admin's choice if it has it, else UK, then CN. */
function pickWarehouse(available, want = prefs().warehouse) {
  const has = (w) => available.includes(w);
  if (want !== 'auto' && has(want)) return want;
  return WH_ORDER.find(has) || available[0] || 'CN';
}

/** Every option combination (poa ids joined with ","), at most 100. */
function combos(groups) {
  let out = [[]];
  for (const g of groups) {
    const vals = arr(g.option_values);
    if (!vals.length) continue;
    out = out.flatMap((c) => vals.map((v) => [...c, { group: str(g.option_name, 60), id: String(v.poa_id), name: str(v.poa_name, 80), price: Number(v.poa_price) || 0, image: httpsImg(v.large_image || v.view_image || v.small_image) }]));
    if (out.length > 100) { out = out.slice(0, 100); break; }
  }
  return out;
}

/** getProductInfo (+ getStocks, getProductPrice) → Kinan's shape. Costs in USD. */
async function fetchProduct(ref, wantWarehouse) {
  const pid = parseRef(ref);
  const info = await bg.call('GET', 'product/getProductInfo', { product_id: pid });
  const whs = arr(info.warehouse_list).map((w) => ({ warehouse: String(w.warehouse || '').toUpperCase(), price: Number(w.warehouse_price) || 0 })).filter((w) => w.warehouse);
  if (!whs.length) throw httpError(422, 'This Banggood product has no warehouse with a price');
  const warehouse = pickWarehouse(whs.map((w) => w.warehouse), wantWarehouse);
  const base = whs.find((w) => w.warehouse === warehouse).price;

  // Banggood's rule: product price = warehouse_price + the poa_price of each chosen option
  const stockBy = new Map();
  try {
    const st = await bg.call('GET', 'product/getStocks', { product_id: pid });
    for (const w of arr(st.stocks)) {
      if (String(w.warehouse || '').toUpperCase() !== warehouse) continue;
      for (const x of arr(w.stock_list || w.stocks_list)) stockBy.set(String(x.poa_id ?? ''), { stock: Math.max(0, Math.floor(Number(x.stock) || 0)), msg: str(x.stock_msg || x.stocks_msg, 120) });
    }
  } catch { /* unknown stock: shown as available */ }

  const norm = (ids) => ids.split(',').filter(Boolean).sort().join(',');
  const stockNorm = new Map([...stockBy].map(([k, v]) => [norm(k), v]));
  const skus = combos(arr(info.poa_list)).map((c) => {
    const poa = c.map((x) => x.id).join(',');
    const cost = money(base + c.reduce((a, x) => a + x.price, 0));
    const st = stockNorm.get(norm(poa)) ?? (c.length ? null : stockNorm.get(''));
    return {
      bg_poa: poa, mp_sku_id: `bg_${pid}_${poa ? poa.replace(/,/g, '-') : '0'}`, props: c.map((x) => x.name).join(' / ').slice(0, 120),
      opts: c.length ? c.map((x) => ({ name: x.group || 'Option', value: x.name })) : null,
      cost_sale: money(cost), stock: st ? st.stock : 999, image: c.map((x) => x.image).find(Boolean) || null
    };
  }).filter((s) => s.cost_sale > 0);
  if (!skus.length) throw httpError(422, 'This Banggood product has no options with a price');
  // image_list sizes are single URLs (or lists): take the large ones first
  const il = info.image_list && typeof info.image_list === 'object' ? info.image_list : {};
  const many = (v) => (typeof v === 'string' ? [v] : arr(v));
  const images = [...new Set([...many(il.large), ...many(il.view), ...many(il.gallery)].map(httpsImg).filter(Boolean))].slice(0, 10);
  // The description is usually HTML; some products give an object of image links instead
  const descText = typeof info.description === 'string' ? stripHtml(info.description) : '';
  const weight = Number(info.weight);
  return {
    bg_pid: pid, warehouse, warehouses: whs.map((w) => w.warehouse), title: str(info.product_name, 200), description: descText.slice(0, 5000),
    images: images.length ? images : skus.map((s) => s.image).filter(Boolean).slice(0, 6),
    weight_kg: weight > 0 ? (weight > 50 ? Math.round(weight) / 1000 : weight) : null, // documented in kilograms; grams if implausibly large
    source_link: `https://www.banggood.com/-p-${pid}.html`, skus
  };
}

/** Banggood's own Arabic translation of a product (Translate API, lang=ar): { title, description } or null. */
async function arabic(pid) {
  try {
    const j = await bg.call('GET', 'product/Translate', { product_id: pid, lang: 'ar' });
    let t = j.TranslatedText ?? j.translatedText ?? j.data;
    if (typeof t === 'string') { try { t = JSON.parse(t); } catch { /* plain text: the title */ } }
    const title = typeof t === 'string' ? t : t && (t.product_name || t.title || t.name);
    const description = t && typeof t === 'object' ? t.description || t.desc || '' : '';
    if (!title || !/[\u0600-\u06FF]/.test(String(title))) return null;
    return { title: str(stripHtml(title), 300), description: stripHtml(description).slice(0, 6000) };
  } catch { return null; }
}

const suggested = (cost, pct) => { const v = cost * (1 + (Number(pct ?? prefs().markup_pct) || 0) / 100); return Math.max(money(cost + 0.5), Math.ceil(v) - 0.01); };

async function preview(seller, ref) {
  const p = await fetchProduct(ref);
  const pct = seller?.default_markup_pct ?? prefs().markup_pct;
  return { ...p, skus: p.skus.map((s) => ({ ...s, suggested_price: suggested(s.cost_sale, pct) })) };
}

/** Import (or re-import) a Banggood product for a shop. Kinan's own shop goes live at once; sellers' products are reviewed. */
async function publish(seller, { ref, prices = {}, title, description, category, markup_pct } = {}) {
  if (seller.status !== 'active') throw httpError(403, 'Seller account is awaiting admin approval');
  const p = await fetchProduct(ref);
  const existing = db.listings.find((l) => l.seller_id === seller.id && l.source === 'banggood' && l.bg_pid === p.bg_pid);
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
    seller_id: seller.id, source: 'banggood', fulfillment: 'direct', bg_pid: p.bg_pid, bg_warehouse: p.warehouse, source_link: p.source_link,
    taobao_item_id: null, mp_id: null, item_type: 'BANGGOOD', title: newTitle, description: newDesc, custom_description: true,
    images: p.images, own_images: existing?.own_images || [], weight_kg: p.weight_kg, begin_amount: 1, currency: config.currency, skus,
    last_synced_at: now(), sync_error: null,
    ...(own ? { status: 'active', review: { state: 'approved', decided_at: now(), note: 'Kinan shop (Banggood)' } } : keep ? { status: existing.status } : { status: 'pending_review', review: { state: 'pending', submitted_at: now() } })
  };
  const saved = existing ? db.listings.update(existing.id, doc) : db.listings.insert(doc);
  // Arabic from Banggood itself, when the shop kept Banggood's title (no translation service needed)
  if (newTitle === p.title && !saved.ar_manual) {
    const ar = await arabic(p.bg_pid);
    if (ar) return db.listings.update(saved.id, { title_ar: ar.title, description_ar: newDesc === p.description ? ar.description : '', ar_auto: true, ar_by: 'banggood', ar_src: require('./translate').fingerprint(saved) });
  }
  return saved;
}

/** Follow Banggood's cost and stock. Missing options get stock 0; a product no longer sold becomes unavailable. */
async function resync(l) {
  if (!enabled() || l.source !== 'banggood' || !l.bg_pid) return l;
  try {
    const p = await fetchProduct(l.bg_pid, l.bg_warehouse);
    const by = new Map(p.skus.map((s) => [s.bg_poa.split(',').sort().join(','), s]));
    const skus = l.skus.map((s) => { const f = by.get(String(s.bg_poa || '').split(',').sort().join(',')); return f ? { ...s, cost_sale: f.cost_sale, stock: f.stock, opts: f.opts, image: f.image || s.image || null } : { ...s, stock: 0 }; });
    return db.listings.update(l.id, { skus, bg_warehouse: p.warehouse, last_synced_at: now(), sync_error: null, ...(l.status === 'unavailable' && skus.some((s) => s.stock > 0) ? { status: 'active' } : {}) });
  } catch (e) {
    if (e.status === 404) return db.listings.update(l.id, { status: l.status === 'active' ? 'unavailable' : l.status, sync_error: 'No longer sold on Banggood', last_synced_at: now() });
    return db.listings.update(l.id, { sync_error: e.message, last_synced_at: now() });
  }
}
async function resyncStale(max = 200) {
  if (!enabled()) return 0;
  const stale = db.listings.all((l) => l.source === 'banggood' && ['active', 'paused', 'unavailable', 'private'].includes(l.status) && now() - (l.last_synced_at || 0) > 22 * 3600e3)
    .sort((a, b) => (a.last_synced_at || 0) - (b.last_synced_at || 0)).slice(0, max);
  for (const l of stale) await resync(l);
  return stale.length;
}

// ---------------- shipping ----------------
// Banggood wants the country as its ISO 3166 English short name, lower case
const NAME_FIX = { SY: 'syrian arab republic', PS: 'palestine, state of', RU: 'russian federation', KR: 'korea, republic of', IR: 'iran, islamic republic of', VN: 'viet nam', MD: 'moldova, republic of', TZ: 'tanzania, united republic of', BO: 'bolivia, plurinational state of', VE: 'venezuela, bolivarian republic of', CZ: 'czechia', MK: 'north macedonia', TW: 'taiwan, province of china', LA: "lao people's democratic republic" };
function countryName(code) {
  const c = String(code || '').toUpperCase();
  return NAME_FIX[c] || String(require('../countries').countryName(c) || '').toLowerCase() || null;
}

const fcache = new Map();
/** Banggood shipping methods for one product option to a country (cached 6 hours). */
async function shipOptions(pid, warehouse, poa, qty, countryCode) {
  const country = countryName(countryCode);
  if (!country) throw httpError(400, 'Banggood does not recognise this country');
  const key = `${pid}|${warehouse}|${poa}|${qty}|${countryCode}`;
  const c = fcache.get(key); if (c && now() - c.at < 6 * 3600e3) return c.v;
  const j = await bg.call('GET', 'product/getShipments', { product_id: pid, warehouse, country, poa_id: poa || undefined, quantity: Math.min(99, qty) });
  const v = arr(j.shipment_list || j.shipmethod_list).map((o) => {
    const m = String(o.shipday || '').match(/(\d+)\D+(\d+)/) || String(o.shipday || '').match(/(\d+)/);
    return { code: str(o.shipmethod_code, 80), method: str(o.shipmethod_name, 120), fee: money(Number(o.shipfee) || 0), days: str(o.shipday, 60), min: m ? Number(m[1]) : null, max: m ? Number(m[2] || m[1]) : null };
  }).filter((o) => o.code);
  fcache.set(key, { at: now(), v });
  if (fcache.size > 3000) fcache.delete(fcache.keys().next().value);
  return v;
}
function choose(options) {
  if (!options?.length) return null;
  const p = prefs(); const byPrice = [...options].sort((a, b) => a.fee - b.fee);
  if (p.shipping === 'fastest') return [...options].sort((a, b) => (a.max ?? 99) - (b.max ?? 99) || a.fee - b.fee)[0];
  if (p.shipping === 'balanced') return byPrice.find((o) => (o.max ?? 99) <= p.max_days) || byPrice[0];
  return byPrice[0];
}

const FALLBACK = Number(process.env.BANGGOOD_FALLBACK_SHIPPING ?? 8);
const SHIP_TTL = 3 * 86400e3;
const cheapestSku = (l) => [...(l.skus || [])].sort((a, b) => a.price - b.price)[0] || null;

/** Product list price with shipping: cached per country, worked out in the background. */
const warm = new Set(); let warming = false;
function cachedFee(l, countryCode) {
  if (!countryCode || l.source !== 'banggood') return null;
  const k = l.bg_ship && l.bg_ship[countryCode];
  const sku = cheapestSku(l);
  if (k && now() - k.at < SHIP_TTL && k.poa === (sku?.bg_poa || '')) return k.fee;
  if (enabled() && warm.size < 1000) { warm.add(`${countryCode}|${l.id}`); if (!warming) warmUp(); }
  return null;
}
async function warmUp() {
  warming = true;
  try {
    while (warm.size) {
      const key = warm.values().next().value; warm.delete(key);
      const [cc, id] = key.split('|'); const l = db.listings.get(id); const sku = l && cheapestSku(l);
      if (!sku) continue;
      let fee = FALLBACK; let estimated = true;
      try { const o = choose(await shipOptions(l.bg_pid, l.bg_warehouse || 'CN', sku.bg_poa, 1, cc)); if (o) { fee = o.fee; estimated = false; } } catch { /* estimated */ }
      db.listings.update(id, (x) => ({ ...x, bg_ship: { ...(x.bg_ship || {}), [cc]: { fee, poa: sku.bg_poa || '', at: estimated ? now() - SHIP_TTL + 3600e3 : now(), estimated } } }));
    }
  } finally { warming = false; }
}

/** Shipping for the Banggood lines of a cart [{ listing_id, mp_sku_id, qty }] to a country (sum per product). */
async function quote(items, countryCode) {
  const lines = items.map((it) => {
    const l = db.listings.get(it.listing_id);
    if (!l || l.source !== 'banggood') return null;
    const s = l.skus.find((x) => x.mp_sku_id === it.mp_sku_id) || l.skus[0];
    return { l, s, qty: Math.max(1, Math.floor(Number(it.qty) || 1)) };
  }).filter(Boolean);
  if (!lines.length) return null;
  if (!countryCode) return { fee: 0, method: null, days: null, pending_country: true };
  let fee = 0; let estimated = false; const methods = []; let days = null;
  for (const x of lines) {
    try {
      const o = choose(await shipOptions(x.l.bg_pid, x.l.bg_warehouse || 'CN', x.s.bg_poa, x.qty, countryCode));
      if (o) { fee += o.fee; methods.push({ listing_id: x.l.id, mp_sku_id: x.s.mp_sku_id, code: o.code }); days = o.days; } else { fee += FALLBACK; estimated = true; }
    } catch { fee += FALLBACK; estimated = true; }
  }
  return { fee: money(fee), method: methods.length ? 'Banggood' : null, methods, days, estimated };
}

// ---------------- orders ----------------
const LABEL = { AE_TO_BUY: 'To order on Banggood', AE_PLACED: 'Created on Banggood — pay it in the Banggood account', AE_PAID: 'Paid — Banggood is preparing it', AE_SHIPPED: 'Shipped to the customer', AE_DELIVERED: 'Delivered', AE_CANCELLED: 'Cancelled on Banggood' };

function newDirectSub(o, sellerId, lines) {
  return {
    seller_id: sellerId, order_id: o.id, outer_purchase_id: `BG${o.id.slice(-8).toUpperCase()}${sellerId.slice(-4).toUpperCase()}`,
    line_nos: lines.map((l) => l.line_no), direct: true, source: 'banggood', status: 'AE_TO_BUY', purchase_ids: [], logistics: [], error: null,
    links: lines.map((l) => ({ title: l.title, props: l.props, qty: l.qty, link: l.source_link || '' }))
  };
}

/** Create the Banggood order with the CUSTOMER's address. Banggood's API cannot pay it: the owner pays it in the account. */
async function place(o, sub, lines) {
  if (!enabled()) { sub.error = 'Banggood is not connected — order it by hand on banggood.com'; return sub; }
  if (require('../payments/stripe').isTestPayment(o) && process.env.BANGGOOD_SANDBOX !== '1') { sub.error = 'Test payment — not ordered on Banggood'; return sub; }
  const a = o.shipping_address || {};
  const country = countryName(a.country_code);
  if (!country) { sub.error = 'Customer country is not recognised'; return sub; }
  const product_list = [];
  for (const l of lines) {
    const listing = db.listings.get(l.listing_id);
    const warehouse = l.bg_warehouse || listing?.bg_warehouse || 'CN';
    let code = (o.bg_shipping?.methods || []).find((m) => m.mp_sku_id === l.mp_sku_id)?.code;
    if (!code) { try { code = choose(await shipOptions(l.bg_pid, warehouse, l.bg_poa, l.qty, a.country_code))?.code; } catch (e) { sub.error = e.message; return sub; } }
    if (!code) { sub.error = `Banggood has no shipping method to ${a.country || a.country_code} for ${l.title}`; return sub; }
    product_list.push({ product_id: l.bg_pid, quantity: l.qty, warehouse, poa_id: l.bg_poa || '', shipmethod_code: code });
  }
  const saleId = `${o.id.slice(-10)}${sub.seller_id.slice(-4)}`.toUpperCase();
  try {
    const j = await bg.call('POST', 'order/importOrder', {
      sale_record_id: saleId, delivery_name: str(a.name, 60), delivery_country: country, delivery_state: str(a.state || a.city, 60), delivery_city: str(a.city, 60),
      delivery_street_address: str(a.line1, 200), delivery_street_address2: str(a.line2, 200), delivery_postcode: str(a.postal_code, 20), delivery_telephone: str(a.phone, 30),
      remark: `Kinan ${o.id.slice(-8).toUpperCase()} — no invoice or prices in the parcel please`, product_total: product_list.length, product_list
    });
    const failed = arr(j.failure_list);
    if (Number(j.success_total) === 0 || failed.length) {
      sub.error = `Banggood: ${failed.map((f) => f.error_desc).filter(Boolean).join('; ') || 'order not accepted'}`;
      if (!Number(j.success_total)) return sub;
    }
    Object.assign(sub, { sale_record_id: saleId, status: 'AE_PLACED', placed_at: now(), error: sub.error || null });
    require('../push').telegram(`🛒 Banggood order created for Kinan order ${o.id.slice(-8).toUpperCase()} — pay it in your Banggood account (Dropship orders): https://www.banggood.com/index.php?com=account`);
    try { await sync(sub); } catch { /* polled later */ }
  } catch (e) { sub.error = e.message.startsWith('Banggood') ? e.message : `Banggood: ${e.message}`; }
  return sub;
}

/** Banggood order statuses are free text: map them to the shared direct statuses. */
function mapStatus(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return null;
  if (/cancel|closed|refund/.test(t)) return 'AE_CANCELLED';
  if (/deliver|received|complete/.test(t)) return 'AE_DELIVERED';
  if (/ship|dispatch|transit/.test(t)) return 'AE_SHIPPED';
  if (/unpaid|payment pending|pending payment|wait.*pay|not paid|awaiting payment/.test(t)) return 'AE_PLACED';
  if (/paid|process|prepar|pack|confirm|pending/.test(t)) return 'AE_PAID';
  return null;
}

/** Status (getOrderInfo) and tracking events (getTrackInfo). */
async function sync(sub) {
  if (!enabled() || !sub.sale_record_id) return sub;
  const j = await bg.call('GET', 'order/getOrderInfo', { sale_record_id: sub.sale_record_id });
  const rec = arr(j.sale_record_id_list).find((x) => String(x.sale_record_id) === sub.sale_record_id) || arr(j.sale_record_id_list)[0];
  const ordersList = arr(rec?.order_list);
  if (ordersList.length) {
    sub.purchase_ids = ordersList.map((x) => String(x.order_id)).filter(Boolean);
    sub.bg_status = ordersList.map((x) => x.status).filter(Boolean).join(', ');
    sub.bg_amount = money(ordersList.reduce((a, x) => a + (Number(x.total_amount) || 0), 0)) || null;
    const rank = ['AE_TO_BUY', 'AE_PLACED', 'AE_PAID', 'AE_SHIPPED', 'AE_DELIVERED'];
    const sts = ordersList.map((x) => mapStatus(x.status)).filter(Boolean);
    if (sts.length && sts.every((x) => x === 'AE_CANCELLED')) sub.status = 'AE_CANCELLED';
    else { const lowest = sts.filter((x) => x !== 'AE_CANCELLED').sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0]; if (lowest && rank.indexOf(lowest) > rank.indexOf(sub.status)) sub.status = lowest; }
  }
  // Status history and the tracking number (getOrderHistory) for each Banggood order
  const rank = ['AE_TO_BUY', 'AE_PLACED', 'AE_PAID', 'AE_SHIPPED', 'AE_DELIVERED'];
  for (const id of sub.purchase_ids || []) {
    try {
      const h = await bg.call('GET', 'order/getOrderHistory', { sale_record_id: sub.sale_record_id, order_id: id });
      const hist = arr(h.order_history).map((x) => ({ status: str(x.status, 120), at: str(x.date_add, 40) }));
      if (hist.length) {
        sub.bg_history = hist.slice(-30);
        const latest = [...hist].sort((a, b) => String(a.at).localeCompare(String(b.at))).pop();
        const st = mapStatus(latest.status);
        if (st === 'AE_CANCELLED') sub.status = st;
        else if (st && rank.indexOf(st) > rank.indexOf(sub.status)) sub.status = st;
        sub.bg_status = latest.status;
      }
      const tn = str(h.track_number, 60);
      if (tn && !(sub.logistics || []).some((x) => x.tracking === tn)) sub.logistics = [...(sub.logistics || []).filter((x) => x.order_id !== id), { carrier: 'Banggood', tracking: tn, url: `https://t.17track.net/en#nums=${encodeURIComponent(tn)}`, order_id: id }];
      if (tn && ['AE_PLACED', 'AE_PAID'].includes(sub.status)) sub.status = 'AE_SHIPPED';
    } catch { /* not available yet */ }
  }
  // Tracking events for each Banggood order
  const events = [];
  for (const id of sub.purchase_ids || []) {
    try { const t = await bg.call('GET', 'order/getTrackInfo', { order_id: id }); for (const e of arr(t.track_info)) events.push({ order_id: id, event: str(e.event, 300), time: str(e.time, 40) }); } catch { /* none yet */ }
  }
  if (events.length) {
    sub.track_events = events.slice(-40);
    const tn = events.map((e) => e.event.match(/\b([A-Z]{2}\d{9}[A-Z]{2}|[A-Z0-9]{10,30})\b/)).find(Boolean);
    if (tn && !(sub.logistics || []).length) sub.logistics = [{ carrier: 'Banggood', tracking: tn[1], url: `https://t.17track.net/en#nums=${tn[1]}` }];
    if (sub.status === 'AE_PAID' || sub.status === 'AE_PLACED') sub.status = 'AE_SHIPPED';
    if (events.some((e) => /deliver/i.test(e.event))) sub.status = 'AE_DELIVERED';
  }
  if (['AE_PAID', 'AE_SHIPPED', 'AE_DELIVERED'].includes(sub.status)) sub.error = null;
  sub.synced_at = now();
  return sub;
}

/** The admin paid the Banggood order in the Banggood account. */
function markPaid(sub) {
  if (sub.status !== 'AE_PLACED') throw httpError(409, 'This Banggood order is not waiting for payment');
  sub.status = 'AE_PAID'; sub.paid_at = now(); sub.error = null;
  return sub;
}

/** Cancel: Banggood's API has none — only an order not created yet can be cancelled here. */
async function cancel(sub) {
  if (sub.status === 'AE_TO_BUY') { sub.status = 'AE_CANCELLED'; return sub; }
  throw httpError(409, 'Cancel the order in your Banggood account first, then refund the customer');
}

module.exports = { arabic, enabled, status, prefs, savePrefs, parseRef, fetchProduct, preview, publish, resync, resyncStale, cachedFee, quote, countryName, choose, shipOptions, LABEL, newDirectSub, place, sync, markPaid, cancel, mapStatus };
