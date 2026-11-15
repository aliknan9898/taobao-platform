'use strict';
/**
 * The Kinan catalogue for sellers: the products Kinan sources (CJ / AliExpress, already reviewed, photos cleaned,
 * delivery ≤ 15 days), offered to sellers at the "Kinan price" without saying where they come from. A seller adds
 * one to their shop with their own selling price; Kinan places and pays the supplier order as usual, and the seller
 * earns: their price − the Kinan price − commission.
 *
 * Kinan price = supplier cost × (1 + KINAN_WHOLESALE_PCT, 10% by default). Delivery is added at checkout as for any
 * Kinan product.
 */
const db = require('../db');
const { httpError } = require('../auth');

const PCT = () => Math.min(100, Math.max(0, Number(process.env.KINAN_WHOLESALE_PCT ?? 10)));
const money = (v) => Math.round(Number(v) * 100) / 100;
const list = (v) => (Array.isArray(v) ? v : []);
const kinanId = () => require('./buyforme').systemSeller().id;
/** Kinan price of one option. */
const kinanPrice = (s) => money(Number(s.cost_sale || 0) * (1 + PCT() / 100));

const offered = () => db.listings.all((l) => l.seller_id === kinanId() && l.status === 'active' && ['cj', 'aliexpress'].includes(l.source) && list(l.skus).some((s) => s.stock > 0 && s.cost_sale > 0));

/** One page of the catalogue, without supplier details. */
function browse(seller, { q = '', dept = '', page = 1 } = {}) {
  const mine = new Set(db.listings.all((l) => l.seller_id === seller.id && l.from_kinan).map((l) => l.from_kinan));
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  let items = offered().filter((l) => (!dept || list(l.collections).includes(dept)) && words.every((w) => `${l.title} ${list(l.keywords).join(' ')}`.toLowerCase().includes(w)));
  items.sort((a, b) => (Number(b.sourcing?.quality) || 0) - (Number(a.sourcing?.quality) || 0) || (b.created_at || 0) - (a.created_at || 0));
  const per = 24; const total = items.length; const pg = Math.max(1, Math.floor(Number(page) || 1));
  items = items.slice((pg - 1) * per, pg * per);
  const D = require('./sourcing').DEPARTMENTS;
  return {
    pct: PCT(), total, page: pg, pages: Math.max(1, Math.ceil(total / per)),
    departments: Object.entries(D).map(([id, d]) => ({ id, name: d.name || id })),
    items: items.map((l) => {
      const skus = list(l.skus).filter((s) => s.stock > 0 && s.cost_sale > 0);
      const kp = Math.min(...skus.map(kinanPrice));
      return {
        id: l.id, title: l.title, image: list(l.images)[0] || null, photos: list(l.images).length, department: list(l.collections)[0] || null,
        kinan_price: kp, suggested_price: money(Math.max(kp * 1.4, kp + 2)), retail_price: Math.min(...skus.map((s) => s.price)), options: skus.length,
        delivery_days: l.sourcing?.gb_days || l.sourcing?.eu_days || null, added: mine.has(l.id)
      };
    })
  };
}

/** Full details of one catalogue product (options with Kinan price), before adding. */
function details(seller, id) {
  const l = db.listings.get(id);
  if (!l || !offered().some((x) => x.id === id)) throw httpError(404, 'This product is not in the Kinan catalogue any more');
  return {
    id: l.id, title: l.title, description: l.description, images: list(l.images), pct: PCT(), delivery_days: l.sourcing?.gb_days || l.sourcing?.eu_days || null,
    options: list(l.skus).filter((s) => s.stock > 0 && s.cost_sale > 0).map((s) => ({ mp_sku_id: s.mp_sku_id, props: s.props || 'Standard', stock: s.stock, kinan_price: kinanPrice(s), suggested_price: money(Math.max(kinanPrice(s) * 1.4, kinanPrice(s) + 2)) }))
  };
}

/** Add a catalogue product to the seller's shop with their prices ({ prices: { mp_sku_id: price } } or { markup_pct }). */
function add(seller, id, b = {}) {
  if (seller.status !== 'active') throw httpError(403, 'Your shop must be approved before adding products');
  const src = db.listings.get(id);
  if (!src || !offered().some((x) => x.id === id)) throw httpError(404, 'This product is not in the Kinan catalogue any more');
  if (db.listings.find((l) => l.seller_id === seller.id && l.from_kinan === id)) throw httpError(409, 'This product is already in your shop');
  const pct = b.markup_pct !== undefined && b.markup_pct !== '' ? Math.min(500, Math.max(0, Number(b.markup_pct))) : null;
  const skus = list(src.skus).filter((s) => s.cost_sale > 0).map((s) => {
    const kp = kinanPrice(s);
    const asked = b.prices && b.prices[s.mp_sku_id] !== undefined && b.prices[s.mp_sku_id] !== '' ? money(b.prices[s.mp_sku_id]) : pct !== null ? money(kp * (1 + pct / 100)) : money(Math.max(kp * 1.4, kp + 2));
    if (!(asked > kp)) throw httpError(400, `The price of “${s.props || 'this product'}” must be higher than the Kinan price (${kp})`);
    return { ...s, price: asked };
  });
  const copy = { ...src };
  for (const k of ['id', 'created_at', 'updated_at', 'review', 'ebay', 'ebay_comp', 'auto_added_at', 'cj_auto', 'ae_auto', 'images_hidden', 'paused_reason', 'paused_by']) delete copy[k];
  const l = db.listings.insert({
    ...copy, seller_id: seller.id, skus, status: 'active', from_kinan: src.id, kinan_pct: PCT(),
    review: { state: 'approved', decided_at: Date.now(), decided_by: 'kinan_catalog' }, created_at: Date.now()
  });
  return sellerSafe(l);
}

/** A listing as the seller sees it: no supplier names, links or supplier costs for Kinan-catalogue products. */
function sellerSafe(l) {
  if (!l || !l.from_kinan) return l;
  const { source_link, cj_pid, cj_from, ae_product_id, bg_pid, bg_warehouse, sourcing, ...rest } = l;
  return { ...rest, source: 'kinan', supplier_hidden: true, delivery_days: sourcing?.gb_days || sourcing?.eu_days || null,
    skus: list(l.skus).map(({ cj_vid, cj_storage, ae_sku_id, ae_sku_attr, bg_poa, cost_sale, cost_cny, opts, ...s }) => ({ ...s, kinan_price: money(Number(cost_sale || 0) * (1 + (Number(l.kinan_pct ?? PCT())) / 100)) })) };
}

/** The seller's cost of one order line of a Kinan-catalogue product (the Kinan price). */
function lineCost(listing, sku) { return money(Number(sku.cost_sale || 0) * (1 + Number(listing.kinan_pct ?? PCT()) / 100)); }

module.exports = { browse, details, add, sellerSafe, lineCost, kinanPrice, PCT };
