// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * The owner's "Kinan business" dashboard: Kinan's own shop (the products Kinan sells under its own name) —
 * sales, profit, channels (website / eBay), every product with its numbers, the eBay listings, and the other shops
 * (what they sell and the commission they bring). Product page views come from ops.countView, so each product shows
 * views → sales.
 */
const db = require('../db');
const { config } = require('../config');

const DAY = 86400e3;
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const SOLD = (o) => o.paid_at && !['cancelled', 'refunded', 'pending_payment'].includes(o.status);

/** listingId → product page views over the last `days` days (counted by ops.countView, one per visitor per hour). */
function viewsSince(days, sellerId) {
  const since = dayKey(Date.now() - days * DAY); const out = new Map();
  for (const v of db.views.all((x) => x.day >= since && (!sellerId || x.seller_id === sellerId))) out.set(v.listing_id, (out.get(v.listing_id) || 0) + (v.n || 0));
  return out;
}

// ---------------- the dashboard ----------------
function lineCost(l) { return Number(l.cost_sale || 0) * l.qty; }

function periodNumbers(orders, kinanId, from, to) {
  const inRange = orders.filter((o) => o.paid_at >= from && o.paid_at < to);
  const r = { orders: 0, units: 0, revenue: 0, cost: 0, shipping: 0, profit: 0, ebay_orders: 0, ebay_revenue: 0, ebay_profit: 0, site_orders: 0, site_revenue: 0 };
  for (const o of inRange) {
    const mine = o.lines.filter((l) => l.seller_id === kinanId);
    if (!mine.length) continue;
    const rev = mine.reduce((a, l) => a + l.price * l.qty, 0);
    const cost = mine.reduce((a, l) => a + lineCost(l), 0);
    const onlyMine = mine.length === o.lines.length;
    const ship = onlyMine ? Number(o.shipping_fee || 0) : 0;
    // what Kinan paid the supplier for delivery, when known (CJ's real charge minus the goods)
    const shipCost = onlyMine ? (o.sub_orders || []).reduce((a, s) => a + (s.cj_amount ? Math.max(0, Number(s.cj_amount) - cost) : 0), 0) : 0;
    let profit = rev - cost + ship - (shipCost || ship);
    if (o.channel === 'ebay') {
      try { const m = require('./ebay').sellerMoney(o, mine); if (Number.isFinite(m.profit)) profit = m.profit; } catch { /* keep the estimate */ }
      r.ebay_orders++; r.ebay_revenue += rev + ship; r.ebay_profit += profit;
    } else { r.site_orders++; r.site_revenue += rev + ship; }
    r.orders++; r.units += mine.reduce((a, l) => a + l.qty, 0);
    r.revenue += rev + ship; r.cost += cost + (shipCost || 0); r.shipping += ship; r.profit += profit;
  }
  for (const k of Object.keys(r)) if (typeof r[k] === 'number' && !['orders', 'units', 'ebay_orders', 'site_orders'].includes(k)) r[k] = money(r[k]);
  r.aov = r.orders ? money(r.revenue / r.orders) : 0;
  r.margin_pct = pct(r.profit, r.revenue);
  return r;
}

function dashboard({ days = 30 } = {}) {
  days = Math.min(365, Math.max(1, Math.floor(Number(days) || 30)));
  const now = Date.now(); const from = now - days * DAY;
  const kinan = require('./buyforme').systemSeller();
  const D = require('./sourcing').DEPARTMENTS;
  const sold = db.orders.all(SOLD);
  const cur = String(config.currency || 'usd').toUpperCase();

  const kpi = periodNumbers(sold, kinan.id, from, now);
  const prev = periodNumbers(sold, kinan.id, from - days * DAY, from);
  const today = periodNumbers(sold, kinan.id, new Date(new Date().setHours(0, 0, 0, 0)).getTime(), now);

  // day by day
  const daily = [];
  for (let i = Math.min(days, 90) - 1; i >= 0; i--) {
    const s = new Date(now - i * DAY); s.setHours(0, 0, 0, 0);
    const n = periodNumbers(sold, kinan.id, s.getTime(), s.getTime() + DAY);
    daily.push({ date: dayKey(s.getTime() + 12 * 3600e3), revenue: n.revenue, profit: n.profit, orders: n.orders });
  }

  // per product
  const views = viewsSince(days, kinan.id);
  const per = new Map();
  for (const o of sold.filter((x) => x.paid_at >= from)) for (const l of o.lines) {
    if (l.seller_id !== kinan.id) continue;
    const p = per.get(l.listing_id) || { units: 0, revenue: 0, profit: 0, ebay_units: 0 };
    p.units += l.qty; p.revenue += l.price * l.qty; p.profit += (l.price - Number(l.cost_sale || 0)) * l.qty;
    if (o.channel === 'ebay') p.ebay_units += l.qty;
    per.set(l.listing_id, p);
  }
  const everSold = new Set(); for (const o of sold) for (const l of o.lines) if (l.seller_id === kinan.id) everSold.add(l.listing_id);
  const mine = db.listings.all((l) => l.seller_id === kinan.id);
  const products = mine.map((l) => {
    const sk = (l.skus || []); const cheapest = [...sk].sort((a, b) => a.price - b.price)[0] || {};
    const price = Number(cheapest.price || 0); const cost = Number(cheapest.cost_sale || 0);
    const p = per.get(l.id) || { units: 0, revenue: 0, profit: 0, ebay_units: 0 };
    const v = views.get(l.id) || 0;
    return {
      id: l.id, title: l.title, image: (l.own_images || [])[0] || (l.images || [])[0] || null, status: l.status,
      dept: l.sourcing?.dept || null, dept_name: D[l.sourcing?.dept]?.en || null, section: D[l.sourcing?.dept]?.groups?.[l.sourcing?.group]?.en || null,
      source: l.source || 'other', from: l.cj_from || null, collections: l.collections || [],
      price, cost, margin_pct: price ? pct(price - cost, price) : null, stock: sk.reduce((a, s) => a + (Number(s.stock) || 0), 0), variants: sk.length,
      units: p.units, revenue: money(p.revenue), profit: money(p.profit), ebay_units: p.ebay_units, views: v, conversion: v ? pct(p.units, v) : null,
      rating: l.rating?.avg || null, reviews: l.rating?.count || 0, created_at: l.created_at,
      ebay: l.ebay?.listing_id ? 'live' : l.ebay?.error ? 'failed' : null, ever_sold: everSold.has(l.id)
    };
  });
  const active = products.filter((p) => p.status === 'active');
  const count = (arr, f) => arr.reduce((m, x) => { const k = f(x) || 'other'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const catalog = {
    total: products.length, active: active.length, by_status: count(products, (p) => p.status),
    by_dept: Object.entries(count(active, (p) => p.dept)).map(([k, n]) => ({ id: k, name: D[k]?.en || 'Not sorted', emoji: D[k]?.emoji || '•', count: n, revenue: money(active.filter((p) => (p.dept || 'other') === k).reduce((a, p) => a + p.revenue, 0)) })).sort((a, b) => b.count - a.count),
    by_source: count(active, (p) => p.source), by_warehouse: count(active, (p) => p.from),
    christmas: active.filter((p) => p.collections.includes('christmas') || p.collections.includes('xmas')).length,
    out_of_stock: active.filter((p) => p.stock <= 0).length,
    low_margin: active.filter((p) => p.margin_pct !== null && p.margin_pct < 20).length,
    never_sold: active.filter((p) => !p.ever_sold).length,
    avg_margin_pct: active.length ? Math.round(active.reduce((a, p) => a + (p.margin_pct || 0), 0) / active.length * 10) / 10 : null
  };

  // eBay (Kinan's account)
  let ebay = null;
  try {
    const ec = require('../ebay/client'); const es = require('./ebay');
    const st = ec.status();
    const v = es.sellerView(kinan);
    const by = new Map(mine.map((l) => [l.id, l]));
    const dom = { EBAY_GB: 'co.uk', EBAY_DE: 'de', EBAY_FR: 'fr', EBAY_IT: 'it', EBAY_ES: 'es' };
    const items = (v.products || []).map((r) => {
      const l = by.get(r.id); const p = per.get(r.id) || {};
      return { ...r, url: r.ebay_id ? `https://www.${ec.env?.() === 'sandbox' ? 'sandbox.' : ''}ebay.${dom[l?.ebay?.marketplace] || 'co.uk'}/itm/${r.ebay_id}` : null,
        listed_at: l?.ebay?.listed_at || null, ebay_units: p.ebay_units || 0, image: (l?.images || [])[0] || null };
    });
    ebay = { configured: Boolean(st.configured), connected: Boolean(st.connected), account: st.account || null, env: st.env || null,
      live: items.filter((x) => x.status === 'live').length, ready: items.filter((x) => x.status === 'ready').length,
      failed: items.filter((x) => x.status === 'failed').length, not_eligible: items.filter((x) => x.status === 'not_eligible').length,
      hold: items.some((x) => /hold has been placed/i.test(x.reason || '')), items, orders: (v.orders || []).slice(0, 30) };
  } catch (e) { ebay = { error: e.message }; }

  // other shops
  const led = db.ledger.all((x) => x.type === 'sale' && x.status !== 'void');
  const stores = db.sellers.all((s) => !s.system).map((s) => {
    const myLed = led.filter((x) => x.seller_id === s.id && (db.orders.get(x.order_id)?.paid_at || 0) >= from);
    const lastSale = led.filter((x) => x.seller_id === s.id).map((x) => db.orders.get(x.order_id)?.paid_at || 0).sort((a, b) => b - a)[0] || null;
    const owner = s.user_id ? db.users.get(s.user_id) : null;
    return { id: s.id, shop_name: s.shop_name, status: s.status, verification: s.kyc?.state || null, email: owner?.email || null, created_at: s.created_at,
      products: db.listings.all((l) => l.seller_id === s.id && l.status === 'active').length,
      pending_products: db.listings.all((l) => l.seller_id === s.id && l.status === 'pending_review').length,
      orders: new Set(myLed.map((x) => x.order_id)).size, sales: money(myLed.reduce((a, x) => a + Number(x.gross || 0), 0)),
      commission: money(myLed.reduce((a, x) => a + Number(x.commission || 0), 0)), commission_pct: s.commission_pct, last_sale: lastSale,
      terms_ok: s.terms?.version === require('../auth').SELLER_TERMS_VERSION, ebay: s.ebay?.mode || null };
  }).sort((a, b) => b.sales - a.sales || b.products - a.products);
  const commission = money(stores.reduce((a, s) => a + s.commission, 0));

  // recent orders with Kinan's products
  const recent = db.orders.all((o) => o.lines.some((l) => l.seller_id === kinan.id) && o.status !== 'pending_payment').sort((a, b) => (b.paid_at || b.created_at) - (a.paid_at || a.created_at)).slice(0, 25).map((o) => {
    const ln = o.lines.filter((l) => l.seller_id === kinan.id);
    const rev = ln.reduce((a, l) => a + l.price * l.qty, 0);
    return { id: o.id, at: o.paid_at || o.created_at, status: o.status, channel: o.channel || 'site', country: o.shipping_address?.country || null,
      items: ln.map((l) => `${l.qty} × ${l.title.slice(0, 50)}`).join(', '), revenue: money(rev + (ln.length === o.lines.length ? Number(o.shipping_fee || 0) : 0)),
      profit: money(ln.reduce((a, l) => a + (l.price - Number(l.cost_sale || 0)) * l.qty, 0)) };
  });

  // things worth a look
  const tips = [];
  if (ebay?.hold) tips.push({ level: 'bad', text: 'eBay account on hold (payment) — products cannot be listed until it is paid in eBay Seller Hub → Payments.' });
  if (catalog.out_of_stock) tips.push({ level: 'warn', text: `${catalog.out_of_stock} live product(s) are out of stock.` });
  if (catalog.low_margin) tips.push({ level: 'warn', text: `${catalog.low_margin} product(s) have less than 20 % margin.` });
  const viewedNoSale = active.filter((p) => p.views >= 30 && !p.units).length;
  if (viewedNoSale) tips.push({ level: 'info', text: `${viewedNoSale} product(s) were viewed 30+ times without a sale — check price, photos and delivery time.` });
  if (stores.some((s) => s.pending_products)) tips.push({ level: 'info', text: 'Sellers have products waiting for review (Products → Review).' });

  return { currency: cur, days, generated_at: now, kpi, prev, today, daily, catalog, products, ebay, stores, commission, recent, tips,
    top: [...active].filter((p) => p.units).sort((a, b) => b.revenue - a.revenue).slice(0, 10) };
}

/** CSV of Kinan's products with their numbers (for Excel / Google Sheets). */
function productsCsv(days) {
  const d = dashboard({ days });
  const q = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = ['id', 'title', 'status', 'dept_name', 'section', 'source', 'from', 'price', 'cost', 'margin_pct', 'stock', 'views', 'units', 'revenue', 'profit', 'conversion', 'ebay', 'rating', 'reviews'];
  return [cols.join(','), ...d.products.map((p) => cols.map((c) => q(p[c])).join(','))].join('\n');
}

module.exports = { dashboard, productsCsv, viewsSince };
