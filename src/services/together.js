// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * "Frequently bought together" (like Amazon): for a product, up to 2 others that go with it — first what shoppers really
 * bought in the same order, otherwise what the AI picks as complements (things you use with it, not alternatives to it).
 * Bought together in one cart they get BUNDLE_PCT off (5%), never below 110% of cost.
 */
const db = require('../db');

const TTL = 7 * 86400e3;
const PCT = () => Math.min(20, Math.max(0, Number(process.env.BUNDLE_PCT ?? 5)));
const FLOOR = 1.1;
const money = (v) => Math.round(Number(v) * 100) / 100;
const live = (l) => l && l.status === 'active' && (l.skus || []).some((s) => s.stock > 0) && ((l.images || []).length || (l.own_images || []).length);

/** Products bought in the same paid order as this one, most often first. */
function fromOrders(id) {
  const n = new Map();
  for (const o of db.orders.all((x) => x.paid_at && (x.lines || []).some((ln) => ln.listing_id === id))) {
    for (const other of new Set(o.lines.map((ln) => ln.listing_id))) if (other !== id) n.set(other, (n.get(other) || 0) + 1);
  }
  return [...n].filter(([k, c]) => c >= 2 && live(db.listings.get(k))).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

const busy = new Set();
/** Ask the AI for complements (background, kept a week on the product). */
async function pickWithAi(id) {
  const ai = require('./ai');
  const l = db.listings.get(id);
  if (!l || busy.has(id) || !ai.enabled()) return null;
  busy.add(id);
  try {
    const dept = l.sourcing?.dept; const cols = new Set(l.collections || []);
    const minP = Math.min(...l.skus.map((s) => s.price));
    const pool = db.listings.all((o) => o.id !== id && o.seller_id === l.seller_id && live(o)
      && ((dept && o.sourcing?.dept === dept) || (o.collections || []).some((c) => cols.has(c)) || (o.category || 'other') === (l.category || 'other'))
      && Math.min(...o.skus.map((s) => s.price)) <= Math.max(minP * 1.2, 15)).slice(0, 60);
    let ids = [];
    if (pool.length) {
      const r = await ai.structured({
        system: 'You are a merchandiser. Pick products a shopper buying the main product would also want: things used WITH it (accessories, refills, matching items) — never alternatives to it or near-copies of it.',
        name: 'bought_together', kind: 'together', maxTokens: 120, timeoutMs: 30000,
        schema: { type: 'object', properties: { picks: { type: 'array', items: { type: 'integer' }, description: '0–2 numbers from the list; empty if nothing really goes with it.' } }, required: ['picks'] },
        text: `Main product: ${l.title}\nChoose up to 2:\n${pool.map((o, i) => `${i}. ${o.title.slice(0, 90)}`).join('\n')}`
      });
      ids = [...new Set((r.picks || []).map(Number))].filter((i) => pool[i]).slice(0, 2).map((i) => pool[i].id);
    }
    db.listings.update(id, { together: { ids, at: Date.now() } });
    return ids;
  } catch (e) { console.warn('[together]', e.message); return null; }
  finally { busy.delete(id); }
}

/** The 0–2 products to show with this one (starts the AI in the background when it has not chosen yet). */
function forListing(id) {
  const l = db.listings.get(id);
  if (!l) return [];
  const real = fromOrders(id);
  const t = l.together;
  if (!t || Date.now() - t.at > TTL) require('../cj/client').background(() => pickWithAi(id)).catch(() => {});
  const ids = [...new Set([...real, ...((t && t.ids) || [])])].filter((x) => live(db.listings.get(x))).slice(0, 2);
  return ids;
}

/** Shop view: the products plus the bundle saving. */
function view(id) {
  const ids = forListing(id);
  if (!ids.length) return { items: [], pct: PCT() };
  const items = require('./catalog').many(ids).items;
  return { items, pct: PCT() };
}

/** Cart: lines that are "bought together" with another product in the same cart get the bundle discount. */
function discount(lines) {
  const pct = PCT(); if (!pct) return { amount: 0, lines: [] };
  const inCart = new Set(lines.map((x) => x.listing_id));
  const out = []; let amount = 0;
  for (const ln of lines) {
    const partner = [...inCart].find((other) => other !== ln.listing_id && (forListingCached(other).includes(ln.listing_id)));
    if (!partner) continue;
    const cost = Number(ln.cost_sale) || 0;
    let off = money(ln.price * pct / 100);
    if (cost) off = Math.max(0, Math.min(off, money(ln.price - cost * FLOOR)));
    if (off <= 0) continue;
    amount = money(amount + off * ln.qty); out.push({ listing_id: ln.listing_id, off, with: partner });
  }
  return { amount, lines: out };
}
/** Without starting the AI (checkout must be quick and repeatable). */
function forListingCached(id) {
  const l = db.listings.get(id); if (!l) return [];
  return [...new Set([...fromOrders(id), ...((l.together && l.together.ids) || [])])].slice(0, 2);
}

/** Same as discount(), from cart items ({ listing_id, mp_sku_id, qty }) — for the cart and checkout totals. */
function forItems(items) {
  const deals = require('./deals');
  const lines = [];
  for (const it of (items || []).slice(0, 100)) {
    const l = db.listings.get(it.listing_id); const s = l && (l.skus || []).find((k) => k.mp_sku_id === String(it.mp_sku_id));
    if (!s) continue;
    lines.push({ listing_id: l.id, price: deals.priceOf(l, s), qty: Math.max(1, Math.floor(Number(it.qty) || 1)), cost_sale: s.cost_sale ?? null });
  }
  return discount(lines);
}

module.exports = { forItems, forListing, view, discount, pickWithAi, fromOrders, PCT };
