// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Partner catalogue: projections, versions, the change feed and cursors.
 *
 * Sources (kept apart by environment):
 *   sandbox → synthetic fixtures copied into `partner_sandbox` (never real listings)
 *   live    → the reviewed KINAN catalogue (kinanCatalog.offered), only when production is enabled
 * A projector compares each source product with its last projected state and records ordered events
 * (seq per environment) in `partner_changes`: upsert / withdraw per market. Entitlement changes for one
 * store add store-scoped events, so every store's feed converges without a new snapshot.
 *
 * Sync algorithm for partners:
 *   1. Page through GET /catalog/products until `sync_cursor` (bound to the feed position when page 1 was read).
 *   2. Poll GET /catalog/changes?cursor=… and apply events in order; keep the returned cursor.
 *   Writes during the snapshot are replayed by the feed; versions only grow, so applying the newest wins.
 *   An upsert the store is no longer entitled to is delivered as a withdraw. Cursors older than the retention
 *   window answer 410 CURSOR_EXPIRED: rebuild from a new snapshot. */
'use strict';
const crypto = require('crypto');
const db = require('../db');
const pricing = require('./pricing');

const FIXTURES = require('./sandbox-fixtures.json');
const RETENTION_DAYS = () => Math.max(1, Number(process.env.PARTNER_CHANGE_RETENTION_DAYS) || 30);
const SYNC_EVERY_MS = 30e3;
const lastSync = { sandbox: 0, live: 0 };

class PartnerError extends Error { constructor(status, code, title, detail, extra) { super(detail || title); Object.assign(this, { status, code, title, detail, extra }); } }

// ---------- secrets and cursors ----------
let secretCache = null;
function secret() {
  if (process.env.PARTNER_CURSOR_SECRET) return process.env.PARTNER_CURSOR_SECRET;
  if (secretCache) return secretCache;
  let s = db.settings.get('partner_secret');
  if (!s) s = db.settings.insert({ id: 'partner_secret', value: crypto.randomBytes(32).toString('hex') });
  return (secretCache = s.value);
}
const b64 = (b) => Buffer.from(b).toString('base64url');
function encodeCursor(obj) {
  const body = b64(JSON.stringify({ v: 1, ...obj }));
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 22);
  return `${body}.${sig}`;
}
function decodeCursor(c, expect) {
  const [body, sig] = String(c || '').split('.');
  const good = body && sig && crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 22);
  if (!good || good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) throw new PartnerError(400, 'INVALID_CURSOR', 'Invalid cursor', 'The cursor is malformed or was not issued by KINAN.');
  let o; try { o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new PartnerError(400, 'INVALID_CURSOR', 'Invalid cursor'); }
  for (const [k, v] of Object.entries(expect)) if (o[k] !== v) throw new PartnerError(400, 'CURSOR_SCOPE_MISMATCH', 'Cursor belongs to a different query', `The cursor was issued for another ${k === 's' ? 'store' : k === 'm' ? 'market' : k === 'l' ? 'locale' : k === 't' ? 'operation' : 'environment'}. Start a new snapshot for this query.`);
  return o;
}

// ---------- sequence and events ----------
function seqDoc(env) { const id = `partner_seq_${env}`; return db.settings.get(id) || db.settings.insert({ id, n: 0, floor: 0 }); }
function nextSeq(env) { const d = seqDoc(env); const n = (d.n || 0) + 1; db.settings.update(d.id, { n }); return n; }
const headSeq = (env) => seqDoc(env).n || 0;
const floorSeq = (env) => seqDoc(env).floor || 0;

function emit(env, market, productId, type, version, reason, storeId = null) {
  return db.partner_changes.insert({ seq: nextSeq(env), env, market, product_id: productId, type, version, reason, store_id: storeId, at: Date.now() });
}

/** Drop events older than the retention window; cursors before the newest dropped event then answer 410. */
function prune(env, now = Date.now()) {
  const cut = now - RETENTION_DAYS() * 86400e3;
  let floor = floorSeq(env);
  for (const e of db.partner_changes.all((x) => x.env === env && x.at < cut)) { floor = Math.max(floor, e.seq); db.partner_changes.remove(e.id); }
  if (floor !== floorSeq(env)) db.settings.update(seqDoc(env).id, { floor });
  return floor;
}

// ---------- sources ----------
function sandboxProducts() {
  if (!db.partner_sandbox.all().length) for (const p of FIXTURES.products) db.partner_sandbox.insert({ id: `sbx_${p.key}`, ...p });
  return db.partner_sandbox.all();
}
function baseFromSandbox(p) {
  return {
    product_id: `kp_sbx_${p.key}`, category_id: p.category_id, markets: [...p.markets].sort(),
    title: p.title, description: p.description, media: p.media,
    variants: p.variants.map((v) => ({ variant_id: `kv_sbx_${v.key}`, sku: v.sku, options: v.options, weight_grams: v.weight_grams, dimensions_mm: v.dimensions_mm, stock: Math.max(0, Math.floor(v.stock)), quantity_backed: true, cost_minor: v.cost_minor, min_order_quantity: v.min_order_quantity || 1 })),
    compliance: { publication_status: 'eligible', warnings: [], resources: [] },
    active: !p.withdrawn
  };
}
function liveProducts() {
  if (!require('./store').liveEnabled()) return [];
  const kc = require('../services/kinanCatalog');
  return db.listings.all((l) => l.status === 'active' && ['cj', 'aliexpress'].includes(l.source) && l.seller_id === require('../services/buyforme').systemSeller().id)
    .map((l) => ({ l, kc }));
}
function baseFromLive({ l, kc }) {
  const skus = (l.skus || []).filter((s) => s.cost_sale > 0);
  const tr = { en: l.title }; if (l.title_ar) tr.ar = l.title_ar;
  const ds = { en: String(l.description || '').slice(0, 4000) }; if (l.description_ar) ds.ar = String(l.description_ar).slice(0, 4000);
  return {
    product_id: `kp_${String(l.id).replace(/^lst_/, '')}`, category_id: (l.collections || [])[0] || l.category || 'general',
    markets: ['DE'], title: tr, description: ds,
    media: (l.images || []).slice(0, 8).map((u) => ({ url: String(u), alt: { en: l.title } })),
    variants: skus.map((s) => ({ variant_id: `kv_${String(s.mp_sku_id)}`, sku: `KIN-${String(s.mp_sku_id).slice(-10).toUpperCase()}`, options: { option: { en: s.props || 'Standard' } }, weight_grams: s.weight_g || null, dimensions_mm: null, stock: Math.max(0, Number(s.stock) || 0), quantity_backed: false, cost_minor: Math.round(kc.lineCost(l, s) * 100), min_order_quantity: 1 })),
    // Live products need publication evidence (manufacturer, responsible person, warnings) before partners may list them
    compliance: { publication_status: l.partner_publication === 'eligible' ? 'eligible' : 'review_required', warnings: [], resources: [] },
    active: skus.length > 0 && l.partner_publication === 'eligible'
  };
}

const hashOf = (b) => crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
const stateId = (env, pid) => `${env}:${pid}`;

/** Compare sources with projected state and record changes. Returns the number of events written. */
function sync(env, { force = false } = {}) {
  if (!force && Date.now() - lastSync[env] < SYNC_EVERY_MS) return 0;
  lastSync[env] = Date.now();
  const docs = env === 'sandbox' ? sandboxProducts().map(baseFromSandbox) : liveProducts().map(baseFromLive);
  const seen = new Set(); let n = 0;
  for (const b of docs) {
    seen.add(b.product_id);
    const id = stateId(env, b.product_id); const cur = db.partner_state.get(id);
    const h = hashOf(b); const stockHash = hashOf(b.variants.map((v) => [v.variant_id, v.stock]));
    if (cur && cur.hash === h) continue;
    const version = (cur?.version || 0) + 1;
    const reason = !cur ? 'created' : !b.active ? 'withdrawn' : !cur.base.active ? 'restored' : cur.stock_hash !== stockHash && hashOf({ ...b, variants: b.variants.map(({ stock, ...v }) => v) }) === hashOf({ ...cur.base, variants: cur.base.variants.map(({ stock, ...v }) => v) }) ? 'inventory' : 'updated';
    const doc = { id, env, product_id: b.product_id, version, hash: h, stock_hash: stockHash, base: b, checked_at: Date.now() };
    if (cur) db.partner_state.update(id, doc); else db.partner_state.insert(doc);
    const was = cur && cur.base.active ? cur.base.markets : [];
    const now = b.active ? b.markets : [];
    for (const m of now) { emit(env, m, b.product_id, 'upsert', version, reason); n++; }
    for (const m of was.filter((x) => !now.includes(x))) { emit(env, m, b.product_id, 'withdraw', version, b.active ? 'market_removed' : 'withdrawn'); n++; }
  }
  for (const cur of db.partner_state.all((s) => s.env === env && !seen.has(s.product_id) && s.base.active)) {
    const version = cur.version + 1; const base = { ...cur.base, active: false };
    db.partner_state.update(cur.id, { version, base, hash: hashOf(base), checked_at: Date.now() });
    for (const m of cur.base.markets) { emit(env, m, cur.product_id, 'withdraw', version, 'withdrawn'); n++; }
  }
  if (env === 'sandbox' || n) prune(env);
  return n;
}

// ---------- entitlement ----------
function entitled(store, base, market) {
  const e = store.entitlements || {};
  return !!base.active && base.markets.includes(market) && (e.markets || []).includes(market)
    && (!(e.categories || []).length || e.categories.includes(base.category_id)) && !(e.excluded || []).includes(base.product_id);
}

/** Store entitlements or its price list changed: emit store-scoped events so its feed converges. */
function entitlementChanged(store, before, priceChanged = false) {
  const was = { ...store, entitlements: before };
  for (const env of ['sandbox', 'live']) {
    const markets = [...new Set([...(before.markets || []), ...(store.entitlements.markets || [])])];
    for (const s of db.partner_state.all((x) => x.env === env)) {
      for (const m of markets) {
        const a = entitled(was, s.base, m); const b = entitled(store, s.base, m);
        if (a && !b) emit(env, m, s.product_id, 'withdraw', s.version, 'entitlement_revoked', store.id);
        else if (!a && b) emit(env, m, s.product_id, 'upsert', s.version, 'entitlement_granted', store.id);
        else if (a && b && priceChanged) emit(env, m, s.product_id, 'upsert', s.version, 'price_list', store.id);
      }
    }
  }
}

// ---------- projection ----------
function pickLocale(map, locale) {
  if (!map) return { value: null, locale: null };
  const lang = String(locale).split('-')[0];
  for (const k of [locale, lang, 'en']) if (map[k] !== undefined) return { value: map[k], locale: k };
  const k = Object.keys(map)[0]; return { value: map[k], locale: k };
}

/** Partner-safe product for one store, market and locale. Never includes supplier, cost or internal ids. */
function project(state, store, market, locale) {
  const b = state.base; const t = pickLocale(b.title, locale);
  const pl = store.price_list || { version: 1, markup_pct: 0 };
  return {
    product_id: b.product_id,
    version: state.version + ((pl.version || 1) - 1),
    market, locale, content_locale: t.locale,
    title: t.value, description: pickLocale(b.description, locale).value,
    category_id: b.category_id,
    media: b.media.map((m) => ({ url: m.url, alt: pickLocale(m.alt, locale).value })),
    variants: b.variants.map((v) => ({
      variant_id: v.variant_id, sku: v.sku,
      options: Object.fromEntries(Object.entries(v.options || {}).map(([k, val]) => [k, typeof val === 'object' ? pickLocale(val, locale).value : val])),
      weight_grams: v.weight_grams ?? null, dimensions_mm: v.dimensions_mm ?? null,
      availability: { state: v.stock > 0 ? 'in_stock' : 'out_of_stock', checked_at: new Date(state.checked_at).toISOString(), ...(v.quantity_backed ? { sellable_quantity: Math.min(v.stock, 50) } : {}) },
      wholesale_unit_price_ex_tax: { amount_minor: pricing.wholesaleUnit(v.cost_minor, pl), currency: 'EUR' },
      min_order_quantity: v.min_order_quantity || 1
    })),
    compliance: b.compliance,
    price_list_version: pl.version || 1,
    pricing_note: 'Indicative wholesale price per unit excluding tax and delivery. The quote is binding.'
  };
}

// ---------- reads ----------
const LIMIT = (v, d, max) => Math.min(max, Math.max(1, Math.floor(Number(v)) || d));

function snapshot(ctx, { market, locale, limit, cursor }) {
  sync(ctx.env);
  const scope = { s: ctx.store.id, e: ctx.env, m: market, l: locale, t: 'snap' };
  let after = ''; let hwm = headSeq(ctx.env);
  if (cursor) { const c = decodeCursor(cursor, scope); after = c.k; hwm = c.h; }
  const all = db.partner_state.all((s) => s.env === ctx.env && entitled(ctx.store, s.base, market)).sort((a, b) => (a.product_id < b.product_id ? -1 : 1));
  const rest = all.filter((s) => s.product_id > after);
  const n = LIMIT(limit, 50, 100); const page = rest.slice(0, n);
  const more = rest.length > n;
  return {
    data: page.map((s) => project(s, ctx.store, market, locale)),
    next_cursor: more ? encodeCursor({ ...scope, k: page[page.length - 1].product_id, h: hwm }) : null,
    sync_cursor: more ? null : encodeCursor({ s: ctx.store.id, e: ctx.env, m: market, l: locale, t: 'feed', q: hwm }),
    total: all.length
  };
}

function product(ctx, id, { market, locale }) {
  sync(ctx.env);
  const s = db.partner_state.get(stateId(ctx.env, String(id)));
  if (!s || !entitled(ctx.store, s.base, market)) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Product not found', 'No product with this id is available to your store in this market.');
  return project(s, ctx.store, market, locale);
}

function changes(ctx, { market, locale, cursor, limit }) {
  if (!cursor) throw new PartnerError(400, 'INVALID_INPUT', 'cursor is required', 'Use the sync_cursor from the last snapshot page or the next_cursor from a previous changes call.', { errors: [{ field: 'cursor', code: 'required' }] });
  const c = decodeCursor(cursor, { s: ctx.store.id, e: ctx.env, m: market, l: locale, t: 'feed' });
  sync(ctx.env);
  if (c.q < floorSeq(ctx.env)) throw new PartnerError(410, 'CURSOR_EXPIRED', 'Cursor expired', `Changes older than ${RETENTION_DAYS()} days are no longer kept. Rebuild from a new snapshot.`);
  const n = LIMIT(limit, 100, 500);
  const evs = db.partner_changes.all((e) => e.env === ctx.env && e.market === market && e.seq > c.q && (!e.store_id || e.store_id === ctx.store.id)).sort((a, b) => a.seq - b.seq);
  const page = evs.slice(0, n);
  const data = page.map((e) => {
    const s = db.partner_state.get(stateId(ctx.env, e.product_id));
    const ok = e.type === 'upsert' && s && entitled(ctx.store, s.base, market);
    const base = { seq: e.seq, type: ok ? 'upsert' : 'withdraw', product_id: e.product_id, reason: ok || e.type === 'withdraw' ? e.reason : 'not_entitled', occurred_at: new Date(e.at).toISOString() };
    if (!ok) return { ...base, version: s ? s.version + ((ctx.store.price_list?.version || 1) - 1) : e.version };
    const p = project(s, ctx.store, market, locale);
    return { ...base, version: p.version, product: p };
  });
  const last = page.length ? page[page.length - 1].seq : Math.max(c.q, 0);
  return { data, next_cursor: encodeCursor({ s: ctx.store.id, e: ctx.env, m: market, l: locale, t: 'feed', q: last }), has_more: evs.length > n };
}

// ---------- sandbox simulation (admin only) ----------
/** Change a synthetic product so partners can test their sync: stock, cost, withdraw/restore, markets. */
function simulate(key, change = {}) {
  sandboxProducts();
  const p = db.partner_sandbox.get(`sbx_${String(key).replace(/^kp_sbx_|^sbx_/, '')}`);
  if (!p) { const e = new Error('Sandbox product not found'); e.status = 404; throw e; }
  const patch = {};
  if (change.withdrawn !== undefined) patch.withdrawn = !!change.withdrawn;
  if (Array.isArray(change.markets)) patch.markets = change.markets.map((m) => String(m).toUpperCase());
  if (change.title_en !== undefined) patch.title = { ...p.title, en: String(change.title_en).slice(0, 120) };
  if (change.stock !== undefined || change.cost_minor !== undefined) {
    patch.variants = p.variants.map((v, i) => (change.variant === undefined || change.variant === i || change.variant === v.key
      ? { ...v, ...(change.stock !== undefined ? { stock: Math.max(0, Math.floor(Number(change.stock) || 0)) } : {}), ...(change.cost_minor !== undefined ? { cost_minor: Math.max(1, Math.round(Number(change.cost_minor))) } : {}) } : v));
  }
  db.partner_sandbox.update(p.id, patch);
  return { events: sync('sandbox', { force: true }), product: db.partner_sandbox.get(p.id) };
}
function resetSandbox() { for (const p of db.partner_sandbox.all()) db.partner_sandbox.remove(p.id); sandboxProducts(); return { events: sync('sandbox', { force: true }) }; }

/** Health numbers for the admin page. */
function health(env) { return { env, head_seq: headSeq(env), floor_seq: floorSeq(env), products: db.partner_state.all((s) => s.env === env && s.base.active).length, events: db.partner_changes.all((e) => e.env === env).length, last_sync: lastSync[env] || null }; }

module.exports = { PartnerError, snapshot, product, changes, sync, prune, entitled, entitlementChanged, simulate, resetSandbox, health, encodeCursor, decodeCursor, _lastSync: lastSync };
