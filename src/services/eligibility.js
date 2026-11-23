// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Delivery eligibility: whether each listing variant can be delivered to each country, by fulfilment route.
 *
 * Storage: collection `eligibility`, one document per listing × country (id "<listing>|<CC>"):
 *   { id, listing_id, country, v: { <mp_sku_id>: { <route>: record } } }
 * record: { state, origin, supplier, method, min_days, max_days, fee, currency, verified_at, expires_at, reason,
 *           attempts, next_retry_at, last_error }
 *
 * States: eligible · unavailable · over_limit · pending_verification. over_limit is worked out when read, from the stored
 * upper delivery estimate and the country's current limit (default 15 days), so changing a limit needs no new checks.
 * A record whose verification has expired reads as pending_verification.
 *
 * Routes: CJ and AliExpress variants are verified with the supplier (cj_direct, ae_direct) by a resumable background
 * queue. Other listings derive eligibility from the existing fulfilment rules, without supplier calls:
 *   kinan_warehouse / seller_direct — Kinan's zone price list (shipping.js) covers every market except Libya;
 *   banggood_direct — the countries in Banggood's own list (banggood/countries.js).
 * Libya (LY) has no eligible route in this release: its catalogue opens with the Libya market work.
 *
 * Enforcement is per market (settings "eligibility_config".markets: shadow | enforce). In shadow mode results are
 * collected and reported but the shop is not filtered. Rollback = set markets back to shadow (data is kept).
 */
const db = require('../db');
const { MARKETS, isMarket } = require('../countries');

const STATES = ['eligible', 'unavailable', 'over_limit', 'pending_verification'];
const SUPPLIER_ROUTES = { cj: 'cj_direct', aliexpress: 'ae_direct' };
const now = () => Date.now();
const DAY = 86400e3;
const CONFIG_ID = 'eligibility_config';
const STATE_ID = 'eligibility_state';

// ---------------- configuration ----------------
// default transit limit: 3 weeks (owner's rule, 23 Nov 2026)
const DEFAULTS = { default_max_days: 21, max_days: {}, ttl_days: { eligible: 14, unavailable: 7, over_limit: 7 }, markets: {}, batch: 40 };
function config() {
  const c = db.settings.get(CONFIG_ID) || {};
  return { ...DEFAULTS, ...c, max_days: { ...(c.max_days || {}) }, ttl_days: { ...DEFAULTS.ttl_days, ...(c.ttl_days || {}) }, markets: { ...(c.markets || {}) } };
}
const clampDays = (n) => Math.min(60, Math.max(1, Math.floor(Number(n))));
function saveConfig(b = {}) {
  const cur = config();
  const next = { ...cur };
  if (b.default_max_days !== undefined) next.default_max_days = clampDays(b.default_max_days) || 21;
  if (b.max_days && typeof b.max_days === 'object') {
    for (const [cc, v] of Object.entries(b.max_days)) {
      if (!isMarket(cc)) throw Object.assign(new Error(`Unknown country ${cc}`), { status: 400 });
      if (v === null || v === '') delete next.max_days[cc]; else next.max_days[cc] = clampDays(v);
    }
  }
  if (b.markets && typeof b.markets === 'object') {
    for (const [cc, mode] of Object.entries(b.markets)) {
      if (!isMarket(cc)) throw Object.assign(new Error(`Unknown country ${cc}`), { status: 400 });
      if (!['shadow', 'enforce'].includes(mode)) throw Object.assign(new Error('Mode must be shadow or enforce'), { status: 400 });
      next.markets[cc] = mode;
    }
  }
  if (b.rollback === true) for (const [cc] of MARKETS) next.markets[cc] = 'shadow';
  if (b.batch !== undefined) next.batch = Math.min(200, Math.max(1, Math.floor(Number(b.batch) || 40)));
  const doc = { id: CONFIG_ID, default_max_days: next.default_max_days, max_days: next.max_days, ttl_days: next.ttl_days, markets: next.markets, batch: next.batch };
  if (db.settings.get(CONFIG_ID)) db.settings.update(CONFIG_ID, doc); else db.settings.insert(doc);
  bump();
  return config();
}
const limitFor = (cc, c = config()) => Number(c.max_days[cc]) || c.default_max_days;
const modeOf = (cc, c = config()) => (c.markets[cc] === 'enforce' ? 'enforce' : 'shadow');
const enforced = (cc) => Boolean(cc) && isMarket(cc) && modeOf(cc) === 'enforce';
const anyEnforced = () => Object.values(config().markets).includes('enforce');

// ---------------- index over the stored documents ----------------
// db.<collection>.get() scans the whole list; the shop needs constant-time reads, so a Map mirrors the collection.
let index = null; let ver = 0;
function idx() {
  if (!index) { index = new Map(); for (const d of db.eligibility.all()) index.set(d.id, d); }
  return index;
}
const bump = () => { ver++; };
/**
 * Changes when what customers can buy changes: a variant's state flips, the configuration changes, a listing's data is
 * removed (part of the catalogue cache keys). Retry bookkeeping and same-state refreshes do not invalidate caches.
 */
const version = () => String(ver);
const docId = (listingId, cc) => `${listingId}|${cc}`;
function writeRecord(listingId, cc, skuId, route, rec) {
  const id = docId(listingId, cc);
  const cur = idx().get(id);
  const next = cur ? { ...cur, v: { ...cur.v, [skuId]: { ...(cur.v[skuId] || {}), [route]: rec } } } : { id, listing_id: listingId, country: cc, v: { [skuId]: { [route]: rec } } };
  const before = effective(cur?.v?.[skuId]?.[route], cc).state;
  const saved = cur ? db.eligibility.update(id, next) : db.eligibility.insert(next);
  idx().set(id, saved);
  if (effective(rec, cc).state !== before) bump();
  return rec;
}
const recordOf = (listingId, cc, skuId, route) => idx().get(docId(listingId, cc))?.v?.[skuId]?.[route] || null;
function removeListing(listingId) {
  for (const [id] of [...idx()]) if (id.startsWith(`${listingId}|`)) { db.eligibility.remove(id); idx().delete(id); }
  bump();
}

// ---------------- routes and states ----------------
function routeOf(l) {
  if (SUPPLIER_ROUTES[l.source]) return SUPPLIER_ROUTES[l.source];
  if (l.source === 'banggood') return 'banggood_direct';
  return l.fulfillment === 'seller' ? 'seller_direct' : 'kinan_warehouse';
}
const supplierOf = (l) => (l.source === 'cj' ? 'cj' : l.source === 'aliexpress' ? 'aliexpress' : null);
/** Routes decided by existing rules (no supplier call). */
function derived(l, cc) {
  if (cc === 'LY') return { state: 'unavailable', reason: 'market_not_open' };
  const route = routeOf(l);
  if (route === 'banggood_direct') {
    const { BANGGOOD_COUNTRIES } = require('../banggood/countries');
    return BANGGOOD_COUNTRIES[cc] ? { state: 'eligible', reason: 'banggood_country_list' } : { state: 'unavailable', reason: 'banggood_no_country' };
  }
  return { state: 'eligible', reason: 'kinan_zone_rates' };
}
/** The state a stored record has now (expiry and the current transit limit applied). */
function effective(rec, cc, at = now(), c = config()) {
  if (!rec || !rec.state) return { state: 'pending_verification', reason: 'not_checked' };
  if (rec.expires_at && rec.expires_at <= at) return { ...rec, state: 'pending_verification', reason: 'expired' };
  if (rec.state === 'eligible' || rec.state === 'over_limit') {
    if (!(Number(rec.max_days) > 0)) return { ...rec, state: 'pending_verification', reason: 'no_estimate' };
    return Number(rec.max_days) > limitFor(cc, c) ? { ...rec, state: 'over_limit', reason: 'transit_over_limit' } : { ...rec, state: 'eligible' };
  }
  return rec;
}
/** State of one raw variant for a country. */
function variantState(l, sku, cc, at = now(), c = config()) {
  if (cc === 'LY') return { state: 'unavailable', reason: 'market_not_open' };
  if (!supplierOf(l)) return derived(l, cc);
  return effective(recordOf(l.id, cc, sku.mp_sku_id, routeOf(l)), cc, at, c);
}
/**
 * Raw variants a customer in `cc` may buy: in stock and eligible. null = this market is not enforced (shop unchanged).
 */
function eligibleSkus(l, cc, { force = false } = {}) {
  if (!cc || (!force && !enforced(cc))) return null;
  const c = config(); const at = now();
  return (l.skus || []).filter((s) => s.stock > 0 && variantState(l, s, cc, at, c).state === 'eligible');
}
/** The listing as seen in a market: same record, only the buyable variants. null when nothing can be bought there. */
function forMarket(l, cc) {
  const skus = eligibleSkus(l, cc);
  if (skus === null) return l;
  return skus.length ? { ...l, skus } : null;
}
/** Why a listing cannot be bought in a market (for direct links and the cart). */
function reasonFor(l, cc) {
  if (cc === 'LY') return 'market_not_open';
  const inStock = (l.skus || []).filter((s) => s.stock > 0);
  if (!inStock.length) return 'out_of_stock';
  const c = config(); const at = now();
  const states = inStock.map((s) => variantState(l, s, cc, at, c).state);
  if (states.includes('eligible')) return null;
  if (states.includes('pending_verification')) return 'pending_verification';
  if (states.includes('over_limit')) return 'over_limit';
  return 'unavailable';
}
/** One cart line in a market: { ok } or { ok:false, reason }. */
function lineStatus(l, skuId, cc) {
  if (!enforced(cc)) return { ok: true };
  const sku = (l.skus || []).find((s) => s.mp_sku_id === skuId);
  if (!sku) return { ok: false, reason: 'variant_not_found' };
  const group = require('./shipsFrom').siblings(l, sku);
  const c = config(); const at = now();
  if (group.some((s) => s.stock > 0 && variantState(l, s, cc, at, c).state === 'eligible')) return { ok: true };
  const st = variantState(l, sku, cc, at, c);
  return { ok: false, reason: sku.stock > 0 ? (st.state === 'eligible' ? 'unavailable' : st.state === 'pending_verification' ? 'pending_verification' : st.state) : 'out_of_stock' };
}

// ---------------- verification (supplier calls) ----------------
class SupplierError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
/** Temporary failures never overwrite a valid result: auth, timeout, malformed, throttled, quota. */
function classify(e, supplier) {
  if (e instanceof SupplierError) return e.kind;
  const m = String(e?.message || e || '');
  if (e?.code === 'POINTS' || e?.code === 'BUDGET' || /points|background limit/i.test(m)) return 'quota';
  if (e?.status === 429 || /too many|frequen|throttl|rate limit|ApiCallLimit|busy/i.test(m)) return 'throttled';
  if (e?.status === 401 || e?.status === 403 || /token|unauthori|auth|not connected|sign in|session/i.test(m)) return 'auth';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|timed out|ETIMEDOUT|ECONNRESET|stopped answering/i.test(m)) return 'timeout';
  return supplier ? 'error' : 'error';
}
/** Best option within reach: { state, method, min_days, max_days, fee, origin } from a list of supplier options. */
function decide(options, cc, origin) {
  const opts = (options || []).filter((o) => o && o.method !== undefined);
  if (!opts.length) return { state: 'unavailable', reason: 'no_route' };
  const lim = limitFor(cc);
  const known = opts.filter((o) => Number(o.max) > 0);
  if (!known.length) return { state: 'eligible', reason: 'no_estimate', method: opts[0].method, fee: opts[0].fee ?? null, origin, max_days: null, min_days: null };
  const within = known.filter((o) => o.max <= lim).sort((a, b) => a.fee - b.fee || a.max - b.max);
  const best = within[0] || [...known].sort((a, b) => a.max - b.max || a.fee - b.fee)[0];
  return { state: within.length ? 'eligible' : 'over_limit', reason: within.length ? 'verified' : 'transit_over_limit', method: best.method, fee: best.fee ?? null, origin, min_days: Number(best.min) || Number(best.max), max_days: Number(best.max) };
}
const VERIFIERS = {
  async cj(l, sku, cc) {
    const cj = require('./cj');
    if (!sku.cj_vid) throw new SupplierError('error', 'variant has no CJ id');
    const from = l.cj_from || 'CN';
    const storage = [...new Set(l.skus.filter((k) => k.cj_vid === sku.cj_vid).flatMap((k) => k.cj_storage || []))];
    let opts = await cj.freightOptions(cc, [{ vid: sku.cj_vid, qty: 1 }], from);
    let origin = from;
    if (!opts.length && storage.length) opts = await cj.freightOptions(cc, [{ vid: sku.cj_vid, qty: 1 }], from, storage);
    if (!opts.length && from !== 'CN') { opts = await cj.freightOptions(cc, [{ vid: sku.cj_vid, qty: 1 }], 'CN'); origin = 'CN'; }
    return { options: opts.map((o) => ({ method: o.method, fee: o.fee, min: o.min, max: o.max })), origin, currency: 'USD' };
  },
  async aliexpress(l, sku, cc) {
    if (!l.ae_product_id || !sku.ae_sku_id) throw new SupplierError('error', 'variant has no AliExpress id');
    const { supplierCode } = require('../countries');
    const o = await require('./aeSourcing').freight(l.ae_product_id, sku.ae_sku_id, supplierCode('aliexpress', cc));
    return { options: o ? [{ method: o.method, fee: o.fee, min: o.min, max: o.days }] : [], origin: o?.from || null, currency: String(require('../config').config.currency || 'usd').toUpperCase() };
  }
};
/** Tests swap the supplier calls for mocks. */
const _setVerifier = (supplier, fn) => { VERIFIERS[supplier] = fn; };

function runState() { return db.settings.get(STATE_ID) || { id: STATE_ID, paused: {}, stats: {} }; }
function saveState(patch) { const cur = runState(); const doc = { ...cur, ...patch, id: STATE_ID }; if (db.settings.get(STATE_ID)) db.settings.update(STATE_ID, doc); else db.settings.insert(doc); return doc; }
function pauseSupplier(supplier, kind, message) {
  const until = kind === 'quota' && supplier === 'cj' ? (() => { try { return require('../cj/client').retryAt(); } catch { return now() + 20 * 60e3; } })()
    : kind === 'auth' ? now() + 3600e3 : kind === 'throttled' ? now() + 2 * 60e3 : now() + 10 * 60e3;
  const st = runState();
  saveState({ paused: { ...(st.paused || {}), [supplier]: { until, kind, message: String(message || '').slice(0, 160), at: now() } } });
}
const supplierPaused = (supplier) => { const p = runState().paused?.[supplier]; return p && p.until > now() ? p : null; };

/** Check one variant × country with the supplier and store the outcome. */
async function verifyOne(l, sku, cc) {
  const supplier = supplierOf(l); const route = routeOf(l);
  const prev = recordOf(l.id, cc, sku.mp_sku_id, route);
  const c = config(); const ttl = c.ttl_days;
  try {
    const r = await VERIFIERS[supplier](l, sku, cc);
    const d = decide(r.options, cc, r.origin);
    const life = (ttl[d.state] || 7) * DAY;
    return writeRecord(l.id, cc, sku.mp_sku_id, route, {
      state: d.state === 'eligible' || d.state === 'over_limit' ? (d.max_days ? 'eligible' : 'pending_verification') : d.state,
      reason: d.reason, supplier, origin: d.origin || null, method: d.method || null, min_days: d.min_days ?? null, max_days: d.max_days ?? null,
      fee: d.fee ?? null, currency: r.currency || null, verified_at: now(), expires_at: now() + life, attempts: 0, next_retry_at: d.max_days || d.state === 'unavailable' ? now() + life - DAY : now() + DAY, last_error: null
    });
  } catch (e) {
    const kind = classify(e, supplier);
    const attempts = (prev?.attempts || 0) + 1;
    const backoff = Math.min(24 * 3600e3, 15 * 60e3 * 2 ** Math.min(6, attempts - 1));
    // keep the last valid answer until it expires; only the retry bookkeeping changes
    writeRecord(l.id, cc, sku.mp_sku_id, route, { ...(prev || { state: null }), attempts, next_retry_at: now() + backoff, last_error: { kind, message: String(e.message || e).slice(0, 160), at: now() } });
    if (['quota', 'throttled', 'auth'].includes(kind)) pauseSupplier(supplier, kind, e.message);
    return { error: kind };
  }
}

/** Countries in checking order: enforced markets, then the ones customers choose most, then the rest. Libya waits. */
function marketOrder() {
  const c = config(); const demand = runState().demand || {};
  return MARKETS.map(([cc]) => cc).filter((cc) => cc !== 'LY')
    .sort((a, b) => (modeOf(b, c) === 'enforce') - (modeOf(a, c) === 'enforce') || (demand[b] || 0) - (demand[a] || 0) || a.localeCompare(b));
}
/** A customer confirmed a delivery country: it moves up the checking order. */
function noteDemand(cc) {
  if (!isMarket(cc)) return;
  const st = runState(); const demand = { ...(st.demand || {}) }; demand[cc] = (demand[cc] || 0) + 1;
  saveState({ demand });
}
const due = (rec, at) => !rec || !rec.state || (rec.next_retry_at || 0) <= at || (rec.expires_at || 0) <= at + DAY;
/**
 * The next checks to run. Per market: first one variant (the cheapest in stock) of each listing with no eligible
 * variant yet, so a listing can appear as soon as one variant passes; then the remaining variants.
 */
function nextTasks(limit) {
  const at = now(); const out = []; const c = config();
  const live = db.listings.all((l) => ['active', 'private'].includes(l.status) && supplierOf(l)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const cc of marketOrder()) {
    const second = [];
    for (const l of live) {
      if (supplierPaused(supplierOf(l))) continue;
      const route = routeOf(l);
      const stocked = l.skus.filter((s) => s.stock > 0).sort((a, b) => a.price - b.price);
      if (!stocked.length) continue;
      const hasEligible = stocked.some((s) => effective(recordOf(l.id, cc, s.mp_sku_id, route), cc, at, c).state === 'eligible');
      for (const [i, s] of stocked.entries()) {
        if (!due(recordOf(l.id, cc, s.mp_sku_id, route), at)) continue;
        (i === 0 && !hasEligible ? out : second).push({ l, sku: s, cc });
        if (out.length >= limit) return out;
      }
    }
    for (const t of second) { out.push(t); if (out.length >= limit) return out; }
  }
  return out;
}

let running = false; const inFlight = new Set();
const CONCURRENCY = { cj: 1, aliexpress: 2 };
/** One bounded pass of the queue (scheduled every few minutes, and from Admin). Safe to call while one runs. */
async function tick({ limit } = {}) {
  if (running) return { skipped: 'running' };
  running = true;
  const stats = { checked: 0, eligible: 0, unavailable: 0, over_limit: 0, pending: 0, errors: {}, started_at: now() };
  try {
    const tasks = nextTasks(Math.min(500, limit || config().batch));
    const queues = { cj: [], aliexpress: [] };
    for (const t of tasks) queues[supplierOf(t.l)].push(t);
    const worker = async (supplier) => {
      while (queues[supplier].length) {
        if (supplierPaused(supplier)) { queues[supplier].length = 0; break; }
        const t = queues[supplier].shift();
        const key = `${t.l.id}|${t.sku.mp_sku_id}|${t.cc}`;
        if (inFlight.has(key)) continue;
        inFlight.add(key);
        try {
          const fresh = db.listings.get(t.l.id);
          if (!fresh) continue;
          const sku = fresh.skus.find((s) => s.mp_sku_id === t.sku.mp_sku_id) || t.sku;
          const r = await verifyOne(fresh, sku, t.cc);
          stats.checked++;
          if (r.error) stats.errors[r.error] = (stats.errors[r.error] || 0) + 1;
          else { const e = effective(r, t.cc).state; stats[e === 'pending_verification' ? 'pending' : e] = (stats[e === 'pending_verification' ? 'pending' : e] || 0) + 1; }
        } finally { inFlight.delete(key); }
      }
    };
    const runOne = () => Promise.all(Object.entries(CONCURRENCY).flatMap(([s, n]) => Array.from({ length: n }, () => worker(s))));
    try { await require('../cj/client').background(runOne); } catch { await runOne(); }
  } finally {
    running = false;
    stats.finished_at = now();
    saveState({ stats });
  }
  return stats;
}

// ---------------- legacy results (shadow backfill) ----------------
/**
 * Results saved before this feature, reused only where they establish the specific variant and country:
 * CJ — cj_ship[CC] names the variant (vid) it was quoted for; AliExpress — the import verified one option (sku), so
 * sourcing.delivery_by_country / gb_days / eu_days (Germany) apply to that option when the listing has only that one.
 */
function legacyFor(l, at = now()) {
  const out = []; const route = routeOf(l); const ttl = config().ttl_days;
  if (l.source === 'cj') {
    for (const [cc, k] of Object.entries(l.cj_ship || {})) {
      if (!isMarket(cc) || !k || !k.vid || (k.estimated && !k.none)) continue;
      const life = (k.none ? ttl.unavailable : ttl.eligible) * DAY;
      if (at - k.at >= life) continue;
      for (const s of l.skus.filter((x) => x.cj_vid === k.vid)) {
        out.push({ cc, sku: s, route, rec: k.none ? { state: 'unavailable', reason: 'no_route' } : k.max ? { state: 'eligible', reason: 'verified', min_days: k.min || k.max, max_days: k.max, fee: k.fee } : null, at: k.at, life });
      }
    }
  } else if (l.source === 'aliexpress') {
    const so = l.sourcing || {}; const ids = new Set(l.skus.map((s) => s.ae_sku_id || s.mp_sku_id));
    if (ids.size !== 1 || !so.at) return out;
    const quotes = so.delivery_by_country || { ...(so.gb_days ? { GB: { min: so.gb_min, days: so.gb_days, fee: so.gb_fee } } : {}), ...(so.eu_days ? { DE: { min: so.eu_min, days: so.eu_days, fee: so.eu_fee } } : {}) };
    const life = ttl.eligible * DAY;
    if (at - so.at >= life) return out;
    for (const [cc, q] of Object.entries(quotes)) {
      if (!isMarket(cc) || !(Number(q?.days) > 0)) continue;
      for (const s of l.skus) out.push({ cc, sku: s, route, rec: { state: 'eligible', reason: 'verified', min_days: Number(q.min) || Number(q.days), max_days: Number(q.days), fee: q.fee ?? null }, at: so.at, life });
    }
  }
  return out.filter((x) => x.rec);
}
/** Writes legacy results for variants that have no record yet (never overwrites a newer check). */
function backfill({ apply = false } = {}) {
  const at = now(); let reusable = 0; let written = 0;
  for (const l of db.listings.all((x) => ['active', 'private', 'paused'].includes(x.status) && supplierOf(x))) {
    for (const x of legacyFor(l, at)) {
      const cur = recordOf(l.id, x.cc, x.sku.mp_sku_id, x.route);
      if (cur && cur.state && (cur.verified_at || 0) >= x.at) continue;
      reusable++;
      if (apply) { writeRecord(l.id, x.cc, x.sku.mp_sku_id, x.route, { ...x.rec, supplier: supplierOf(l), origin: null, method: 'legacy', currency: 'USD', verified_at: x.at, expires_at: x.at + x.life, attempts: 0, next_retry_at: x.at + x.life - DAY, last_error: null, legacy: true }); written++; }
    }
  }
  if (apply) saveState({ backfill: { at, written } });
  return { reusable, written, applied: apply, report: report() };
}

// ---------------- reports (Admin) ----------------
/** Listings that the shop shows today (status, shop, existing CJ no-delivery rule), for the projection. */
function liveListings() {
  const active = new Set(db.sellers.all((s) => s.status === 'active').map((s) => s.id));
  return db.listings.all((l) => l.status === 'active' && active.has(l.seller_id));
}
const supplierLabel = (l) => (l.source === 'cj' ? 'cj' : l.source === 'aliexpress' ? 'aliexpress' : l.source === 'banggood' ? 'banggood' : 'kinan');
/** Counts by country and supplier: available, unavailable, over_limit, pending (listing level, in-stock variants). */
function report() {
  const c = config(); const at = now(); const live = liveListings(); const st = runState();
  const markets = MARKETS.map(([cc, name, , region]) => {
    const row = { country: cc, name, region, mode: modeOf(cc, c), max_days: limitFor(cc, c), demand: st.demand?.[cc] || 0, totals: { listed_now: 0, available: 0, unavailable: 0, over_limit: 0, pending: 0 }, by_supplier: {} };
    for (const l of live) {
      const sup = supplierLabel(l);
      const b = row.by_supplier[sup] || (row.by_supplier[sup] = { available: 0, unavailable: 0, over_limit: 0, pending: 0 });
      if (!(l.source === 'cj' && require('./cj').noDelivery(l, cc))) row.totals.listed_now++;
      const why = reasonFor(l, cc);
      const k = !why ? 'available' : why === 'over_limit' ? 'over_limit' : why === 'pending_verification' ? 'pending' : 'unavailable';
      row.totals[k]++; b[k]++;
    }
    return row;
  });
  return { generated_at: at, default_max_days: c.default_max_days, markets, paused: st.paused || {}, last_run: st.stats || null, backfill: st.backfill || null, running };
}
/** Variant-level detail of one listing: reasons, last verification, next retry. */
function detail(listingId) {
  const l = db.listings.get(listingId);
  if (!l) throw Object.assign(new Error('Product not found'), { status: 404 });
  const c = config(); const at = now(); const route = routeOf(l);
  const rows = [];
  for (const [cc] of MARKETS) {
    for (const s of l.skus) {
      const rec = supplierOf(l) ? recordOf(l.id, cc, s.mp_sku_id, route) : null;
      const e = variantState(l, s, cc, at, c);
      rows.push({ country: cc, variant: s.mp_sku_id, props: s.props || '', in_stock: s.stock > 0, route, state: e.state, reason: e.reason || null, max_days: rec?.max_days ?? null, fee: rec?.fee ?? null, method: rec?.method || null, verified_at: rec?.verified_at || null, expires_at: rec?.expires_at || null, next_retry_at: rec?.next_retry_at || null, last_error: rec?.last_error || null });
    }
  }
  return { id: l.id, title: l.title, source: l.source, route, rows };
}
/** Admin: check these listings again soon, through the same queue (bounded). */
function retry({ listing_ids = [], country = null } = {}) {
  const ids = [...new Set((Array.isArray(listing_ids) ? listing_ids : [listing_ids]).map(String))].slice(0, 50);
  if (country && !isMarket(country)) throw Object.assign(new Error('Unknown country'), { status: 400 });
  let n = 0;
  for (const id of ids) {
    const l = db.listings.get(id); if (!l || !supplierOf(l)) continue;
    const route = routeOf(l);
    for (const [cc] of MARKETS) {
      if (country && cc !== country) continue;
      for (const s of l.skus) {
        const rec = recordOf(l.id, cc, s.mp_sku_id, route);
        if (rec) { writeRecord(l.id, cc, s.mp_sku_id, route, { ...rec, next_retry_at: 0 }); n++; }
      }
    }
  }
  return { queued: n, listings: ids.length };
}

module.exports = {
  STATES, config, saveConfig, limitFor, modeOf, enforced, anyEnforced, version, routeOf, variantState, eligibleSkus, forMarket, reasonFor, lineStatus,
  classify, decide, verifyOne, tick, nextTasks, noteDemand, backfill, legacyFor, report, detail, retry, removeListing, writeRecord, recordOf,
  _setVerifier, _reset: () => { index = null; ver++; }, SupplierError
};
