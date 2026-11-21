'use strict';
/**
 * Products by platform (admin): one list per source — AliExpress, CJdropshipping, Taobao, Banggood, the Kinan
 * catalogue copies sellers made, sellers' own products … A source that appears later (a new supplier) shows up on
 * its own, with a plain name made from its code.
 */
const db = require('../db');
const { httpError } = require('../auth');

const list = (v) => (Array.isArray(v) ? v : []);
// known platforms, in the order they are shown; anything else is listed after them
const KNOWN = {
  aliexpress: { name: 'AliExpress', icon: 'AE', color: '#e62e04' },
  cj: { name: 'CJdropshipping', icon: 'CJ', color: '#1d6fe8' },
  taobao: { name: 'Taobao', icon: '淘', color: '#ff5000' },
  banggood: { name: 'Banggood', icon: 'BG', color: '#f39c12' },
  kinan: { name: 'Kinan catalogue (sellers)', icon: 'K', color: '#036747' },
  manual: { name: 'Sellers’ own products', icon: '✎', color: '#5b6478' },
  warehouse: { name: 'Kinan warehouse', icon: '▣', color: '#6c5ce7' }
};
/** The platform of a listing: a Kinan-catalogue copy counts as "kinan"; no source means the seller's own. */
const platformOf = (l) => (l.from_kinan ? 'kinan' : String(l.source || 'manual').toLowerCase());
const nameOf = (k) => KNOWN[k]?.name || k.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const STATUS = ['active', 'pending_review', 'paused', 'rejected', 'unavailable'];

function summary() {
  const kinan = require('./buyforme').systemSeller().id;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const by = {};
  for (const l of db.listings.all()) {
    const k = platformOf(l);
    const b = by[k] || (by[k] = { id: k, total: 0, status: {}, kinan_shop: 0, sellers: new Set(), today: 0, days: [] });
    b.total++; b.status[l.status] = (b.status[l.status] || 0) + 1;
    if (l.seller_id === kinan) b.kinan_shop++; else b.sellers.add(l.seller_id);
    if ((l.created_at || 0) >= today.getTime()) b.today++;
    const d = Number(l.sourcing?.gb_days || l.sourcing?.eu_days); if (l.status === 'active' && d) b.days.push(d);
  }
  const order = Object.keys(KNOWN);
  return Object.values(by).map((b) => ({
    id: b.id, name: nameOf(b.id), icon: KNOWN[b.id]?.icon || b.id.slice(0, 2).toUpperCase(), color: KNOWN[b.id]?.color || '#5b6478',
    total: b.total, active: b.status.active || 0, pending: b.status.pending_review || 0, paused: b.status.paused || 0, rejected: (b.status.rejected || 0) + (b.status.unavailable || 0),
    kinan_shop: b.kinan_shop, seller_shops: b.sellers.size, added_today: b.today,
    avg_days: b.days.length ? Math.round(b.days.reduce((a, x) => a + x, 0) / b.days.length * 10) / 10 : null
  })).sort((a, b) => ((order.indexOf(a.id) + 1) || 99) - ((order.indexOf(b.id) + 1) || 99) || b.total - a.total);
}

/** One platform's products, newest first, with search, status filter and pages. */
function products(platform, { status = '', q = '', page = 1, per = 30 } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  let items = db.listings.all((l) => platformOf(l) === platform && (!status || l.status === status) && words.every((w) => `${l.title} ${l.id} ${l.cj_pid || ''} ${l.ae_product_id || ''}`.toLowerCase().includes(w)));
  if (!items.length && !db.listings.find((l) => platformOf(l) === platform)) throw httpError(404, 'No products from this platform');
  items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const total = items.length; const pg = Math.max(1, Math.floor(Number(page) || 1));
  const sellers = {};
  const shop = (id) => (sellers[id] ??= db.sellers.get(id)?.shop_name || id);
  items = items.slice((pg - 1) * per, pg * per).map((l) => {
    const skus = list(l.skus);
    const price = skus.length ? Math.min(...skus.map((s) => Number(s.price) || 0)) : null;
    const cost = skus.filter((s) => s.cost_sale != null).length ? Math.min(...skus.filter((s) => s.cost_sale != null).map((s) => Number(s.cost_sale))) : null;
    return {
      id: l.id, title: l.title, image: [...list(l.own_images), ...list(l.images)][0] || null, shop: shop(l.seller_id), status: l.status,
      price, cost, currency: l.currency || null, stock: skus.reduce((a, s) => a + (Number(s.stock) || 0), 0), options: skus.length,
      days: l.sourcing?.gb_days || l.sourcing?.eu_days || null, from: l.ae_from || l.cj_from || l.bg_warehouse || null,
      department: list(l.collections)[0] || null, quality: l.sourcing?.quality || null, created_at: l.created_at,
      supplier_link: l.source_link || (l.ae_product_id ? `https://www.aliexpress.com/item/${l.ae_product_id}.html` : null), paused_reason: l.paused_reason || null,
      on_ebay: Boolean(l.ebay?.listing_id)
    };
  });
  return { platform, name: nameOf(platform), status, total, page: pg, pages: Math.max(1, Math.ceil(total / per)), items };
}

/** Pause or switch on a product (admin). */
function setStatus(id, status, user) {
  if (!['active', 'paused'].includes(status)) throw httpError(400, 'Status must be active or paused');
  const l = db.listings.get(id); if (!l) throw httpError(404, 'Product not found');
  return db.listings.update(id, status === 'paused' ? { status, paused_reason: 'Paused by Kinan', paused_by: user?.id || 'admin', paused_at: Date.now() } : { status, paused_reason: null, paused_by: null });
}

module.exports = { summary, products, setStatus, platformOf, STATUS };
