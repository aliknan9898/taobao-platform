'use strict';
const db = require('../db');
const { config } = require('../config');
const { call } = require('../taobao/client');
const { tokenFor } = require('../taobao/sellerAuth');
const { itemIdFromInput } = require('../taobao/link');
const API = require('../taobao/apis');
const { httpError } = require('../auth');

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
      mp_sku_id: String(pick(s, 'mp_sku_id', 'mpSkuId', 'sku_id', 'skuId') ?? ''),
      props: (() => { const p = pick(s, 'properties', 'props', 'properties_name') || ''; return typeof p === 'object' ? JSON.stringify(p) : String(p); })(),
      cost_cny: money(pick(s, 'price', 'sale_price') ?? 0),
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
async function publish(seller, { link, prices = {}, title, description, own_images = [], images_rights_confirmed = false }) {
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
    seller_id: seller.id,
    taobao_item_id: prod.taobao_item_id, mp_id: prod.mp_id, item_type: prod.item_type,
    title: newTitle,
    // Never copy Taobao material for WITHOUT_MATERIAL items; only seller-owned images then
    images: prod.with_material ? prod.images : [],
    own_images: ownImgs,
    description: newDesc,
    custom_description: customDesc,
    begin_amount: prod.begin_amount,
    currency: config.currency,
    skus, last_synced_at: Date.now(),
    ...(keepApproval
      ? { status: existing.status === 'unavailable' ? 'active' : existing.status }
      : { status: 'pending_review', review: { state: 'pending', submitted_at: Date.now() } })
  };
  return existing ? db.listings.update(existing.id, doc) : db.listings.insert(doc);
}

/** Re-sync cost & stock from Taobao (procurement mode gets no product messages → poll). */
async function resync(listingId) {
  const l = db.listings.get(listingId);
  if (!l) throw httpError(404, 'Product not found');
  try {
    const prod = await fetchProduct(l.seller_id, l.taobao_item_id);
    const bySku = new Map(prod.skus.map((s) => [s.mp_sku_id, s]));
    const skus = l.skus.map((s) => {
      const fresh = bySku.get(s.mp_sku_id);
      return fresh ? { ...s, cost_cny: fresh.cost_cny, stock: fresh.stock } : { ...s, stock: 0 };
    });
    return db.listings.update(l.id, { skus, last_synced_at: Date.now(), sync_error: null, status: l.status === 'unavailable' && l.review?.state === 'approved' ? 'active' : l.status });
  } catch (e) {
    const unavailable = e.status === 422;
    return db.listings.update(l.id, { sync_error: e.message, status: unavailable ? 'unavailable' : l.status, last_synced_at: Date.now() });
  }
}

async function resyncStale(maxAgeMs = 6 * 3600e3) {
  for (const l of db.listings.all((x) => ['active', 'pending_review'].includes(x.status) && Date.now() - (x.last_synced_at || 0) > maxAgeMs)) {
    await resync(l.id);
  }
}

function visibleImages(l) { return [...(l.own_images || []), ...(l.images || [])]; }

/** Buyer catalog: only active listings of active sellers. Cost is never exposed to buyers. */
function browse({ q = '', seller_id, limit = 40, offset = 0 } = {}) {
  const activeSellers = new Map(db.sellers.all((s) => s.status === 'active').map((s) => [s.id, s]));
  const needle = String(q).toLowerCase();
  const items = db.listings.all((l) => l.status === 'active' && activeSellers.has(l.seller_id)
    && (!seller_id || l.seller_id === seller_id)
    && (!needle || l.title.toLowerCase().includes(needle)));
  return {
    total: items.length,
    items: items.slice(Number(offset), Number(offset) + Math.min(Number(limit), 100)).map((l) => toBuyerView(l, activeSellers.get(l.seller_id)))
  };
}

function toBuyerView(l, seller) {
  return {
    id: l.id, title: l.title, images: visibleImages(l), description: l.description,
    currency: l.currency, shop: seller ? { id: seller.id, name: seller.shop_name } : null,
    min_price: Math.min(...l.skus.map((s) => s.price)),
    skus: l.skus.map((s) => ({ mp_sku_id: s.mp_sku_id, props: s.props, price: s.price, in_stock: s.stock > 0, stock: Math.min(s.stock, 200) }))
  };
}

function buyerListing(id) {
  const l = db.listings.get(id);
  const s = l && db.sellers.get(l.seller_id);
  if (!l || l.status !== 'active' || !s || s.status !== 'active') throw httpError(404, 'Product not available');
  return toBuyerView(l, s);
}

/** Admin moderation. Only approved listings can ever become visible to buyers. */
function approve(listingId, adminUser) {
  const l = db.listings.get(listingId);
  if (!l) throw httpError(404, 'Product not found');
  if (l.status !== 'pending_review' && l.review?.state !== 'rejected') throw httpError(409, 'Product is not awaiting review');
  return db.listings.update(l.id, { status: 'active', review: { ...l.review, state: 'approved', reason: null, decided_at: Date.now(), decided_by: adminUser.id } });
}

function reject(listingId, reason, adminUser) {
  const l = db.listings.get(listingId);
  if (!l) throw httpError(404, 'Product not found');
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw httpError(400, 'Enter a rejection reason so the seller knows what to fix');
  return db.listings.update(l.id, { status: 'rejected', review: { ...l.review, state: 'rejected', reason: why, decided_at: Date.now(), decided_by: adminUser.id } });
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

module.exports = { approve, reject, sellerSetStatus, preview, publish, resync, resyncStale, browse, buyerListing, normalizeProduct, defaultPrice };
