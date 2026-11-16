'use strict';
/**
 * Test order (admin): a small basket of cheap, fast and varied live products, so Kinan can buy them for itself and
 * check the whole journey (checkout, payment, supplier order, tracking, delivery). One product per department and a
 * mix of suppliers (CJ / AliExpress …), each the cheapest option in stock. Kinan pays it like any customer.
 */
const db = require('../db');

const list = (v) => (Array.isArray(v) ? v : []);
const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
const money = (v) => Math.round(Number(v) * 100) / 100;

/** Delivery days to the country (UK or EU) as found when the product was checked. */
const daysTo = (l, cc) => { const so = l.sourcing || {}; return Number(cc === 'GB' ? so.gb_days : EU.has(cc) ? so.eu_days : null) || null; };

function basket({ country = 'MT', n = 8, max_price = 5, max_days = 12, departments = '' } = {}) {
  const only = new Set(String(departments || '').split(',').map((x) => x.trim()).filter(Boolean));
  const cc = String(country || 'MT').toUpperCase();
  n = Math.min(20, Math.max(1, Math.floor(Number(n) || 8)));
  const maxP = Math.max(0.5, Number(max_price) || 5); const maxD = Math.max(3, Number(max_days) || 12);
  const { priceOf } = require('./deals');
  const sellers = new Map();
  const ok = (l) => { const s = sellers.has(l.seller_id) ? sellers.get(l.seller_id) : sellers.set(l.seller_id, db.sellers.get(l.seller_id)).get(l.seller_id); return s?.status === 'active'; };
  const cands = [];
  for (const l of db.listings.all((x) => x.status === 'active' && !x.from_kinan)) {
    if (only.size && !list(l.collections).some((c) => only.has(c))) continue;
    const d = daysTo(l, cc); if (!d || d > maxD) continue;
    if (cc !== 'GB' && cc !== 'MT' && l.source === 'cj' && require('./cj').noDeliveryList(l).includes(cc)) continue;
    const s = list(l.skus).filter((k) => k.stock > 0).map((k) => ({ k, p: priceOf(l, k) })).sort((a, b) => a.p - b.p)[0];
    if (!s || !(s.p > 0) || s.p > maxP || !ok(l)) continue;
    cands.push({ l, s: s.k, price: money(s.p), days: d, dept: list(l.collections)[0] || l.category || 'other', spread: only.size ? `${list(l.collections)[0]}:${l.collection_group || l.sourcing?.group || ''}` : (list(l.collections)[0] || l.category || 'other'), src: l.source || 'manual', q: Number(l.sourcing?.quality) || 0 });
  }
  // fastest and best first, then spread over departments and suppliers
  cands.sort((a, b) => a.days - b.days || b.q - a.q || a.price - b.price);
  const pick = []; const depts = new Set(); const srcN = {};
  for (const pass of [0, 1]) {
    for (const c of cands) {
      if (pick.length >= n) break;
      if (pick.includes(c)) continue;
      if (pass === 0 && (depts.has(c.spread) || (srcN[c.src] || 0) >= Math.ceil(n / 2))) continue;
      pick.push(c); depts.add(c.spread); srcN[c.src] = (srcN[c.src] || 0) + 1;
    }
  }
  const items = pick.map((c) => ({
    listing_id: c.l.id, mp_sku_id: c.s.mp_sku_id, title: c.l.title, props: list(c.l.skus).length > 1 ? String(c.s.props || '') : '', price: c.price,
    image: c.s.image || list(c.l.images)[0] || null, days: c.days, department: c.dept, section: c.l.collection_group || c.l.sourcing?.group || null, supplier: c.src, direct: c.l.fulfillment === 'direct', shop_id: c.l.seller_id, currency: c.l.currency
  }));
  const subtotal = money(items.reduce((a, x) => a + x.price, 0));
  let shipping = null;
  try { shipping = require('./shipping').quote(items.map((x) => ({ listing_id: x.listing_id, mp_sku_id: x.mp_sku_id, qty: 1 })), cc).fee; } catch { /* shown at checkout */ }
  const base = ''; // same site as the admin (kinan.shop), so the cart fills where the customer shops
  return {
    country: cc, max_price: maxP, max_days: maxD, found: cands.length, items, subtotal,
    shipping: shipping == null ? null : money(shipping), total: shipping == null ? null : money(subtotal + shipping),
    slowest_days: items.length ? Math.max(...items.map((x) => x.days)) : null, currency: items[0]?.currency || require('../config').currency,
    link: items.length ? `${base}/#/add/${items.map((x) => `${x.listing_id}~${encodeURIComponent(x.mp_sku_id)}`).join(',')}` : null
  };
}

/** The cart lines for an "add these" link (public: only live products, current prices). */
function lines(spec) {
  const C = require('./catalog');
  const out = [];
  for (const part of String(spec || '').split(',').slice(0, 30)) {
    const [id, sk] = part.split('~').map((x) => decodeURIComponent(x || ''));
    try {
      const p = C.buyerListing(id); const s = p.skus.find((k) => k.mp_sku_id === sk) || p.skus.find((k) => k.in_stock);
      if (!s || !s.in_stock) continue;
      out.push({ listing_id: p.id, mp_sku_id: s.mp_sku_id, qty: 1, title: p.title, shop_id: p.shop?.id, direct: p.fulfillment === 'direct', props: p.skus.length > 1 ? s.props : '', price: s.price, currency: p.currency, image: s.image || p.images[0] || null });
    } catch { /* gone */ }
  }
  return { items: out };
}

module.exports = { basket, lines, daysTo };
