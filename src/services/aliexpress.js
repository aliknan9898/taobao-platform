// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * AliExpress as a second product source. AliExpress items ship DIRECT to the customer
 * (no China warehouse), so they become "direct" sub-orders next to the Taobao/warehouse ones.
 *
 * Two modes, switched automatically:
 *  - API mode: ALIEXPRESS_APP_KEY/SECRET are set AND the admin connected Kinan's AliExpress account.
 *    Products import from a link; orders are placed with aliexpress.ds.order.create and synced.
 *  - Manual mode (default): sellers type products in; Kinan's team orders them on AliExpress by hand
 *    and enters the AliExpress order number and tracking in the admin dashboard.
 */
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const ae = require('../aliexpress/client');
const { httpError } = require('../auth');

const money = (n) => Math.round(Number(n) * 100) / 100;
const now = () => Date.now();
const SETTINGS_ID = 'set_aliexpress';
const STATE_TTL = 10 * 60e3;

// ---------------- Platform connection (one AliExpress account: Kinan's) ----------------

function account() { return db.settings.get(SETTINGS_ID) || null; }

function status() {
  const a = account();
  const connected = Boolean(a?.access_token);
  return {
    api_configured: ae.enabled(), connected, mode: ae.enabled() && connected ? 'api' : 'manual',
    account: a?.account || null, expires_at: a?.expires_at || null,
    needs_reauth_soon: connected && a.expires_at && a.expires_at - now() < 7 * 86400e3,
    delivery_days: config.aliexpress.deliveryDays
  };
}
const apiReady = () => status().mode === 'api';

function authorizeUrl() {
  if (!ae.enabled()) throw httpError(503, 'Add ALIEXPRESS_APP_KEY and ALIEXPRESS_APP_SECRET on the server first');
  const state = crypto.randomBytes(20).toString('base64url');
  db.oauthStates.insert({ id: `ae_${state}`, kind: 'aliexpress', expires_at: now() + STATE_TTL });
  const q = new URLSearchParams({ response_type: 'code', force_auth: 'true', redirect_uri: config.aliexpress.redirectUri, client_id: config.aliexpress.appKey, state });
  return `${config.aliexpress.apiUrl}${ae.API.AUTHORIZE}?${q}`;
}

function saveToken(t) {
  const doc = {
    access_token: t.access_token, refresh_token: t.refresh_token || account()?.refresh_token || null,
    expires_at: t.expires_in ? now() + Number(t.expires_in) * 1000 : (t.expire_time ? Number(t.expire_time) : null),
    refresh_expires_at: t.refresh_expires_in ? now() + Number(t.refresh_expires_in) * 1000 : (t.refresh_token_valid_time ? Number(t.refresh_token_valid_time) : null),
    account: t.account || t.user_nick || t.seller_id || null, connected_at: account()?.connected_at || now()
  };
  if (!doc.access_token) throw httpError(502, 'AliExpress did not return an access token');
  return account() ? db.settings.update(SETTINGS_ID, doc) : db.settings.insert({ id: SETTINGS_ID, ...doc });
}

async function handleCallback(code, state) {
  const st = state && db.oauthStates.get(`ae_${state}`);
  if (state) db.oauthStates.remove(`ae_${state}`);
  if (!st || st.kind !== 'aliexpress' || st.expires_at < now()) throw httpError(400, 'Link expired — start the connection again from the admin dashboard');
  if (!code) throw httpError(400, 'AliExpress did not authorize the connection');
  return saveToken(await ae.system(ae.API.TOKEN_CREATE, { code }));
}

async function token() {
  const a = account();
  if (!a?.access_token) throw httpError(503, 'AliExpress account is not connected');
  if (a.expires_at && a.expires_at - now() < 3600e3 && a.refresh_token) {
    try { return saveToken(await ae.system(ae.API.TOKEN_REFRESH, { refresh_token: a.refresh_token })).access_token; } catch { /* use the old one while it lasts */ }
  }
  return a.access_token;
}

function disconnect() { if (account()) db.settings.remove(SETTINGS_ID); return status(); }

// ---------------- Links & products ----------------

/** Product ID from an AliExpress link (any domain/language) or a bare ID. */
function productIdFromLink(input) {
  const s = String(input || '').trim();
  const m = s.match(/aliexpress\.[a-z.]+\/(?:item|i)\/(?:[^/?#]*?)(\d{9,20})\.html/i) || s.match(/[?&](?:productId|product_id|itemId)=(\d{9,20})/i) || s.match(/^(\d{9,20})$/);
  return m ? m[1] : null;
}
const isAliExpressLink = (s) => /aliexpress\.|a\.aliexpress|s\.click\.aliexpress/i.test(String(s || '')) || /^\d{12,20}$/.test(String(s || '').trim());

const asArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
/** AliExpress nests lists as { x_d_t_o: [...] } — take the first array inside. */
const list = (v) => { if (Array.isArray(v)) return v; if (v && typeof v === 'object') { const a = Object.values(v).find(Array.isArray); return a || []; } return []; };

/** Normalise aliexpress.ds.product.get (VERIFY field names against a live response). */
function normalizeProduct(r, productId) {
  const base = r.ae_item_base_info_dto || r.item_base_info || {};
  const media = r.ae_multimedia_info_dto || r.multimedia_info || {};
  const images = String(media.image_urls || '').split(';').map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x)).map((x) => x.replace(/^http:/, 'https:')).slice(0, 10);
  const skus = list(r.ae_item_sku_info_dtos || r.sku_info_list).map((s, i) => {
    const props = list(s.ae_sku_property_dtos || s.sku_property_list).map((p) => p.property_value_definition_name || p.sku_property_value || p.sku_property_name).filter(Boolean).join(' / ');
    return {
      mp_sku_id: `AE${s.sku_id || s.id || i}`, ae_sku_id: String(s.sku_id || s.id || ''), ae_sku_attr: String(s.sku_attr || s.id || ''),
      props, stock: Math.max(0, Number(s.sku_available_stock ?? s.ipm_sku_stock ?? s.sku_stock ?? 0)),
      cost_sale: money(s.offer_sale_price || s.sku_price || s.offer_bulk_sale_price || 0), cost_cny: null
    };
  }).filter((s) => s.cost_sale > 0);
  if (!skus.length) throw httpError(422, 'This AliExpress product has no buyable options right now');
  return { ae_product_id: String(base.product_id || productId), title: String(base.subject || `AliExpress ${productId}`).slice(0, 200), description: String(base.detail || base.mobile_detail || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000), images, skus };
}

async function fetchProduct(productId, shipTo = 'SA') {
  const r = await ae.call(ae.API.PRODUCT_GET, { product_id: productId, ship_to_country: shipTo, target_currency: String(config.currency).toUpperCase(), target_language: 'EN' }, await token());
  return normalizeProduct(r, productId);
}

const suggested = (cost, markupPct) => money(Math.max(0.5, cost * (1 + Number(markupPct ?? 30) / 100)));

async function preview(seller, link) {
  if (!apiReady()) throw httpError(503, 'AliExpress import is not switched on yet — add the product manually');
  const id = productIdFromLink(link);
  if (!id) throw httpError(400, 'Paste a full AliExpress product link (…/item/1005….html)');
  const p = await fetchProduct(id);
  return { ...p, source_link: String(link).trim().slice(0, 500), skus: p.skus.map((s) => ({ ...s, suggested_price: suggested(s.cost_sale, seller.default_markup_pct) })) };
}

/** Import (or re-import) an AliExpress product via the API with the seller's prices. */
async function publish(seller, { link, prices = {}, title, description, category } = {}) {
  if (seller.status !== 'active') throw httpError(403, 'Seller account is awaiting admin approval');
  const p = await preview(seller, link);
  const existing = db.listings.find((l) => l.seller_id === seller.id && l.source === 'aliexpress' && l.ae_product_id === p.ae_product_id);
  const skus = p.skus.map((s) => {
    const price = prices[s.mp_sku_id] !== undefined ? money(prices[s.mp_sku_id]) : s.suggested_price;
    if (!(price > 0)) throw httpError(400, `Invalid price for ${s.props || 'an option'}`);
    const { suggested_price, ...rest } = s; return { ...rest, price };
  });
  const newTitle = String(title || p.title).trim().slice(0, 200);
  const newDesc = String(description ?? p.description).replace(/<[^>]*>/g, '').slice(0, 5000);
  const keep = existing && existing.review?.state === 'approved' && existing.title === newTitle && (existing.description || '') === newDesc;
  const doc = {
    category: require('./shipping').cleanCategory(category ?? existing?.category),
    seller_id: seller.id, source: 'aliexpress', fulfillment: 'direct', ae_product_id: p.ae_product_id, source_link: p.source_link,
    taobao_item_id: null, mp_id: null, item_type: 'ALIEXPRESS', title: newTitle, description: newDesc, custom_description: true,
    images: p.images, own_images: existing?.own_images || [], begin_amount: 1, currency: config.currency, skus, last_synced_at: now(), sync_error: null,
    ...(keep ? { status: existing.status } : { status: 'pending_review', review: { state: 'pending', submitted_at: now() } })
  };
  return existing ? db.listings.update(existing.id, doc) : db.listings.insert(doc);
}

/** Refresh cost & stock (API mode only; manual AliExpress products are left as typed). */
async function resync(l) {
  if (!apiReady() || !l.ae_product_id) return l;
  try {
    const p = await fetchProduct(l.ae_product_id);
    const by = new Map(p.skus.map((s) => [s.ae_sku_id, s]));
    const skus = l.skus.map((s) => { const f = by.get(s.ae_sku_id); return f ? { ...s, cost_sale: f.cost_sale, stock: f.stock } : { ...s, stock: s.ae_sku_id ? 0 : s.stock }; });
    return db.listings.update(l.id, { skus, last_synced_at: now(), sync_error: null });
  } catch (e) { return db.listings.update(l.id, { sync_error: e.message, last_synced_at: now() }); }
}

// ---------------- Direct orders ----------------

const DS_STATUS = { PLACE_ORDER_SUCCESS: 'AE_PLACED', WAIT_SELLER_SEND_GOODS: 'AE_PAID', SELLER_PART_SEND_GOODS: 'AE_SHIPPED', WAIT_BUYER_ACCEPT_GOODS: 'AE_SHIPPED', FUND_PROCESSING: 'AE_SHIPPED', FINISH: 'AE_DELIVERED', IN_CANCEL: 'AE_CANCELLED' };
const LABEL = {
  AE_TO_BUY: 'To order on AliExpress', AE_PLACED: 'Ordered — pay it on AliExpress', AE_PAID: 'Paid — AliExpress preparing',
  AE_SHIPPED: 'Shipped to the customer', AE_DELIVERED: 'Delivered', AE_CANCELLED: 'Cancelled on AliExpress'
};

function newDirectSub(o, sellerId, lines) {
  return {
    seller_id: sellerId, order_id: o.id, outer_purchase_id: `AE${o.id.slice(-8).toUpperCase()}${sellerId.slice(-4).toUpperCase()}`,
    line_nos: lines.map((l) => l.line_no), direct: true, source: 'aliexpress', status: 'AE_TO_BUY', purchase_ids: [], logistics: [], error: null,
    links: lines.map((l) => ({ title: l.title, props: l.props, qty: l.qty, link: l.source_link || '' }))
  };
}

/** Place the AliExpress order with the CUSTOMER's address (API mode). Leaves the sub at AE_TO_BUY with an error if it can't. */
async function place(o, sub, lines) {
  if (!apiReady()) return sub;
  const a = o.shipping_address;
  if (!a.country_code) { sub.error = 'Customer country is not recognised — order this one by hand'; return sub; }
  if (lines.some((l) => !l.ae_product_id)) { sub.error = 'Product was added manually — order it by hand'; return sub; }
  const req = {
    logistics_address: {
      full_name: a.name, contact_person: a.name, mobile_no: a.phone, phone_country: '', address: a.line1, address2: a.line2 || '',
      city: a.city, province: a.state || a.city, zip: a.postal_code || '', country: a.country_code
    },
    product_items: lines.map((l) => ({
      product_id: Number(l.ae_product_id), product_count: l.qty, sku_attr: l.ae_sku_attr || '',
      ...(config.aliexpress.shippingService ? { logistics_service_name: config.aliexpress.shippingService } : {}),
      order_memo: `Kinan ${o.id.slice(-8).toUpperCase()} — no invoice or prices in the parcel please`
    }))
  };
  try {
    const r = await ae.call(ae.API.ORDER_CREATE, { [ae.API.ORDER_CREATE_PARAM]: req, ds_extend_request: { payment: { pay_currency: String(config.currency).toUpperCase() } } }, await token());
    const ids = asArr(r?.order_list?.number || r?.order_list || r?.order_ids || r?.orderIds).flat().map(String).filter((x) => /^\d+$/.test(x));
    if (!ids.length && r?.is_success === false) throw new Error(r.error_msg || r.error_code || 'Order was not created');
    sub.purchase_ids = ids; sub.status = 'AE_PLACED'; sub.error = null; sub.placed_at = now();
  } catch (e) { sub.error = `AliExpress: ${e.message}`; }
  return sub;
}

/** Pull status + tracking for a placed order (API mode). */
async function sync(sub) {
  if (!apiReady() || !sub.purchase_ids?.length) return sub;
  const statuses = []; const logistics = [];
  for (const id of sub.purchase_ids) {
    const r = await ae.call(ae.API.ORDER_GET, { [ae.API.ORDER_GET_PARAM]: { order_id: id } }, await token());
    if (r?.order_status) statuses.push(DS_STATUS[r.order_status] || sub.status);
    for (const x of list(r?.logistics_info_list)) if (x.logistics_no) logistics.push({ carrier: x.logistics_service || '', tracking: String(x.logistics_no) });
  }
  const rank = ['AE_CANCELLED', 'AE_TO_BUY', 'AE_PLACED', 'AE_PAID', 'AE_SHIPPED', 'AE_DELIVERED'];
  if (statuses.length) sub.status = statuses.sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0]; // slowest part decides
  if (logistics.length) sub.logistics = logistics;
  sub.synced_at = now();
  return sub;
}

/** Admin updates a direct sub by hand: AliExpress order number, tracking, delivered. */
function manualUpdate(sub, { ae_order_no, tracking, carrier, delivered } = {}) {
  if (ae_order_no !== undefined && String(ae_order_no).trim()) sub.purchase_ids = String(ae_order_no).split(/[\s,]+/).filter(Boolean).slice(0, 10);
  const tr = String(tracking || '').trim().slice(0, 60);
  if (tr) sub.logistics = [...(sub.logistics || []).filter((x) => x.tracking !== tr), { carrier: String(carrier || '').slice(0, 40), tracking: tr }];
  if (delivered) sub.status = 'AE_DELIVERED';
  else if ((sub.logistics || []).length) sub.status = 'AE_SHIPPED';
  else if ((sub.purchase_ids || []).length) sub.status = 'AE_PAID';
  sub.error = null;
  return sub;
}

module.exports = {
  status, apiReady, authorizeUrl, handleCallback, disconnect, productIdFromLink, isAliExpressLink, normalizeProduct,
  preview, publish, resync, newDirectSub, place, sync, manualUpdate, LABEL, DS_STATUS
};
