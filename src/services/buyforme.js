// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * "Buy for me": a customer pastes any Taobao / Tmall / 1688 / AliExpress / JD link (or the share text the
 * Taobao app copies), sees an instant estimate, and sends it to Kinan. Kinan confirms the final price; the
 * customer accepts and pays like any other order.
 *
 * Accepted quotes become a private product of the built-in "Kinan" shop (only that customer can buy it), so
 * checkout, warehouse, shipping, refunds and reports all work unchanged. Kinan's own shop has no seller
 * earnings: the whole price minus the buying cost is Kinan's.
 */
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');

const money = (n) => Math.round(Number(n) * 100) / 100;
const FEE_PCT = Number(process.env.BFM_FEE_PCT ?? 10);         // service fee on the item price
const MIN_FEE = Number(process.env.BFM_MIN_FEE ?? 2);          // minimum fee per request (sale currency)
const CHINA_SHIP_CNY = Number(process.env.BFM_CHINA_SHIP_CNY ?? 10); // seller → our warehouse, per request
const SYSTEM_SELLER = 'sel_kinan';

const PLATFORMS = [
  ['taobao', 'Taobao', /(^|\.)taobao\.com$|(^|\.)tb\.cn$/i, (u) => u.searchParams.get('id')],
  ['tmall', 'Tmall', /(^|\.)tmall\.(com|hk)$/i, (u) => u.searchParams.get('id')],
  ['1688', '1688', /(^|\.)1688\.com$/i, (u) => (u.pathname.match(/offer\/(\d+)/) || [])[1] || u.searchParams.get('offerId')],
  ['aliexpress', 'AliExpress', /(^|\.)aliexpress\.(com|us|ru)$/i, (u) => (u.pathname.match(/item\/(?:[^/]*?)(\d{6,})\.html/) || [])[1]],
  ['jd', 'JD.com', /(^|\.)jd\.com$/i, (u) => (u.pathname.match(/(\d{5,})\.html/) || [])[1]]
];

/** Finds the link in pasted text (the Taobao app copies "【淘宝】… https://e.tb.cn/… 「title」") and names the store. */
function parse(text) {
  const raw = String(text || '').trim().slice(0, 2000);
  const m = raw.match(/https?:\/\/[^\s「」【】"'<>，。]+/i);
  if (!m) {
    if (/^\d{6,15}$/.test(raw)) return { platform: 'taobao', platform_name: 'Taobao', item_id: raw, url: `https://item.taobao.com/item.htm?id=${raw}`, title: '' };
    throw httpError(400, 'Paste a product link from Taobao, Tmall, 1688, AliExpress or JD');
  }
  let u; try { u = new URL(m[0]); } catch { throw httpError(400, 'That link is not valid'); }
  const p = PLATFORMS.find(([, , re]) => re.test(u.hostname));
  if (!p) throw httpError(400, 'We buy from Taobao, Tmall, 1688, AliExpress and JD — paste a link from one of them');
  // Title the Taobao app puts between 「 」 when sharing
  const title = ((raw.match(/「([^」]{2,200})」/) || [])[1] || '').trim();
  return { platform: p[0], platform_name: p[1], item_id: p[3](u) || null, url: u.toString().slice(0, 500), title };
}

/** Instant estimate for one request, in the sale currency. */
function estimate({ price_cny, qty = 1, weight_kg, country_code } = {}) {
  const cny = Number(price_cny);
  if (!(cny > 0 && cny < 1e6)) throw httpError(400, 'Enter the price shown on the product page (in ¥)');
  const q = Math.max(1, Math.min(999, Math.floor(Number(qty) || 1)));
  const items = money((cny * q) / config.cnyRate);
  const china = money(CHINA_SHIP_CNY / config.cnyRate);
  const fee = money(Math.max(MIN_FEE, items * FEE_PCT / 100));
  const shipping = require('./shipping');
  const kg = Number(weight_kg) > 0 ? Number(weight_kg) * q : shipping.settings().default_item_kg * q;
  const intl = shipping.priceFor(kg, country_code);
  const days = shipping.settings().days[intl.zone];
  return {
    currency: config.currency, qty: q, items, china_shipping: china, service_fee: fee, fee_pct: FEE_PCT,
    international_shipping: intl.fee, total: money(items + china + fee + intl.fee), weight_kg: Math.round(kg * 100) / 100, days,
    per_item: money((items + china + fee) / q)
  };
}

/** Kinan's own shop that holds accepted buy-for-me items. Created once. */
function systemSeller() {
  let s = db.sellers.get(SYSTEM_SELLER);
  if (!s) s = db.sellers.insert({ id: SYSTEM_SELLER, user_id: null, shop_name: 'Kinan', status: 'active', system: true, commission_pct: 0, auto_pay: false, taobao: null });
  return s;
}

/** Customer accepts Kinan's price: a private product only they can buy. Returns what the cart needs. */
function accept(buyer, requestId) {
  const r = db.requests.get(requestId);
  if (!r || r.buyer_id !== buyer.id) throw httpError(404, 'Request not found');
  if (r.status !== 'quoted' || !(r.quote > 0)) throw httpError(409, 'Kinan has not confirmed a price for this request yet');
  if (r.listing_id) {
    const l = db.listings.get(r.listing_id);
    if (l && ['private', 'active'].includes(l.status)) return { listing_id: l.id, mp_sku_id: l.skus[0].mp_sku_id, qty: r.qty, price: l.skus[0].price, title: l.title, image: (l.images || [])[0] || null };
  }
  const seller = systemSeller();
  const title = String(r.title || r.note || `${r.platform_name || 'Taobao'} item`).trim().slice(0, 200);
  const l = db.listings.insert({
    seller_id: seller.id, source: 'manual', fulfillment: 'warehouse', source_link: r.link || '',
    item_type: 'BUY_FOR_ME', taobao_item_id: null, mp_id: null, title, description: r.note || '', custom_description: true,
    images: r.image ? [r.image] : [], own_images: [], weight_kg: r.weight_kg || null, category: 'other',
    begin_amount: 1, currency: config.currency, last_synced_at: Date.now(), status: 'private', private_for: buyer.id, request_id: r.id,
    skus: [{ mp_sku_id: `BFM${Date.now().toString(36)}`, props: String(r.variant || '').slice(0, 80), price: r.quote, stock: r.qty, cost_cny: r.price_cny || null }]
  });
  db.requests.update(r.id, { listing_id: l.id, status: 'accepted', accepted_at: Date.now() });
  return { listing_id: l.id, mp_sku_id: l.skus[0].mp_sku_id, qty: r.qty, price: r.quote, title, image: r.image || null };
}

module.exports = { parse, estimate, accept, systemSeller, SYSTEM_SELLER, PLATFORMS };
