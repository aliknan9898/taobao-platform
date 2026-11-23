// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const db = require('../db');
const { config } = require('../config');
const { call } = require('../taobao/client');
const { tokenFor } = require('../taobao/sellerAuth');
const { itemIdFromInput } = require('../taobao/link');
const API = require('../taobao/apis');
const { httpError } = require('../auth');
const aliexpress = require('./aliexpress');

const LINK_ERRORS = {
  NO_URL: 'No link or product ID found.', BAD_URL: 'Invalid link.',
  NOT_TAOBAO: 'The link is not from Taobao or Tmall.', NO_ITEM_ID: 'No product ID found in the link.',
  GOOFISH: 'Goofish items are not supported.', TAOTE: 'Taote items are not supported.',
  SHORT_LINK_UNRESOLVED: 'Could not resolve the short link. Use the full product link.'
};
const API_ERRORS = [
  [/未查到淘宝商品/, 'The product was deleted or delisted.'],
  [/不能通过分销方式售卖/, 'This Taobao merchant does not allow distribution sales.'],
  [/淘特/, 'Taote items are not supported.'],
  [/不是供销平台签约商品/, 'The product is not part of the Distribution Platform catalog.']
];

const pick = (o, ...k) => { for (const x of k) if (o && o[x] !== undefined && o[x] !== null) return o[x]; return undefined; };
const arr = (v) => Array.isArray(v) ? v : typeof v === 'string' ? (() => { try { const j = JSON.parse(v); return Array.isArray(j) ? j : v.split(','); } catch { return v.split(','); } })().filter(Boolean) : [];
const money = (n) => Math.round(Number(n) * 100) / 100;
/** Distribution Platform prices are integers in fen (18800 = ¥188.00); decimal strings are already yuan. */
const toYuan = (v) => (/^\d+$/.test(String(v).trim()) ? money(Number(v) / 100) : money(v));
/** [{prop_name:"color", value_name:"blue"}, …] → "color: blue / size: 1" */
function propsLabel(p) {
  if (!p) return '';
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return p; } }
  if (Array.isArray(p)) return p.map((x) => (x && typeof x === 'object' ? [x.prop_name || x.name, x.value_name || x.value].filter(Boolean).join(': ') : String(x))).join(' / ');
  if (typeof p === 'object') return Object.entries(p).map(([k, v]) => `${k}: ${v}`).join(' / ');
  return String(p);
}

/** WITHOUT_MATERIAL = full Taobao pool: no pictures/description by compliance rules. */
function normalizeProduct(r, taobaoItemId) {
  const d = r.data || r.result || r;
  const itemType = pick(d, 'item_type', 'itemType') || 'HAVE_MATERIAL';
  const withMaterial = itemType !== 'WITHOUT_MATERIAL';
  return {
    taobao_item_id: String(taobaoItemId),
    mp_id: String(pick(d, 'mp_id', 'mpId', 'item_id', 'itemId') ?? ''),
    title: pick(d, 'title', 'item_title', 'name') || '',
    item_type: itemType,
    with_material: withMaterial,
    images: withMaterial ? arr(pick(d, 'pic_urls', 'picUrls', 'images')) : [],
    description: withMaterial ? (pick(d, 'description', 'desc') || '') : '',
    begin_amount: withMaterial ? Number(pick(d, 'begin_amount') ?? 1) : 1,
    source_shop: pick(d, 'shop_name', 'seller_nick'),
    skus: arr(pick(d, 'sku_list', 'skuList', 'skus')).map((s) => ({
      // /product/get returns "mp_skuId" (see the HTTP request sample on open.taobao.global)
      mp_sku_id: String(pick(s, 'mp_skuId', 'mp_sku_id', 'mpSkuId', 'sku_id', 'skuId') ?? ''),
      props: propsLabel(pick(s, 'properties', 'props', 'properties_name')),
      cost_cny: toYuan(pick(s, 'promotion_price', 'price', 'sale_price') ?? pick(d, 'promotion_price', 'price') ?? 0),
      image: withMaterial ? pick(s, 'pic_url') : undefined, // never keep Taobao photos for WITHOUT_MATERIAL
      stock: Number(pick(s, 'quantity', 'stock', 'inventory') ?? 0) // >200 shown as 200
    })).filter((s) => s.mp_sku_id)
  };
}

async function fetchProduct(sellerId, taobaoItemId) {
  const token = await tokenFor(sellerId);
  try {
    const r = await call(API.PRODUCT_GET, { [API.PRODUCT_GET_PARAM]: taobaoItemId }, { accessToken: token });
    return normalizeProduct(r, taobaoItemId);
  } catch (e) {
    const msg = `${e.message} ${JSON.stringify(e.raw || {})}`;
    for (const [re, ar] of API_ERRORS) if (re.test(msg)) throw httpError(422, ar);
    throw e;
  }
}

function defaultPrice(costCny, markupPct) {
  return money((costCny / config.cnyRate) * (1 + markupPct / 100));
}

/** Seller pastes a link → preview (not saved). */
async function preview(seller, link) {
  const p = await itemIdFromInput(link);
  if (!p.ok) throw httpError(400, LINK_ERRORS[p.reason] || 'Unsupported link');
  const prod = await fetchProduct(seller.id, p.itemId);
  const markup = Number(seller.default_markup_pct ?? 30);
  prod.skus = prod.skus.map((s) => ({ ...s, suggested_price: defaultPrice(s.cost_cny, markup) }));
  return prod;
}

/**
 * Seller publishes a listing with their own sale prices.
 * own_images: optional HTTPS URLs of photos the SELLER owns (required to show images for WITHOUT_MATERIAL items).
 */
async function publish(seller, { link, prices = {}, title, description, own_images = [], images_rights_confirmed = false, category, keywords }) {
  if (seller.status !== 'active') throw httpError(403, 'Seller account is awaiting admin approval');
  const p = await itemIdFromInput(link);
  if (!p.ok) throw httpError(400, LINK_ERRORS[p.reason] || 'Unsupported link');
  const prod = await fetchProduct(seller.id, p.itemId);

  const ownImgs = arr(own_images).map(String).filter((u) => /^https:\/\//.test(u)).slice(0, 10);
  if (ownImgs.length && !images_rights_confirmed) throw httpError(400, 'Confirm that you own the rights to the uploaded photos');

  const skus = prod.skus.map((s) => {
    const price = prices[s.mp_sku_id] !== undefined ? money(prices[s.mp_sku_id]) : defaultPrice(s.cost_cny, Number(seller.default_markup_pct ?? 30));
    if (!(price > 0)) throw httpError(400, `Invalid price for variant ${s.props || s.mp_sku_id}`);
    return { ...s, price };
  });

  const existing = db.listings.find((l) => l.seller_id === seller.id && l.taobao_item_id === prod.taobao_item_id);
  const newTitle = String(title || prod.title || `#${prod.taobao_item_id}`).slice(0, 200);
  // Admin approval: a NEW listing, or a change to what buyers see (title / photos), goes back to review.
  // Price changes on an approved listing do not need re-approval.
  // Seller's own description (plain text) replaces Taobao's; never keep Taobao text for WITHOUT_MATERIAL items
  const newDesc = description !== undefined && description !== null && String(description).trim()
    ? String(description).replace(/<[^>]*>/g, '').slice(0, 5000) : (existing?.custom_description ? existing.description : prod.description);
  const customDesc = Boolean(description !== undefined && description !== null && String(description).trim()) || Boolean(existing?.custom_description && (description === undefined || description === null));
  const keepApproval = existing && existing.review?.state === 'approved'
    && existing.title === newTitle && JSON.stringify(existing.own_images || []) === JSON.stringify(ownImgs)
    && (existing.description || '') === (newDesc || '');
  const doc = {
    category: require('./shipping').cleanCategory(category ?? existing?.category),
    seller_id: seller.id,
    taobao_item_id: prod.taobao_item_id, mp_id: prod.mp_id, item_type: prod.item_type,
    title: newTitle,
    // Never copy Taobao material for WITHOUT_MATERIAL items; only seller-owned images then
    images: prod.with_material ? prod.images : [],
    own_images: ownImgs,
    description: newDesc,
    custom_description: customDesc,
    keywords: keywords !== undefined ? require('./ai').cleanKeywords(keywords) : existing?.keywords || [],
    begin_amount: prod.begin_amount,
    currency: config.currency,
    skus, last_synced_at: Date.now(),
    ...(keepApproval
      ? { status: existing.status === 'unavailable' ? 'active' : existing.status }
      : { status: 'pending_review', review: { state: 'pending', submitted_at: Date.now() } })
  };
  return existing ? db.listings.update(existing.id, doc) : db.listings.insert(doc);
}

/**
 * Manual listing (PDF Phase 1): the seller types the product in by hand — no Taobao API needed.
 * Kinan's team buys it on Taobao by hand from `source_link` when an order comes in.
 * images: data URLs (JPEG/PNG/WebP) the seller uploads, resized in the browser.
 */
const IMG_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
function publishManual(seller, b = {}, listingId = null) {
  if (seller.status !== 'active') throw httpError(403, 'Seller account is awaiting admin approval');
  const existing = listingId ? db.listings.get(listingId) : null;
  if (listingId && (!existing || existing.seller_id !== seller.id || !['manual', 'aliexpress'].includes(existing.source))) throw httpError(404, 'Product not found');
  // Where the item comes from decides how it ships: Taobao → our China warehouse, AliExpress → straight to the customer
  const fromAE = b.source === 'aliexpress' || (b.source === undefined && existing?.source === 'aliexpress') || (b.source === undefined && aliexpress.isAliExpressLink(b.source_link));
  const title = String(b.title || '').trim().slice(0, 200);
  if (title.length < 3) throw httpError(400, 'Enter a product title');
  const description = String(b.description || '').replace(/<[^>]*>/g, '').trim().slice(0, 5000);
  const sourceLink = String(b.source_link || '').trim().slice(0, 500);
  const images = (Array.isArray(b.images) ? b.images : []).map(String);
  if (!images.length) throw httpError(400, 'Add at least one photo');
  if (images.length > 6) throw httpError(400, 'Up to 6 photos');
  for (const im of images) {
    if ((existing?.images || []).includes(im)) continue; // imported AliExpress photo kept as is
    if (!IMG_RE.test(im) && !/^https:\/\/[^\s"'<>]{8,500}$/.test(im)) throw httpError(400, 'Photos must be JPEG, PNG or WebP');
    if (im.length > 400 * 1024) throw httpError(400, 'A photo is too large — use a smaller image');
  }
  const variants = arr(b.variants).slice(0, 30);
  if (!variants.length) throw httpError(400, 'Add at least one option with a price');
  const old = new Map((existing?.skus || []).map((s) => [s.props, s]));
  const skus = variants.map((v, i) => {
    const props = String(v.name || '').trim().slice(0, 80);
    const price = money(v.price);
    const stock = Math.max(0, Math.min(99999, Math.floor(Number(v.stock ?? 99))));
    const cost = v.cost_cny === '' || v.cost_cny === null || v.cost_cny === undefined ? null : money(v.cost_cny);
    if (!(price > 0)) throw httpError(400, `Enter a price for ${props || `option ${i + 1}`}`);
    if (cost !== null && !(cost >= 0)) throw httpError(400, 'Invalid Taobao cost');
    if (variants.length > 1 && !props) throw httpError(400, 'Give every option a name (e.g. size or colour)');
    const prev = old.get(props) || {};
    return fromAE
      ? { ...prev, mp_sku_id: prev.mp_sku_id || `M${Date.now().toString(36)}${i}`, props, price, stock, cost_cny: null, cost_sale: cost === null ? (prev.cost_sale ?? null) : cost }
      : { mp_sku_id: prev.mp_sku_id || `M${Date.now().toString(36)}${i}`, props, price, stock, cost_cny: cost };
  });
  const weight = b.weight_kg === '' || b.weight_kg === undefined || b.weight_kg === null ? null : Number(b.weight_kg);
  if (weight !== null && !(weight > 0 && weight < 100)) throw httpError(400, 'Invalid weight');
  const keepApproval = existing && existing.review?.state === 'approved' && existing.title === title
    && (existing.description || '') === description && (b.title_ar === undefined || String(b.title_ar || '').trim() === (existing.ar_manual ? existing.title_ar : '')) && (b.description_ar === undefined || String(b.description_ar || '').trim() === (existing.ar_manual ? existing.description_ar || '' : '')) && JSON.stringify([...(existing.images || []), ...(existing.own_images || [])].sort()) === JSON.stringify([...images].sort());
  const doc = {
    category: require('./shipping').cleanCategory(b.category ?? existing?.category),
    seller_id: seller.id, source: fromAE ? 'aliexpress' : 'manual', fulfillment: fromAE ? 'direct' : 'warehouse', source_link: sourceLink,
    ae_product_id: fromAE ? (aliexpress.productIdFromLink(sourceLink) || existing?.ae_product_id || null) : null,
    taobao_item_id: null, mp_id: null, item_type: fromAE ? 'ALIEXPRESS' : 'MANUAL',
    title, description, custom_description: true, keywords: b.keywords !== undefined ? require('./ai').cleanKeywords(b.keywords) : existing?.keywords || [], images: existing?.source === 'aliexpress' && fromAE ? (existing.images || []).filter((u) => images.includes(u)) : [], own_images: images.filter((u) => !(existing?.images || []).includes(u)), weight_kg: weight,
    begin_amount: 1, currency: config.currency, skus, last_synced_at: Date.now(),
    ...(keepApproval ? { status: existing.status } : { status: 'pending_review', review: { state: 'pending', submitted_at: Date.now() } }),
    ...require('./translate').manualPatch(b, existing)
  };
  return existing ? db.listings.update(existing.id, doc) : db.listings.insert(doc);
}

/** Re-sync cost & stock from Taobao (procurement mode gets no product messages → poll). */
/**
 * After a price sync: find options now selling below cost. Kinan-bought items (AliExpress) are paused
 * so Kinan never loses money on them; Taobao-API items (paid by the seller) are flagged for the seller.
 */
function checkMargins(l) {
  if (!l) return l;
  const landed = require('./landed');
  // Kinan's own supplier products follow the supplier's price: always the 20%-net price (see landed.js)
  if (l.fulfillment === 'direct' && l.seller_id === require('./buyforme').systemSeller().id && !l.from_kinan) { landed.repriceKinan({ ids: [l.id] }); l = db.listings.get(l.id); }
  // what one unit really costs: supplier price + AliExpress shipping + card fees for supplier-shipped products
  const costOf = (s) => (l.fulfillment === 'direct' && Number(s.cost_sale) > 0 ? (landed.unitCost(l, s) + 0.35) / 0.96 : s.cost_sale !== undefined && s.cost_sale !== null ? s.cost_sale : s.cost_cny ? s.cost_cny / config.cnyRate : null);
  const losing = l.skus.filter((s) => {
    const cost = costOf(s);
    return cost !== null && s.stock > 0 && s.price < cost;
  }).map((s) => ({ mp_sku_id: s.mp_sku_id, props: s.props, price: s.price, cost: Math.round(costOf(s) * 100) / 100 }));
  const before = l.price_alert?.skus?.length || 0;
  if (!losing.length) return before ? db.listings.update(l.id, { price_alert: null }) : l;
  const pause = ['aliexpress', 'cj', 'banggood'].includes(l.source) && l.status === 'active';
  const out = db.listings.update(l.id, { price_alert: { at: Date.now(), skus: losing, paused: pause || Boolean(l.price_alert?.paused) }, ...(pause ? { status: 'paused' } : {}) });
  if (!before) require('../notify').priceAlert(out, losing, pause);
  return out;
}

async function resync(listingId) {
  const l = db.listings.get(listingId);
  if (!l) throw httpError(404, 'Product not found');
  if (l.source === 'manual') return l; // typed in by hand: nothing to fetch from Taobao
  if (l.source === 'aliexpress') return checkMargins(await aliexpress.resync(l));
  if (l.source === 'cj') return checkMargins(await require('./cj').resync(l));
  if (l.source === 'banggood') return checkMargins(await require('./banggood').resync(l));
  try {
    const prod = await fetchProduct(l.seller_id, l.taobao_item_id);
    const bySku = new Map(prod.skus.map((s) => [s.mp_sku_id, s]));
    const skus = l.skus.map((s) => {
      const fresh = bySku.get(s.mp_sku_id);
      return fresh ? { ...s, cost_cny: fresh.cost_cny, stock: fresh.stock } : { ...s, stock: 0 };
    });
    return checkMargins(db.listings.update(l.id, { skus, last_synced_at: Date.now(), sync_error: null, status: l.status === 'unavailable' && l.review?.state === 'approved' ? 'active' : l.status }));
  } catch (e) {
    const unavailable = e.status === 422;
    return db.listings.update(l.id, { sync_error: e.message, status: unavailable ? 'unavailable' : l.status, last_synced_at: Date.now() });
  }
}

async function resyncStale(maxAgeMs = 6 * 3600e3) {
  for (const l of db.listings.all((x) => !['manual', 'cj', 'banggood'].includes(x.source) && ['active', 'pending_review'].includes(x.status) && Date.now() - Math.max(x.last_synced_at || 0, x.sync_tried_at || 0) > maxAgeMs)) {
    await resync(l.id);
  }
}

// Uploaded photos are stored as data URLs; buyers get short cacheable links instead (see /img routes).
const crypto = require('crypto');
const ver = (str) => crypto.createHash('sha1').update(str).digest('hex').slice(0, 8);
function photoUrl(l, i, u) { return /^data:/.test(u) ? `/img/l/${l.id}/${i}?v=${ver(u)}` : u; }
function logoUrl(seller) { return seller?.logo ? (/^data:/.test(seller.logo) ? `/img/s/${seller.id}?v=${ver(seller.logo)}` : seller.logo) : null; }
/** The product page gallery: the product photos, then each option's own photo (so choosing a colour can show it). */
function galleryOf(l) { const g = visibleImages(l); for (const s of l.skus || []) if (s.image && !g.includes(s.image) && g.length < 24) g.push(s.image); return g; }
function visibleImages(l) { const own = l.own_images || []; return [...own.map((u, i) => photoUrl(l, i, u)), ...(l.images || [])]; }
/** Decode a stored photo for the /img routes. */
function imageData(kind, id, n) {
  let u = null;
  // Not for unreviewed or rejected uploads
  if (kind === 'l') { const l = db.listings.get(id); if (l && ['active', 'paused', 'unavailable', 'private'].includes(l.status)) u = (l.own_images || [])[Number(n) || 0]; }
  if (kind === 's') u = db.sellers.get(id)?.logo;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(u || '');
  return m ? { type: m[1], body: Buffer.from(m[2], 'base64') } : null;
}

/** Buyer catalog: only active listings of active sellers. Cost is never exposed to buyers. */
function browse({ q = '', seller_id, category, collection, group, sort = 'new', min_price, max_price, limit = 40, offset = 0, country, view } = {}) {
  const activeSellers = new Map(db.sellers.peek((s) => s.status === 'active').map((s) => [s.id, s]));
  const needle = String(q).toLowerCase().trim();
  const lo = Number(min_price) || 0; const hi = Number(max_price) || Infinity;
  const ccx = /^[A-Z]{2}$/.test(String(country || '')) ? country : null;
  const cjs = ccx ? require('./cj') : null;
  // Products CJ cannot deliver to the shopper's country are left out (they could not be ordered there anyway)
  // read without copying: copying every product (descriptions, options) on each request was most of the time spent here.
  // Nothing below modifies a listing; the views built for the page are new objects.
  const listings = db.listings.peek((l) => l.status === 'active' && activeSellers.has(l.seller_id) && !(cjs && cjs.noDelivery(l, ccx))
    && (!seller_id || l.seller_id === seller_id)
    && (!category || (l.category || 'other') === category)
    && (!collection || (l.collections || []).includes(collection)) && (!group || l.collection_group === group || l.sourcing?.group === group)
    && (!needle || l.title.toLowerCase().includes(needle) || (l.title_ar || '').includes(needle) || (l.keywords || []).some((k) => k.includes(needle) || needle.includes(k)) || (activeSellers.get(l.seller_id).shop_name || '').toLowerCase().includes(needle)));
  const start = Number(offset) || 0;
  const count = limit === 100000 ? listings.length : Math.min(Number(limit) || 40, 100);
  const newest = (l) => l.review?.decided_at || l.created_at;
  // Most storefront requests sort by recency without a price filter. Sort lightweight
  // listing records first, then construct expensive buyer views for the requested page only.
  // Price sorts and filters compute prices first and build full views only for the page.
  let page; let total;
  if (!min_price && !max_price && !['price_asc', 'price_desc'].includes(sort)) {
    listings.sort((a, b) => newest(b) - newest(a));
    total = listings.length;
    page = listings.slice(start, start + count).map((l) => toBuyerView(l, activeSellers.get(l.seller_id)));
  } else {
    const { visibleSkus } = require('./shipsFrom');
    const { priceOf } = require('./deals');
    const items = listings.map((listing) => ({
      listing,
      listed_at: newest(listing),
      min_price: Math.min(...visibleSkus(listing).map((sku) => priceOf(listing, sku)))
    }))
      .filter((p) => p.min_price >= lo && p.min_price <= hi);
    const order = { price_asc: (a, b) => a.min_price - b.min_price, price_desc: (a, b) => b.min_price - a.min_price, new: (a, b) => b.listed_at - a.listed_at }[sort] || ((a, b) => b.listed_at - a.listed_at);
    items.sort(order);
    total = items.length;
    page = items.slice(start, start + (limit === 100000 ? items.length : count))
      .map(({ listing, min_price }) => ({
        ...toBuyerView(listing, activeSellers.get(listing.seller_id)),
        min_price
      }));
  }
  // With the customer's country: the price of one piece delivered to them (shipping included)
  const cc = /^[A-Z]{2}$/.test(String(country || '')) ? country : null;
  if (cc) {
    const shipping = require('./shipping'); const cj = require('./cj');
    for (const p of page) {
      const l = db.listings.get(p.id); let fee = null;
      try {
        if (l.source === 'cj') fee = cj.cachedFee(l, cc);
        else if (l.source === 'banggood') fee = require('./banggood').cachedFee(l, cc);
        else { const cheapest = [...l.skus].sort((a, b) => a.price - b.price)[0]; fee = shipping.quote([{ listing_id: l.id, mp_sku_id: cheapest?.mp_sku_id, qty: 1 }], cc).fee; }
      } catch { fee = null; }
      if (fee !== null && fee !== undefined) { p.ship_fee = Math.round(fee * 100) / 100; p.delivered_price = Math.round((p.min_price + fee) * 100) / 100; }
      else if (['cj', 'banggood'].includes(l.source)) p.ship_pending = true;
    }
  }
  return { total, items: view === 'card' ? page.map(cardView) : page };
}

/** Only what a product card in a grid shows (view=card): a fraction of the full product, so lists load fast. */
const CARD_FIELDS = ['id', 'title', 'title_ar', 'currency', 'shop', 'listed_at', 'category', 'min_price', 'delivered_price', 'ship_fee', 'ship_pending', 'ship_extra', 'ships_from', 'rating', 'reviews', 'deal', 'was_min_price', 'no_delivery'];
function cardView(p) {
  const out = {}; for (const k of CARD_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  out.images = (p.images || []).slice(0, 1);
  return out;
}

/**
 * Options grouped like big marketplaces: "Color" → [Red, Blue], "Size" → [S, M, L].
 * Works for every source: CJ (stored names), Taobao ("Color: Red / Size: M"), AliExpress and manual ("Red / M").
 * Returns null when the options cannot be split the same way for every variant (then the shop shows a simple list).
 */
function optionGroups(skus) {
  const parts = skus.map((s) => {
    if (Array.isArray(s.opts) && s.opts.length) return s.opts.map((o) => ({ name: String(o.name || '').trim(), value: String(o.value || '').trim() }));
    let raw = s.props;
    if (raw && typeof raw === 'string' && /^[[{]/.test(raw.trim())) { try { raw = propsLabel(raw); } catch { /* keep */ } }
    const txt = String(raw || '').trim();
    if (!txt) return [];
    return txt.split(/\s*[\/;|]\s*/).filter(Boolean).map((x) => { const m = x.match(/^([^:：]{1,30})[:：]\s*(.+)$/); return m ? { name: m[1].trim(), value: m[2].trim() } : { name: '', value: x.trim() }; });
  });
  const n = parts[0]?.length || 0;
  if (skus.length < 2 || !n || n > 4 || parts.some((p) => p.length !== n || p.some((x) => !x.value))) return null;
  const groups = [];
  for (let i = 0; i < n; i++) {
    const name = parts.find((p) => p[i].name)?.[i].name || (n === 1 ? 'Option' : ['Color', 'Size', 'Style', 'Type'][i]);
    const values = [];
    for (const [k, p] of parts.entries()) {
      if (!values.some((v) => v.value === p[i].value)) values.push({ value: p[i].value, ...(skus[k].image ? { image: skus[k].image } : {}) });
    }
    groups.push({ name, values });
  }
  // Only one group keeps pictures: the one whose values each have their own photo (usually the colour, wherever it is)
  const picsOf = (i, v) => new Set(skus.filter((x, k) => parts[k][i].value === v && x.image).map((x) => x.image));
  const picGroup = groups.findIndex((g, i) => g.values.every((v) => picsOf(i, v.value).size <= 1) && new Set(g.values.map((v) => [...picsOf(i, v.value)][0]).filter(Boolean)).size >= 2);
  const keep = picGroup >= 0 ? picGroup : (new Set(groups[0].values.map((v) => v.image)).size >= 2 ? 0 : -1);
  groups.forEach((g, i) => { if (i !== keep) g.values.forEach((v) => delete v.image); });
  if (keep >= 0) for (const v of groups[keep].values) v.image = skus.find((x, k) => parts[k][keep].value === v.value && x.image)?.image || v.image;
  return { groups, picks: parts.map((p) => p.map((x) => x.value)) };
}

/** Customers see Kinan's copy of supplier photos once it exists (services/media.js); unchanged while that is off. */
function toBuyerView(l, seller) {
  const v = toBuyerViewRaw(l, seller);
  const media = require('./media');
  if (!media.enabled()) return v;
  const h = media.hosted;
  return {
    ...v, images: (v.images || []).map(h), skus: (v.skus || []).map((s) => (s.image ? { ...s, image: h(s.image) } : s)),
    option_groups: v.option_groups ? v.option_groups.map((g) => ({ ...g, values: g.values.map((x) => (x.image ? { ...x, image: h(x.image) } : x)) })) : v.option_groups
  };
}
function toBuyerViewRaw(l, seller) {
  return {
    id: l.id, title: l.title, images: galleryOf(l), description: l.description, title_ar: l.title_ar || '', description_ar: l.description_ar || '',
    currency: l.currency, shop: seller ? { id: seller.id, name: seller.shop_name, logo: logoUrl(seller) } : null,
    listed_at: l.review?.decided_at || l.created_at, fulfillment: l.fulfillment || 'warehouse', ...(['cj', 'banggood'].includes(l.source) ? { ship_extra: true } : {}), category: l.category || 'other', ...((l.collections || []).length ? { collections: l.collections } : {}), ...(l.cj_from && l.cj_from !== 'CN' ? { ships_from: l.cj_from } : {}),
    // the real delivery time found when the product was checked (to the UK and to the EU): [fastest, slowest] days
    ...(() => { const so = l.sourcing || {}; if (so.delivery_by_country) return { ship_days_exact: true, ship_days: Object.fromEntries(Object.entries(so.delivery_by_country).map(([country, quote]) => [country, [quote.min || null, quote.days]])) }; const d = {}; if (so.gb_days) d.GB = [so.gb_min || null, so.gb_days]; if (so.eu_days) d.EU = [so.eu_min || null, so.eu_days]; return Object.keys(d).length ? { ship_days: d } : {}; })(),
    min_price: Math.min(...require('./shipsFrom').visibleSkus(l).map((s) => require('./deals').priceOf(l, s))), ...require('./growth').ratingFor(l.id),
    ...(() => { const no = l.source === 'cj' ? require('./cj').noDeliveryList(l) : []; return no.length ? { no_delivery: no } : {}; })(),
    ...(() => { const d = require('./deals').dealFor(l); return d ? { deal: d, was_min_price: Math.min(...l.skus.map((s) => s.price)) } : {}; })(),
    // AliExpress "Ships From" is hidden: one option per colour/size, Kinan picks the warehouse for each address
    ...(() => { const vis = require('./shipsFrom').visibleSkus(l); const og = optionGroups(vis); return {
      option_groups: og ? og.groups : null,
      skus: vis.map((s, i) => ({ mp_sku_id: require('./publicIds').skuPub(l.id, s.mp_sku_id), props: og ? og.picks[i].join(' / ') : s.props, ...(og ? { pick: og.picks[i] } : {}), ...(s.image ? { image: s.image } : {}), price: require('./deals').priceOf(l, s), ...(require('./deals').dealFor(l) ? { was: s.price } : {}), in_stock: s.stock > 0, stock: Math.min(s.stock, 200) }))
    }; })()
  };
}

function buyerListing(id) {
  const l = db.listings.get(id);
  const s = l && db.sellers.get(l.seller_id);
  if (!l || !['active', 'private'].includes(l.status) || !s || s.status !== 'active') throw httpError(404, 'Product not available');
  return { ...toBuyerView(l, s), return_policy: s.return_policy || null, safety: require('./gpsr').forListing(l) };
}

/** Admin moderation. Only approved listings can ever become visible to buyers. */
function approve(listingId, adminUser) {
  const l = db.listings.get(listingId);
  if (!l) throw httpError(404, 'Product not found');
  if (l.status !== 'pending_review' && l.review?.state !== 'rejected') throw httpError(409, 'Product is not awaiting review');
  const out = db.listings.update(l.id, { status: 'active', review: { ...l.review, state: 'approved', reason: null, decided_at: Date.now(), decided_by: adminUser.id } });
  require('./translate').translateListing(out.id).catch((err) => console.warn('[translate]', err.message));
  require('../notify').listingDecision(out, true);
  return out;
}

function reject(listingId, reason, adminUser) {
  const l = db.listings.get(listingId);
  if (!l) throw httpError(404, 'Product not found');
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw httpError(400, 'Enter a rejection reason so the seller knows what to fix');
  const out = db.listings.update(l.id, { status: 'rejected', review: { ...l.review, state: 'rejected', reason: why, decided_at: Date.now(), decided_by: adminUser.id } });
  require('../notify').listingDecision(out, false, why);
  return out;
}

/** Seller may pause/resume only listings the admin already approved. */
function sellerSetStatus(l, status) {
  if (!['active', 'paused'].includes(status)) throw httpError(400, 'Invalid status');
  if (l.review?.state !== 'approved') {
    throw httpError(409, l.review?.state === 'rejected' ? `Product was rejected: ${l.review.reason}` : 'Product is awaiting admin approval');
  }
  if (l.status === 'unavailable') throw httpError(409, 'The product is currently unavailable on Taobao');
  return status;
}

/** Live products in the order of `ids` (recently viewed). */
function many(ids) {
  const want = [...new Set(String(ids || '').split(',').map((x) => x.trim()).filter((x) => /^[\w-]{3,40}$/.test(x)))].slice(0, 30);
  if (!want.length) return { items: [] };
  const all = new Map(browse({ limit: 100000 }).items.filter((p) => want.includes(p.id)).map((p) => [p.id, p]));
  return { items: want.map((id) => all.get(id)).filter(Boolean) };
}

/**
 * When a product would arrive, like big marketplaces show it ("Arrives Thu 20 – Mon 24 Nov"): working days to dispatch,
 * then the delivery time to the shopper's country. Dates are worked out in the shop's time zone (Malta).
 */
const DISPATCH_DAYS = () => Math.max(0, Number(process.env.DISPATCH_DAYS ?? 1));
/** Delivery days measured when a supplier-direct product was checked (to the UK, and to the EU for EU countries). */
const EU_MEMBERS = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
function measuredDays(l, cc) {
  const so = l.sourcing || {};
  const exact = so.delivery_by_country?.[cc];
  const [lo, hi, basis] = so.delivery_by_country ? [exact?.min, exact?.days, cc] : cc === 'GB' ? [so.gb_min, so.gb_days, 'GB'] : EU_MEMBERS.has(cc) ? [so.eu_min, so.eu_days, 'EU'] : [];
  const max = Number(hi); if (!(max > 0 && max < 99)) return null;
  const min = Number(lo) > 0 && Number(lo) <= max ? Number(lo) : max; // no measured fastest time: show the measured time only
  return { min, max, known: true, basis };
}

function delivery(id, country, now = Date.now()) {
  const l = db.listings.get(id);
  if (!l) throw httpError(404, 'Product not found');
  const cc = /^[A-Z]{2}$/.test(String(country || '')) ? country : null;
  if (!cc) return { country: null };
  let d;
  if (l.source === 'cj') {
    const cj = require('./cj');
    if (cj.noDelivery(l, cc)) return { country: cc, none: true };
    d = cj.deliveryDays(l, cc);
  } else if (l.fulfillment === 'direct' && measuredDays(l, cc)) d = measuredDays(l, cc);
  else if (l.fulfillment === 'direct') d = { min: 10, max: 20, known: false };
  else d = { min: 8, max: 18, known: false }; // via Kinan's warehouse in China
  // Skip Sundays for dispatch (warehouses do not ship then)
  let start = now; let left = DISPATCH_DAYS();
  while (left > 0) { start += 86400e3; if (new Date(start).getUTCDay() !== 0) left--; }
  const from = start + d.min * 86400e3; const to = start + d.max * 86400e3;
  const xmas = (() => { const y = new Date(now).getUTCFullYear(); const eve = Date.UTC(y, 11, 24, 23, 0); return now < eve ? eve : null; })();
  return {
    country: cc, min_days: d.min, max_days: d.max, from, to, known: Boolean(d.known), ...(d.basis ? { basis: d.basis } : {}),
    ...(xmas ? { christmas: { before: to <= xmas, order_by: xmas - (d.max + DISPATCH_DAYS() + 1) * 86400e3 } } : {})
  };
}
/** Products like this one: same section/collection first, then shared title words and keywords, same category. */
function similar(id, limit = 12) {
  const l = db.listings.get(id);
  if (!l) return { items: [] };
  const words = (t) => new Set(String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'set', 'pcs', 'new'].includes(w)));
  const mine = words(`${l.title} ${(l.keywords || []).join(' ')}`);
  // Score the raw records of the visible catalogue (same rule as browse(): active product of an active shop), then build
  // buyer views only for the few shown. Building a view for every product made each product page wait ~150 ms.
  const activeSellers = new Map(db.sellers.all((s) => s.status === 'active').map((s) => [s.id, s]));
  const newest = (x) => x.review?.decided_at || x.created_at;
  const out = [];
  for (const o of db.listings.all((x) => x.status === 'active' && activeSellers.has(x.seller_id) && x.id !== id)) {
    let sc = 0;
    if (l.collection_group && o.collection_group === l.collection_group && (o.collections || []).some((c) => (l.collections || []).includes(c))) sc += 4;
    else if ((o.collections || []).some((c) => (l.collections || []).includes(c))) sc += 1;
    if ((o.category || 'other') === (l.category || 'other')) sc += 1;
    for (const w of words(`${o.title} ${(o.keywords || []).join(' ')}`)) if (mine.has(w)) sc += 2;
    if (sc >= 3) out.push({ o, sc, at: newest(o) });
  }
  return { items: out.sort((a, b) => b.sc - a.sc || b.at - a.at).slice(0, limit).map((x) => toBuyerView(x.o, activeSellers.get(x.o.seller_id))) };
}

module.exports = { delivery, many, similar,
  optionGroups, checkMargins, photoUrl, imageData, logoUrl, publishManual, toYuan, propsLabel, approve, reject, sellerSetStatus, preview, publish, resync, resyncStale, browse, buyerListing, normalizeProduct, defaultPrice };
