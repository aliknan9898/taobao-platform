// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Libya market (LY): its own catalogue, prices in Libyan dinars, cities and service areas, local stock with atomic
 * reservations, cash on delivery and settlement, kept apart from the shared product records.
 *
 * Collections (table kinan_docs, no schema migration):
 *   ly_offers     — what Libya sells: own Arabic copy, photos, LYD prices, route (local · china · direct), status,
 *                   optional link to a shared product (product_id / variant sku_ref) and seller. History of changes.
 *   ly_cities     — cities with aliases, service areas and route coverage (fees, delivery estimates, COD, carrier).
 *   ly_locations  — stock locations in Libya (Kinan's, or a seller's).
 *   ly_stock      — available / reserved per offer variant × location ("<offer>|<variant>|<location>").
 *   ly_moves      — every stock adjustment with its reason and actor.
 *   ly_reservations — stock held for an order: active → consumed (dispatched) or released (cancelled / expired), once.
 *   ly_orders     — Libya orders in LYD, with the price and quote breakdown, independent delivery, payment and
 *                   settlement statuses, and an event log (updates are idempotent by event key).
 *   ly_cash       — cash on delivery: expected, collected, remitted (idempotent by key), carrier fees, references.
 *   ly_returns    — returns with inspection; only approved units go back to sellable stock, once.
 *
 * Kept out of the shared order flows on purpose (Stripe, supplier ordering, payouts, the China warehouse jobs read
 * db.orders): a Libya order can never trigger a card charge or a supplier order by accident. Libya stays switched off
 * for customers (settings "ly_market".enabled) until the owner opens it.
 */
const db = require('../db');

const LY = 'LY';
const now = () => Date.now();
const lyd = (n) => Math.round(Number(n || 0) * 1000) / 1000;
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const list = (v) => (Array.isArray(v) ? v : []);
const ROUTES = ['local', 'china', 'direct'];
const ROUTE_LABEL = { local: { ar: 'متوفر داخل ليبيا', en: 'In stock in Libya' }, china: { ar: 'يُشحن من الصين', en: 'Ships from China' }, direct: { ar: 'شحن مباشر من المورد', en: 'Ships direct from the supplier' } };

// ---------------- market settings ----------------
const CFG = 'ly_market';
const DEFAULTS = {
  enabled: false,             // customers can see and buy (owner switch)
  online_payment: false,      // only after a payment provider is verified for Libya
  cod: true,                  // cash on delivery where an area/route/carrier allows it
  cod_imported: false,        // COD for China / direct orders: off unless the owner enables an explicit policy
  cod_max_lyd: 3000,
  reservation_hours: 48,      // unconfirmed orders release their stock after this
  route_limits: { local: { max_days: 7, apply: false }, china: { max_days: 30, apply: true }, direct: { max_days: 21, apply: true } }
};
function config() {
  const c = db.settings.get(CFG) || {};
  return { ...DEFAULTS, ...c, route_limits: Object.fromEntries(ROUTES.map((r) => [r, { ...DEFAULTS.route_limits[r], ...((c.route_limits || {})[r] || {}) }])) };
}
function saveConfig(b = {}) {
  const cur = config(); const next = { ...cur };
  for (const k of ['enabled', 'online_payment', 'cod', 'cod_imported']) if (b[k] !== undefined) next[k] = b[k] === true;
  if (b.cod_max_lyd !== undefined) next.cod_max_lyd = Math.max(0, lyd(b.cod_max_lyd));
  if (b.reservation_hours !== undefined) next.reservation_hours = Math.min(720, Math.max(1, Math.floor(Number(b.reservation_hours) || 48)));
  if (b.route_limits && typeof b.route_limits === 'object') {
    for (const r of ROUTES) if (b.route_limits[r]) next.route_limits[r] = { max_days: Math.min(90, Math.max(1, Math.floor(Number(b.route_limits[r].max_days) || cur.route_limits[r].max_days))), apply: b.route_limits[r].apply === true };
  }
  const doc = { id: CFG, ...next };
  if (db.settings.get(CFG)) db.settings.update(CFG, doc); else db.settings.insert(doc);
  return config();
}
const open = () => config().enabled === true;

// ---------------- permissions ----------------
/**
 * Libya functions: catalog (offers, collections, content, prices), stock (locations, stock, receiving), orders
 * (orders, delivery, returns), coverage (cities, areas, routes), finance (margins, COD settlement, refunds, payment
 * configuration, financial exports). Owner: all. Finance staff: finance + orders. Admin staff: all but finance.
 * Libya staff (role ly_staff): only what the owner granted them (ly_perms), and nothing outside Libya.
 */
const FUNCS = ['catalog', 'stock', 'orders', 'coverage', 'finance'];
const ROLE_FUNCS = { admin: ['catalog', 'stock', 'orders', 'coverage'], procurement: ['catalog', 'stock'], warehouse: ['stock', 'orders'], support: ['orders'], finance: ['finance', 'orders'] };
function funcsOf(user) {
  if (!user) return [];
  if (user.owner) return [...FUNCS];
  if (user.role === 'ly_staff') return list(db.users.get(user.id)?.ly_perms).filter((f) => FUNCS.includes(f));
  return ROLE_FUNCS[user.role] || [];
}
function need(user, fn) { if (!funcsOf(user).includes(fn)) throw httpError(403, `Your account has no Libya ${fn} access`); }

// ---------------- history and audit ----------------
function changed(before, after, keys) {
  const out = {};
  for (const k of keys) if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) out[k] = { from: before?.[k] ?? null, to: after?.[k] ?? null };
  return out;
}
const actorOf = (user) => (user ? { id: user.id, email: user.email || null, role: user.role, owner: Boolean(user.owner) } : { id: 'system' });
/** A change of price, stock, visibility, coverage, order status or settlement: kept in the shared audit log too. */
function note(user, kind, ref, detail) {
  try { db.audit.insert({ at: now(), method: 'LY', path: `/libya/${kind}`, params: { ref }, status: 200, actor: actorOf(user), fields: Object.keys(detail || {}).slice(0, 30), libya: { kind, ref, detail } }); } catch { /* never block the change */ }
}

// ---------------- cities, areas, coverage ----------------
const cityIndex = () => db.ly_cities.all();
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ');
function findCity(idOrName) {
  const v = norm(idOrName);
  return cityIndex().find((c) => c.id === idOrName || norm(c.name_ar) === v || norm(c.name_en) === v || list(c.aliases).some((a) => norm(a) === v)) || null;
}
function routeCfg(c, route) {
  const r = (c.routes || {})[route] || {};
  return { enabled: r.enabled === true, fee_lyd: lyd(r.fee_lyd), min_days: Number(r.min_days) || null, max_days: Number(r.max_days) || null, cod: r.cod === true, cod_max_lyd: r.cod_max_lyd != null ? lyd(r.cod_max_lyd) : null,
    verified: r.verified === true, includes: str(r.includes, 300), due_on_delivery_lyd: lyd(r.due_on_delivery_lyd), due_on_delivery_note: str(r.due_on_delivery_note, 200), locations: list(r.locations), carrier: str(r.carrier, 60) };
}
function saveCity(user, b = {}, id = null) {
  need(user, 'coverage');
  const cur = id ? db.ly_cities.get(id) : null;
  if (id && !cur) throw httpError(404, 'City not found');
  const name_ar = str(b.name_ar ?? cur?.name_ar, 80); const name_en = str(b.name_en ?? cur?.name_en, 80);
  if (!name_ar || !name_en) throw httpError(400, 'Enter the city name in Arabic and English');
  const areas = b.areas !== undefined ? list(b.areas).slice(0, 200).map((a) => ({ id: str(a.id, 40) || db.id('lya'), name_ar: str(a.name_ar, 80), name_en: str(a.name_en, 80), aliases: list(a.aliases).map((x) => str(x, 60)).filter(Boolean).slice(0, 20), cod: a.cod !== false, active: a.active !== false })).filter((a) => a.name_ar || a.name_en) : cur?.areas || [];
  const routes = {};
  for (const r of ROUTES) {
    const x = (b.routes || {})[r] ?? cur?.routes?.[r];
    if (!x) continue;
    if (x.min_days && x.max_days && Number(x.min_days) > Number(x.max_days)) throw httpError(400, `${r}: the fastest delivery cannot be after the slowest`);
    routes[r] = { enabled: x.enabled === true, fee_lyd: Math.max(0, lyd(x.fee_lyd)), min_days: Math.max(0, Math.floor(Number(x.min_days) || 0)) || null, max_days: Math.max(0, Math.floor(Number(x.max_days) || 0)) || null, cod: x.cod === true, cod_max_lyd: x.cod_max_lyd === '' || x.cod_max_lyd == null ? null : Math.max(0, lyd(x.cod_max_lyd)),
      verified: x.verified === true, includes: str(x.includes, 300), due_on_delivery_lyd: Math.max(0, lyd(x.due_on_delivery_lyd)), due_on_delivery_note: str(x.due_on_delivery_note, 200), locations: list(x.locations).map(String).slice(0, 50), carrier: str(x.carrier, 60) };
  }
  const doc = { name_ar, name_en, aliases: b.aliases !== undefined ? list(b.aliases).map((x) => str(x, 60)).filter(Boolean).slice(0, 30) : cur?.aliases || [], areas, routes, require_pin: b.require_pin !== undefined ? b.require_pin === true : Boolean(cur?.require_pin), active: b.active !== undefined ? b.active !== false : cur ? cur.active !== false : true, carrier_ref: str(b.carrier_ref ?? cur?.carrier_ref, 80) };
  const saved = cur ? db.ly_cities.update(id, doc) : db.ly_cities.insert(doc);
  note(user, 'coverage', saved.id, changed(cur, saved, ['routes', 'areas', 'active', 'require_pin']));
  return saved;
}
function publicCities() {
  return cityIndex().filter((c) => c.active !== false).map((c) => ({
    id: c.id, name_ar: c.name_ar, name_en: c.name_en, require_pin: Boolean(c.require_pin),
    areas: list(c.areas).filter((a) => a.active !== false).map((a) => ({ id: a.id, name_ar: a.name_ar, name_en: a.name_en })),
    routes: Object.fromEntries(ROUTES.map((r) => [r, routeCfg(c, r)]).filter(([, x]) => x.enabled).map(([r, x]) => [r, { fee_lyd: x.fee_lyd, min_days: x.min_days, max_days: x.max_days, includes: x.includes, due_on_delivery_lyd: x.due_on_delivery_lyd, due_on_delivery_note: x.due_on_delivery_note }]))
  })).sort((a, b) => a.name_ar.localeCompare(b.name_ar, 'ar'));
}
/** Is this route usable for a city: enabled, verified when imported, and within its delivery limit when the policy applies. */
function routeOk(c, route) {
  const r = routeCfg(c, route); const lim = config().route_limits[route];
  if (!r.enabled) return { ok: false, reason: 'route_not_covered' };
  if (route !== 'local' && !r.verified) return { ok: false, reason: 'route_not_verified' };
  if (!r.max_days) return { ok: false, reason: 'no_estimate' };
  if (lim.apply && r.max_days > lim.max_days) return { ok: false, reason: 'over_limit' };
  return { ok: true, r };
}

// ---------------- locations and stock ----------------
function saveLocation(user, b = {}, id = null) {
  need(user, 'stock');
  const cur = id ? db.ly_locations.get(id) : null;
  if (id && !cur) throw httpError(404, 'Location not found');
  const name = str(b.name ?? cur?.name, 80); if (!name) throw httpError(400, 'Name the stock location');
  const city = findCity(b.city_id ?? cur?.city_id); if (!city) throw httpError(400, 'Choose the location\'s city');
  const seller_id = b.seller_id !== undefined ? (b.seller_id ? str(b.seller_id, 40) : null) : cur?.seller_id || null;
  if (seller_id && !db.sellers.get(seller_id)) throw httpError(400, 'Unknown seller');
  const doc = { name, city_id: city.id, kind: seller_id ? 'seller' : 'kinan', seller_id, active: b.active !== undefined ? b.active !== false : cur ? cur.active !== false : true };
  return cur ? db.ly_locations.update(id, doc) : db.ly_locations.insert(doc);
}
const stockId = (offerId, variantId, locId) => `${offerId}|${variantId}|${locId}`;
const stockOf = (offerId, variantId, locId) => db.ly_stock.get(stockId(offerId, variantId, locId)) || { id: stockId(offerId, variantId, locId), offer_id: offerId, variant_id: variantId, location_id: locId, available: 0, reserved: 0 };
const free = (s) => Math.max(0, (s.available || 0) - (s.reserved || 0));
/** Stock adjustment with a reason (receiving, count, damage, return…). Recorded in ly_moves and the audit log. */
function adjustStock(user, { offer_id, variant_id, location_id, delta, reason }) {
  need(user, 'stock');
  const o = db.ly_offers.get(offer_id); if (!o) throw httpError(404, 'Offer not found');
  if (!list(o.variants).some((v) => v.id === variant_id)) throw httpError(404, 'Variant not found');
  const loc = db.ly_locations.get(location_id); if (!loc) throw httpError(404, 'Location not found');
  const d = Math.trunc(Number(delta));
  if (!d || Math.abs(d) > 100000) throw httpError(400, 'Enter how many units to add or remove');
  const why = str(reason, 200); if (!why) throw httpError(400, 'Give a reason for the stock change');
  return applyMove(user, { offer_id, variant_id, location_id, delta: d, reason: why });
}
function applyMove(user, { offer_id, variant_id, location_id, delta, reason, ref = null }) {
  const s = stockOf(offer_id, variant_id, location_id);
  const next = { ...s, available: (s.available || 0) + delta };
  if (next.available < (next.reserved || 0)) throw httpError(409, `Only ${free(s)} unreserved units can be removed`);
  const saved = db.ly_stock.get(s.id) ? db.ly_stock.update(s.id, next) : db.ly_stock.insert(next);
  db.ly_moves.insert({ stock_id: s.id, offer_id, variant_id, location_id, delta, reason, ref, at: now(), actor: actorOf(user) });
  note(user, 'stock', s.id, { delta, reason, available: saved.available });
  return saved;
}
/** Units free to sell for a variant in a city (locations serving that city's local route, or every location). */
function localFree(o, v, city) {
  const r = city ? routeCfg(city, 'local') : null;
  const locs = db.ly_locations.all((l) => l.active !== false && (!r || !r.locations.length || r.locations.includes(l.id)));
  return locs.map((l) => ({ loc: l, free: free(stockOf(o.id, v.id, l.id)) }));
}

// ---------------- offers ----------------
const OFFER_KEYS = ['status', 'route', 'title_ar', 'title_en', 'variants', 'featured', 'collections', 'category', 'images', 'approved_content', 'china', 'direct'];
function cleanVariants(vs, cur = []) {
  const out = list(vs).slice(0, 100).map((v) => {
    const prev = cur.find((x) => x.id === v.id) || {};
    return { id: prev.id || str(v.id, 40) || db.id('lyv'), props: str(v.props ?? prev.props, 120) || 'Standard', price_lyd: v.price_lyd !== undefined ? lyd(v.price_lyd) : prev.price_lyd || 0,
      cost_lyd: v.cost_lyd !== undefined ? lyd(v.cost_lyd) : prev.cost_lyd ?? null, sku_ref: v.sku_ref !== undefined ? str(v.sku_ref, 60) || null : prev.sku_ref || null,
      weight_kg: v.weight_kg !== undefined ? Math.max(0, Number(v.weight_kg) || 0) : prev.weight_kg || 0, active: v.active !== undefined ? v.active !== false : prev.active !== false };
  });
  if (out.some((v) => v.price_lyd < 0)) throw httpError(400, 'Prices cannot be negative');
  return out;
}
/** Create a Libya-only offer, or attach an existing shared product (product_id) to Libya. Always starts as a draft. */
function saveOffer(user, b = {}, id = null) {
  need(user, 'catalog');
  const cur = id ? db.ly_offers.get(id) : null;
  if (id && !cur) throw httpError(404, 'Offer not found');
  const canCost = funcsOf(user).includes('finance');
  const product_id = b.product_id !== undefined ? (b.product_id ? str(b.product_id, 40) : null) : cur?.product_id || null;
  const shared = product_id ? db.listings.get(product_id) : null;
  if (product_id && !shared) throw httpError(400, 'Unknown shared product');
  const route = b.route !== undefined ? str(b.route, 10) : cur?.route || 'local';
  if (!ROUTES.includes(route)) throw httpError(400, 'Route must be local, china or direct');
  let variants = b.variants !== undefined ? cleanVariants(b.variants, cur?.variants || []) : cur?.variants || (shared ? cleanVariants(shared.skus.map((s) => ({ props: s.props, sku_ref: s.mp_sku_id, weight_kg: shared.weight_kg || 0 }))) : []);
  // margins (cost) are only for the owner and authorised finance staff: other editors keep what is stored
  if (!canCost) variants = variants.map((v) => ({ ...v, cost_lyd: (cur?.variants || []).find((x) => x.id === v.id)?.cost_lyd ?? null }));
  const doc = {
    market: LY, route, product_id, seller_id: b.seller_id !== undefined ? (b.seller_id ? str(b.seller_id, 40) : null) : cur?.seller_id || shared?.seller_id || null,
    title_ar: str(b.title_ar ?? cur?.title_ar ?? shared?.title_ar, 200), title_en: str(b.title_en ?? cur?.title_en ?? shared?.title, 200),
    description_ar: str(b.description_ar ?? cur?.description_ar ?? shared?.description_ar, 5000), description_en: str(b.description_en ?? cur?.description_en ?? shared?.description, 5000),
    images: b.images !== undefined ? list(b.images).map((u) => str(u, 600)).filter((u) => /^https:\/\//.test(u)).slice(0, 12) : cur?.images || (shared ? list(shared.images).slice(0, 12) : []),
    category: str(b.category ?? cur?.category ?? shared?.category ?? 'other', 40), collections: b.collections !== undefined ? list(b.collections).map((x) => str(x, 40)).filter(Boolean).slice(0, 10) : cur?.collections || [],
    featured: b.featured !== undefined ? b.featured === true : Boolean(cur?.featured), variants,
    status: cur?.status || 'draft', approved_content: cur?.approved_content || false,
    china: cur?.china || null, direct: cur?.direct || null
  };
  // content edits need a fresh content approval
  if (cur && ['title_ar', 'title_en', 'description_ar', 'description_en', 'images'].some((k) => JSON.stringify(cur[k]) !== JSON.stringify(doc[k]))) doc.approved_content = false;
  if (cur && doc.status === 'published' && !publishable(doc).ok) doc.status = 'paused';
  const saved = cur ? db.ly_offers.update(id, { ...doc, history: [...list(cur.history), { at: now(), actor: actorOf(user), changes: changed(cur, doc, OFFER_KEYS) }].slice(-200) }) : db.ly_offers.insert({ ...doc, created_by: actorOf(user), history: [{ at: now(), actor: actorOf(user), changes: { created: { from: null, to: 'draft' } } }] });
  const priceChange = changed(cur, saved, ['variants', 'status']);
  if (Object.keys(priceChange).length) note(user, 'offer', saved.id, priceChange);
  return viewForStaff(saved, user);
}
/** Content approval (catalog), China quote / supplier confirmation (catalog with evidence). */
function reviewOffer(user, id, b = {}) {
  need(user, 'catalog');
  const o = db.ly_offers.get(id); if (!o) throw httpError(404, 'Offer not found');
  const patch = {};
  if (b.approve_content !== undefined) patch.approved_content = b.approve_content === true;
  if (b.china_quote) {
    const q = b.china_quote; const amount = lyd(q.quote_lyd);
    if (!(amount > 0) || !str(q.evidence, 300)) throw httpError(400, 'A China route needs the quoted amount and where it comes from');
    patch.china = { quote_lyd: amount, includes: str(q.includes, 300), evidence: str(q.evidence, 300), verified_at: now(), verified_by: actorOf(user) };
  }
  if (b.china_quote === null) patch.china = null;
  if (b.direct_confirmation) {
    const q = b.direct_confirmation;
    if (!str(q.evidence, 300) || !(lyd(q.quote_lyd) > 0)) throw httpError(400, 'Direct shipping needs the supplier\'s confirmation and a quote');
    patch.direct = { quote_lyd: lyd(q.quote_lyd), evidence: str(q.evidence, 300), confirmed_at: now(), confirmed_by: actorOf(user) };
  }
  if (b.direct_confirmation === null) patch.direct = null;
  const next = { ...o, ...patch };
  if (next.status === 'published' && !publishable(next).ok) patch.status = 'paused';
  const saved = db.ly_offers.update(id, { ...patch, history: [...list(o.history), { at: now(), actor: actorOf(user), changes: changed(o, { ...o, ...patch }, OFFER_KEYS) }].slice(-200) });
  note(user, 'offer', id, changed(o, saved, ['approved_content', 'china', 'direct', 'status']));
  return viewForStaff(saved, user);
}
/** Ready to publish: a valid LYD price, approved content, and a verified fulfilment route. */
function publishable(o) {
  const why = [];
  const active = list(o.variants).filter((v) => v.active !== false);
  if (!active.length) why.push('no_active_variant');
  if (active.some((v) => !(v.price_lyd > 0))) why.push('missing_lyd_price');
  if (!o.approved_content) why.push('content_not_approved');
  if (!str(o.title_ar)) why.push('missing_arabic_title');
  if (!list(o.images).length) why.push('missing_photo');
  const cities = cityIndex().filter((c) => c.active !== false);
  if (!cities.some((c) => routeOk(c, o.route).ok)) why.push('route_not_verified');
  if (o.route === 'china' && !(o.china && o.china.quote_lyd > 0)) why.push('missing_china_quote');
  if (o.route === 'direct' && !(o.direct && o.direct.confirmed_at)) why.push('supplier_not_confirmed');
  return { ok: !why.length, why };
}
function setStatus(user, id, status) {
  need(user, 'catalog');
  if (!['draft', 'published', 'paused'].includes(status)) throw httpError(400, 'Status must be draft, published or paused');
  const o = db.ly_offers.get(id); if (!o) throw httpError(404, 'Offer not found');
  if (status === 'published') { const p = publishable(o); if (!p.ok) throw httpError(409, `Not ready to publish: ${p.why.join(', ')}`, { code: 'NOT_PUBLISHABLE', details: p }); }
  const saved = db.ly_offers.update(id, { status, ...(status === 'published' ? { published_at: now() } : {}), history: [...list(o.history), { at: now(), actor: actorOf(user), changes: { status: { from: o.status, to: status } } }].slice(-200) });
  note(user, 'visibility', id, { status: { from: o.status, to: status } });
  return viewForStaff(saved, user);
}
/** Bulk edit with a preview: { ids, patch: { status | price_pct | featured | collections_add }, apply }. */
function bulk(user, { ids = [], filter = null, patch = {}, apply = false } = {}) {
  need(user, 'catalog');
  let targets = filter ? searchOffers(filter).map((x) => x.id) : list(ids).map(String);
  targets = [...new Set(targets)].slice(0, 1000).map((id) => db.ly_offers.get(id)).filter(Boolean);
  const plan = targets.map((o) => {
    const next = { ...o };
    if (patch.featured !== undefined) next.featured = patch.featured === true;
    if (patch.collections_add) next.collections = [...new Set([...list(o.collections), ...list(patch.collections_add).map((x) => str(x, 40))])].slice(0, 10);
    if (patch.price_pct !== undefined) { const pct = Number(patch.price_pct); if (!(pct > -90 && pct < 500)) throw httpError(400, 'Price change must be between -90% and +500%'); next.variants = o.variants.map((v) => ({ ...v, price_lyd: lyd(v.price_lyd * (1 + pct / 100)) })); }
    let blocked = null;
    if (patch.status) { next.status = patch.status; if (patch.status === 'published' && !publishable(next).ok) blocked = publishable(next).why; }
    return { id: o.id, title_ar: o.title_ar, changes: changed(o, next, ['status', 'featured', 'collections', 'variants']), blocked, next };
  });
  const affected = plan.filter((p) => !p.blocked && Object.keys(p.changes).length);
  if (!apply) return { preview: true, affected: affected.length, blocked: plan.filter((p) => p.blocked).length, items: plan.slice(0, 100).map(({ next, ...x }) => x) };
  for (const p of affected) {
    const o = db.ly_offers.get(p.id);
    db.ly_offers.update(p.id, { status: p.next.status, featured: p.next.featured, collections: p.next.collections, variants: p.next.variants, history: [...list(o.history), { at: now(), actor: actorOf(user), changes: p.changes, bulk: true }].slice(-200) });
    note(user, 'offer', p.id, { bulk: true, ...p.changes });
  }
  return { preview: false, affected: affected.length, blocked: plan.filter((p) => p.blocked).length };
}
function searchOffers({ q = '', status = '', route = '', seller_id = '', collection = '' } = {}) {
  const n = norm(q);
  return db.ly_offers.all((o) => (!status || o.status === status) && (!route || o.route === route) && (!seller_id || o.seller_id === seller_id) && (!collection || list(o.collections).includes(collection))
    && (!n || norm(o.title_ar).includes(n) || norm(o.title_en).includes(n) || o.id === q)).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}
function viewForStaff(o, user) {
  const canCost = funcsOf(user).includes('finance');
  const stock = db.ly_stock.all((s) => s.offer_id === o.id).map((s) => ({ variant_id: s.variant_id, location_id: s.location_id, available: s.available, reserved: s.reserved, free: free(s) }));
  return { ...o, variants: list(o.variants).map((v) => (canCost ? v : (({ cost_lyd, ...x }) => x)(v))), publishable: publishable(o), stock, history: list(o.history).slice(-30) };
}

// ---------------- storefront ----------------
/** A published offer as the shop shows it, for a city (or no city yet). null when it cannot be offered there. */
function offerFor(o, city) {
  if (!o || o.status !== 'published') return null;
  const active = list(o.variants).filter((v) => v.active !== false && v.price_lyd > 0);
  if (!active.length) return null;
  const cities = city ? [city] : cityIndex().filter((c) => c.active !== false);
  const okCities = cities.filter((c) => routeOk(c, o.route).ok);
  if (!okCities.length) return null;
  const vs = active.map((v) => {
    const stock = o.route === 'local' ? localFree(o, v, city).reduce((a, x) => a + x.free, 0) : null;
    return { v, stock, in_stock: o.route === 'local' ? stock > 0 : true };
  });
  if (!vs.some((x) => x.in_stock)) return null;
  const rc = city ? routeCfg(city, o.route) : null;
  return { o, vs, rc };
}
function toShop(x, lang = 'ar') {
  const { o, vs, rc } = x;
  const label = ROUTE_LABEL[o.route];
  return {
    id: o.id, market: LY, title: o.title_en || o.title_ar, title_ar: o.title_ar, description: o.description_en || '', description_ar: o.description_ar || '',
    images: o.images, currency: 'LYD', category: o.category, collections: o.collections, featured: Boolean(o.featured), route: o.route, route_label: label,
    min_price: Math.min(...vs.filter((y) => y.in_stock).map((y) => y.v.price_lyd)), fulfillment: o.route === 'local' ? 'ly_local' : 'ly_import',
    shop: null, option_groups: null,
    skus: vs.map(({ v, stock, in_stock }) => ({ mp_sku_id: v.id, props: v.props, price: v.price_lyd, in_stock, stock: stock === null ? 50 : Math.min(stock, 50) })),
    ...(rc ? { delivery: { fee_lyd: rc.fee_lyd, min_days: rc.min_days, max_days: rc.max_days, includes: rc.includes || (o.route === 'china' ? o.china?.includes || '' : ''), due_on_delivery_lyd: rc.due_on_delivery_lyd, due_on_delivery_note: rc.due_on_delivery_note } } : { check_city: true }),
    lang
  };
}
/** The Libya catalogue: published offers only, filtered before paging and counting. Never other markets' products. */
function browse({ q = '', category = '', collection = '', route = '', city = '', featured = '', sort = 'new', limit = 40, offset = 0 } = {}) {
  if (!open()) return { total: 0, items: [], market: LY, closed: true };
  const c = city ? findCity(city) : null;
  const n = norm(q);
  const rows = db.ly_offers.all((o) => o.status === 'published' && (!category || o.category === category) && (!collection || list(o.collections).includes(collection)) && (!route || o.route === route) && (!featured || o.featured)
    && (!n || norm(o.title_ar).includes(n) || norm(o.title_en).includes(n))).map((o) => offerFor(o, c)).filter(Boolean).map((x) => toShop(x));
  const order = { price_asc: (a, b) => a.min_price - b.min_price, price_desc: (a, b) => b.min_price - a.min_price }[sort] || ((a, b) => (b.featured - a.featured) || 0);
  rows.sort(order);
  const start = Math.max(0, Number(offset) || 0); const count = Math.min(100, Math.max(1, Number(limit) || 40));
  return { total: rows.length, items: rows.slice(start, start + count), market: LY, ...(c ? { city: c.id } : { check_city: true }) };
}
function offerView(id, city) {
  const o = db.ly_offers.get(id);
  if (!o || o.status !== 'published' || !open()) throw httpError(404, 'Product not available');
  const c = city ? findCity(city) : null;
  const x = offerFor(o, c);
  if (!x) {
    const base = offerFor(o, null);
    const view = base ? toShop(base) : { id: o.id, market: LY, title: o.title_en || o.title_ar, title_ar: o.title_ar, images: o.images, currency: 'LYD', route: o.route, route_label: ROUTE_LABEL[o.route], skus: [], option_groups: null, min_price: 0 };
    return { ...view, skus: [], availability: { country: LY, available: false, reason: c ? 'not_delivered_to_city' : 'unavailable', city: c?.id || null } };
  }
  return { ...toShop(x), availability: { country: LY, available: true, city: c?.id || null } };
}
function shopInfo() {
  const c = config();
  const offers = db.ly_offers.all((o) => o.status === 'published');
  const cats = {}; for (const o of offers) cats[o.category] = (cats[o.category] || 0) + 1;
  const cols = {}; for (const o of offers) for (const k of list(o.collections)) cols[k] = (cols[k] || 0) + 1;
  return { open: c.enabled, currency: 'LYD', cities: c.enabled ? publicCities() : [], payment: { cod: c.cod, online: c.online_payment }, route_labels: ROUTE_LABEL,
    categories: Object.entries(cats).map(([id, count]) => ({ id, count })), collections: Object.entries(cols).map(([id, count]) => ({ id, count })) };
}

// ---------------- quote and checkout ----------------
const PHONE_RE = /^(?:\+?218|00218|0)?(9[1-5]\d{7})$/;
function phone(v) { const m = String(v || '').replace(/[\s()-]/g, '').match(PHONE_RE); return m ? `+218${m[1]}` : null; }
/**
 * Lines priced for a city: each line's route, availability and price; one delivery (with its own charge) per route.
 * Nothing is reserved here. Used by the cart, the checkout page and checkout itself (which then reserves).
 */
function quote({ items = [], city_id, area_id } = {}) {
  if (!open()) throw httpError(409, 'Kinan does not sell in Libya yet', { code: 'MARKET_CLOSED' });
  const city = findCity(city_id); if (!city || city.active === false) throw httpError(400, 'Choose your city', { code: 'CITY_REQUIRED' });
  const area = area_id ? list(city.areas).find((a) => a.id === area_id && a.active !== false) : null;
  if (list(city.areas).length && !area) throw httpError(400, 'Choose your area', { code: 'AREA_REQUIRED' });
  const lines = list(items).slice(0, 100).map((it, i) => {
    const qty = Math.floor(Number(it.qty));
    const o = db.ly_offers.get(String(it.offer_id || it.listing_id || ''));
    const v = o && list(o.variants).find((x) => x.id === String(it.variant_id || it.mp_sku_id || ''));
    const base = { i, offer_id: o?.id || it.offer_id || it.listing_id, variant_id: v?.id || it.variant_id || it.mp_sku_id, qty };
    if (!(qty >= 1 && qty <= 99)) return { ...base, ok: false, reason: 'invalid_quantity' };
    if (!o || o.status !== 'published' || !v || v.active === false || !(v.price_lyd > 0)) return { ...base, ok: false, reason: 'not_available' };
    const rk = routeOk(city, o.route);
    if (!rk.ok) return { ...base, ok: false, reason: rk.reason, route: o.route };
    if (o.route === 'local') {
      const best = localFree(o, v, city).sort((a, b) => b.free - a.free)[0];
      if (!best || best.free < qty) return { ...base, ok: false, reason: 'out_of_stock', route: o.route, free: best?.free || 0 };
      return { ...base, ok: true, route: 'local', location_id: best.loc.id, title: o.title_ar || o.title_en, props: v.props, price_lyd: v.price_lyd, line_total: lyd(v.price_lyd * qty), seller_id: o.seller_id || null };
    }
    const extra = o.route === 'china' ? o.china?.quote_lyd : o.direct?.quote_lyd;
    if (!(extra > 0)) return { ...base, ok: false, reason: o.route === 'china' ? 'missing_china_quote' : 'supplier_not_confirmed', route: o.route };
    return { ...base, ok: true, route: o.route, title: o.title_ar || o.title_en, props: v.props, price_lyd: v.price_lyd, line_total: lyd(v.price_lyd * qty), import_quote_lyd: lyd(extra * qty), seller_id: o.seller_id || null };
  });
  const okLines = lines.filter((l) => l.ok);
  const deliveries = ROUTES.filter((r) => okLines.some((l) => l.route === r)).map((r) => {
    const rc = routeCfg(city, r); const ls = okLines.filter((l) => l.route === r);
    const imported = lyd(ls.reduce((a, l) => a + (l.import_quote_lyd || 0), 0));
    return { route: r, label: ROUTE_LABEL[r], lines: ls.map((l) => l.i), fee_lyd: lyd(rc.fee_lyd + imported), delivery_fee_lyd: rc.fee_lyd, import_lyd: imported, min_days: rc.min_days, max_days: rc.max_days, includes: rc.includes || (r === 'china' ? 'International shipping to Libya and last-mile delivery' : ''), due_on_delivery_lyd: rc.due_on_delivery_lyd, due_on_delivery_note: rc.due_on_delivery_note, carrier: rc.carrier || null, cod: rc.cod };
  });
  const items_lyd = lyd(okLines.reduce((a, l) => a + l.line_total, 0));
  const delivery_lyd = lyd(deliveries.reduce((a, d) => a + d.fee_lyd, 0));
  const total = lyd(items_lyd + delivery_lyd);
  const due_extra = lyd(deliveries.reduce((a, d) => a + d.due_on_delivery_lyd, 0));
  const c = config();
  const codWhy = !c.cod ? 'cod_off' : area && area.cod === false ? 'cod_not_in_area' : deliveries.some((d) => !d.cod) ? 'cod_not_on_route'
    : deliveries.some((d) => d.route !== 'local') && !c.cod_imported ? 'cod_not_for_imports' : total > Math.min(c.cod_max_lyd, ...deliveries.map((d) => routeCfg(city, d.route).cod_max_lyd ?? Infinity)) ? 'cod_over_limit'
    : deliveries.some((d) => !d.carrier) ? 'cod_no_carrier' : null;
  return {
    market: LY, currency: 'LYD', city: { id: city.id, name_ar: city.name_ar, name_en: city.name_en }, area: area ? { id: area.id, name_ar: area.name_ar } : null, require_pin: Boolean(city.require_pin),
    ok: lines.length > 0 && lines.every((l) => l.ok), lines, deliveries,
    totals: { items_lyd, delivery_lyd, total_lyd: total, included: ['items', 'delivery', ...(deliveries.some((d) => d.import_lyd) ? ['import'] : [])], due_on_delivery_extra_lyd: due_extra },
    payment: { cod: !codWhy, cod_reason: codWhy, online: c.online_payment === true }
  };
}
function holdHours() { return config().reservation_hours; }
/** Reserve every local line, all or nothing. Synchronous: no other request can run between the check and the write. */
function reserve(orderId, lines) {
  const want = lines.filter((l) => l.route === 'local');
  for (const l of want) { const s = stockOf(l.offer_id, l.variant_id, l.location_id); if (free(s) < l.qty) throw httpError(409, `Only ${free(s)} left of “${l.title}”`, { code: 'OUT_OF_STOCK', details: { offer_id: l.offer_id, variant_id: l.variant_id, free: free(s) } }); }
  const items = [];
  for (const l of want) {
    const s = stockOf(l.offer_id, l.variant_id, l.location_id);
    const next = { ...s, reserved: (s.reserved || 0) + l.qty };
    if (db.ly_stock.get(s.id)) db.ly_stock.update(s.id, next); else db.ly_stock.insert(next);
    items.push({ stock_id: s.id, qty: l.qty });
  }
  return items.length ? db.ly_reservations.insert({ order_id: orderId, items, status: 'active', expires_at: now() + holdHours() * 3600e3 }) : null;
}
/** Release a reservation once (cancellation, refusal before dispatch, expiry). A second call changes nothing. */
function release(resId, reason, user = null) {
  const r = resId && db.ly_reservations.get(resId);
  if (!r || r.status !== 'active') return false;
  db.ly_reservations.update(r.id, { status: 'released', released_at: now(), reason });
  for (const it of r.items) { const s = db.ly_stock.get(it.stock_id); if (s) db.ly_stock.update(s.id, { reserved: Math.max(0, (s.reserved || 0) - it.qty) }); }
  note(user, 'stock', r.id, { released: reason });
  return true;
}
/** Dispatch: reserved units leave stock (once). */
function consume(resId, user) {
  const r = resId && db.ly_reservations.get(resId);
  if (!r || r.status !== 'active') return false;
  db.ly_reservations.update(r.id, { status: 'consumed', consumed_at: now() });
  for (const it of r.items) {
    const s = db.ly_stock.get(it.stock_id); if (!s) continue;
    db.ly_stock.update(s.id, { reserved: Math.max(0, (s.reserved || 0) - it.qty), available: Math.max(0, (s.available || 0) - it.qty) });
    db.ly_moves.insert({ stock_id: s.id, offer_id: s.offer_id, variant_id: s.variant_id, location_id: s.location_id, delta: -it.qty, reason: 'dispatched', ref: r.order_id, at: now(), actor: actorOf(user) });
  }
  return true;
}
/** Hourly: unconfirmed orders whose hold expired give their stock back. */
function releaseExpired(at = now()) {
  let n = 0;
  for (const r of db.ly_reservations.all((x) => x.status === 'active' && x.expires_at <= at)) {
    const o = db.ly_orders.get(r.order_id);
    if (o && o.delivery_status !== 'pending_confirmation') continue; // confirmed orders keep their stock until dispatch
    if (release(r.id, 'expired')) { n++; if (o) updateOrderStatus(o.id, 'cancelled', { reason: 'reservation_expired' }, null); }
  }
  return n;
}
function checkout(buyer, b = {}) {
  const q = quote({ items: b.items, city_id: b.recipient?.city_id, area_id: b.recipient?.area_id });
  if (!q.ok) throw httpError(409, 'Some items cannot be delivered to this address', { code: 'NOT_DELIVERABLE', details: { lines: q.lines.filter((l) => !l.ok) } });
  const r = b.recipient || {};
  const name = str(r.name, 80); const tel = phone(r.phone); const address = str(r.address, 300);
  const miss = [!name && 'name', !tel && 'phone', !address && 'address'].filter(Boolean);
  if (miss.length) throw httpError(400, `Check: ${miss.join(', ')}`, { code: 'RECIPIENT_INVALID', details: { fields: miss } });
  let pin = null;
  if (r.lat !== undefined && r.lon !== undefined) { const lat = Number(r.lat); const lon = Number(r.lon); if (lat > 19 && lat < 34 && lon > 9 && lon < 26) pin = { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 }; }
  if (q.require_pin && !pin) throw httpError(400, 'Add a map pin for delivery in this city', { code: 'PIN_REQUIRED' });
  const method = b.payment === 'online' ? 'online' : 'cod';
  if (method === 'online' && !q.payment.online) throw httpError(409, 'Online payment is not available for Libya yet', { code: 'PAYMENT_UNAVAILABLE' });
  if (method === 'cod' && !q.payment.cod) throw httpError(409, 'Cash on delivery is not available for this order', { code: 'COD_UNAVAILABLE', details: { reason: q.payment.cod_reason } });
  if (b.expected_total_lyd !== undefined && b.expected_total_lyd !== null && Math.abs(lyd(b.expected_total_lyd) - q.totals.total_lyd) > 0.0009) {
    throw httpError(409, 'The total changed. Please review it and confirm again.', { code: 'TOTAL_CHANGED', details: { total_lyd: q.totals.total_lyd } });
  }
  const id = db.id('lyord');
  const res = reserve(id, q.lines); // throws before anything is saved when stock is gone
  const order = db.ly_orders.insert({
    id, market: LY, currency: 'LYD', buyer_id: buyer.id,
    recipient: { name, phone: tel, city_id: q.city.id, city: q.city.name_ar, area_id: q.area?.id || null, area: q.area?.name_ar || null, address, landmark: str(r.landmark, 200) || null, ...(pin ? { pin } : {}) },
    lines: q.lines.map((l) => ({ offer_id: l.offer_id, variant_id: l.variant_id, title: l.title, props: l.props, qty: l.qty, price_lyd: l.price_lyd, line_total_lyd: l.line_total, route: l.route, location_id: l.location_id || null, seller_id: l.seller_id, import_quote_lyd: l.import_quote_lyd || 0 })),
    deliveries: q.deliveries.map((d) => ({ ...d, status: 'pending', history: [] })),
    quote: { at: now(), totals: q.totals, deliveries: q.deliveries.map(({ route, fee_lyd, delivery_fee_lyd, import_lyd, includes, due_on_delivery_lyd, due_on_delivery_note }) => ({ route, fee_lyd, delivery_fee_lyd, import_lyd, includes, due_on_delivery_lyd, due_on_delivery_note })) },
    totals: q.totals, payment: { method, status: method === 'cod' ? 'due_on_delivery' : 'pending' },
    delivery_status: 'pending_confirmation', settlement_status: method === 'cod' ? 'expected' : 'none',
    reservation_id: res?.id || null, events: [], created_at: now()
  });
  if (method === 'cod') cashEntry(null, { order_id: id, kind: 'expected', amount_lyd: q.totals.total_lyd, key: `expected:${id}` });
  return buyerOrder(order);
}
const TRACKING_STAGES = {
  china_inbound: ['On the way to KINAN’s fulfilment centre', 'طلبك في الطريق إلى مركز تجهيز KINAN'],
  china_received: ['Received at KINAN’s fulfilment centre', 'وصل طلبك إلى مركز تجهيز KINAN'],
  international_transit: ['On the way to Libya', 'طلبك في الطريق إلى ليبيا'],
  libya_partial: ['Part of your order reached KINAN Libya', 'وصل جزء من طلبك إلى مستودع KINAN في ليبيا'],
  libya_received: ['Received at KINAN Libya', 'وصل طلبك إلى مستودع KINAN في ليبيا'],
  dispatched: ['Out for delivery', 'خرج طلبك للتوصيل'],
  delivery_attempted: ['Delivery attempt unsuccessful', 'تعذّر تسليم طلبك. تابع التحديثات لمعرفة موعد المحاولة التالية'],
  rescheduled: ['Delivery rescheduled', 'أُعيدت جدولة توصيل طلبك'],
  delivered: ['Delivered', 'تم تسليم طلبك'],
  refused: ['Delivery refused', 'رُفض استلام طلبك'],
  returned_to_sender: ['Returned to KINAN', 'أُعيد طلبك إلى مستودع KINAN']
};
const IMPORT_STAGES = ['china_inbound', 'china_received', 'international_transit'];

function recordTracking(id, stage, key) {
  const order = db.ly_orders.get(id);
  const labels = TRACKING_STAGES[stage];
  if (!order || !labels) return;
  const tracking = order.customer_tracking || [];
  if (tracking.some((e) => e.key === key)) return;
  const event = { key, stage, at: now(), en: labels[0], ar: labels[1] };
  db.ly_orders.update(id, { customer_tracking: [...tracking, event] });
  require('../notify').libyaTracking(order, event);
}

function inboundReceived(parcel) {
  for (const id of new Set(parcel.items.map((item) => item.order_id))) {
    const order = db.ly_orders.get(id);
    if (!order || ['cancelled', 'returned', 'delivered', 'refused', 'returned_to_sender'].includes(order.delivery_status)) continue;
    const received = new Map();
    for (const carton of db.ly_inbound.peek((p) => Boolean(p.received_at))) {
      for (const item of carton.items) {
        if (item.order_id === id) received.set(item.line_index, (received.get(item.line_index) || 0) + item.qty);
      }
    }
    const complete = order.lines.every((line, index) => line.route !== 'china' || (received.get(index) || 0) >= line.qty);
    const stage = complete ? 'libya_received' : 'libya_partial';
    recordTracking(id, stage, stage);
  }
}

function buyerOrder(o) {
  return { id: o.id, market: LY, currency: 'LYD', tracking_history: (o.customer_tracking || []).map(({ stage, at, en, ar }) => ({ stage, at, en: TRACKING_STAGES[stage]?.[0] || en, ar: TRACKING_STAGES[stage]?.[1] || ar })), created_at: o.created_at, recipient: o.recipient, lines: o.lines.map(({ location_id, seller_id, ...l }) => l), deliveries: o.deliveries.map(({ history, carrier, ...d }) => ({ ...d, label: d.route === 'china' ? { ar: 'شحن دولي عبر KINAN', en: 'International shipping via KINAN' } : d.label, tracking: d.tracking || null })), totals: o.totals, payment: { method: o.payment.method, status: o.payment.status }, delivery_status: o.delivery_status };
}
const buyerOrders = (user) => db.ly_orders.all((o) => o.buyer_id === user.id).sort((a, b) => b.created_at - a.created_at).map(buyerOrder);

// ---------------- order operations (idempotent events) ----------------
const DELIVERY_FLOW = {
  pending_confirmation: ['confirmed', 'cancelled'], confirmed: ['packed', 'cancelled'], packed: ['dispatched', 'cancelled'],
  dispatched: ['delivery_attempted', 'delivered', 'refused', 'rescheduled', 'returned_to_sender'], delivery_attempted: ['delivered', 'refused', 'rescheduled', 'returned_to_sender'],
  rescheduled: ['dispatched', 'delivery_attempted', 'delivered', 'refused', 'returned_to_sender'], refused: ['returned_to_sender'], returned_to_sender: ['returned'], delivered: ['returned'], cancelled: [], returned: []
};
function updateOrderStatus(id, to, data, user) {
  const o = db.ly_orders.get(id); if (!o) return null;
  const from = o.delivery_status;
  const ev = { at: now(), type: 'status', from, to, actor: actorOf(user), ...(data || {}) };
  const saved = db.ly_orders.update(id, { delivery_status: to, events: [...list(o.events), ev].slice(-500) });
  note(user, 'order_status', id, { from, to, reason: data?.reason || null });
  return saved;
}
/**
 * One operator action or carrier update. `key` makes it idempotent: the same key twice is answered with the order as
 * it is, nothing is applied again (no second stock movement, no second cash entry).
 * Types: confirm, pack, dispatch {tracking, carrier}, attempt {note}, reschedule {date}, deliver {cod_collected_lyd,
 * carrier_fee_lyd}, refuse {reason}, return_to_sender, cancel {reason}.
 */
function orderEvent(user, id, b = {}) {
  need(user, 'orders');
  const key = str(b.key, 100);
  if (!/^[\w:.-]{6,100}$/.test(key)) throw httpError(400, 'Every update needs a unique key (6–100 letters, digits, : . - _)');
  const o = db.ly_orders.get(id); if (!o) throw httpError(404, 'Order not found');
  if (list(o.events).some((e) => e.key === key)) return { duplicate: true, order: staffOrder(db.ly_orders.get(id), user) };
  if (IMPORT_STAGES.includes(b.type)) {
    if (!o.lines.some((line) => line.route === 'china') || !['pending_confirmation', 'confirmed', 'packed'].includes(o.delivery_status)) throw httpError(409, 'This order cannot receive import tracking updates');
    const stage = b.type;
    const history = o.customer_tracking || [];
    if (history.some((event) => event.stage === stage)) return { duplicate: true, order: staffOrder(o, user) };
    const previous = IMPORT_STAGES[IMPORT_STAGES.indexOf(stage) - 1];
    if ((previous && !history.some((event) => event.stage === previous)) || history.some((event) => ['libya_received', 'libya_partial', 'dispatched'].includes(event.stage))) throw httpError(409, 'Record import stages in order');
    recordTracking(id, stage, stage);
    note(user, 'import_tracking', id, { stage });
    return { duplicate: false, order: staffOrder(db.ly_orders.get(id), user) };
  }
  const map = { confirm: 'confirmed', pack: 'packed', dispatch: 'dispatched', attempt: 'delivery_attempted', reschedule: 'rescheduled', deliver: 'delivered', refuse: 'refused', return_to_sender: 'returned_to_sender', cancel: 'cancelled' };
  const to = map[b.type]; if (!to) throw httpError(400, 'Unknown update type');
  if (!(DELIVERY_FLOW[o.delivery_status] || []).includes(to)) throw httpError(409, `An order that is ${o.delivery_status} cannot become ${to}`);
  const reason = str(b.reason || b.note, 200);
  if (['cancelled', 'refused'].includes(to) && !reason) throw httpError(400, 'Give the reason');
  const ev = { key, at: now(), type: b.type, from: o.delivery_status, to, actor: actorOf(user), ...(reason ? { reason } : {}), ...(b.tracking ? { tracking: str(b.tracking, 80) } : {}), ...(b.date ? { date: str(b.date, 30) } : {}) };
  const patch = { delivery_status: to, events: [...list(o.events), ev].slice(-500) };
  if (to === 'dispatched' && (o.customer_tracking || []).some((event) => IMPORT_STAGES.includes(event.stage) || event.stage === 'libya_partial') &&
      !(o.customer_tracking || []).some((event) => event.stage === 'libya_received')) throw httpError(409, 'Receive all import cartons in Libya before dispatch');
  if (to === 'dispatched') { consume(o.reservation_id, user); patch.deliveries = o.deliveries.map((d) => ({ ...d, status: 'dispatched', tracking: str(b.tracking, 80) || d.tracking || null, carrier: str(b.carrier, 60) || d.carrier || null })); }
  if (to === 'cancelled') release(o.reservation_id, reason, user);
  if (to === 'delivered') patch.deliveries = o.deliveries.map((d) => ({ ...d, status: 'delivered' }));
  db.ly_orders.update(id, patch);
  note(user, 'order_status', id, { from: o.delivery_status, to, key });
  if (to === 'delivered' && o.payment.method === 'cod') {
    const amount = b.cod_collected_lyd !== undefined ? lyd(b.cod_collected_lyd) : o.totals.total_lyd;
    cashEntry(user, { order_id: id, kind: 'collected', amount_lyd: amount, carrier_fee_lyd: lyd(b.carrier_fee_lyd), key: `collected:${id}`, ref: str(b.tracking, 80) || null });
    db.ly_orders.update(id, { payment: { ...o.payment, status: 'collected' }, settlement_status: 'collected' });
  }
  if (['cancelled', 'refused'].includes(to) && o.payment.method === 'cod') db.ly_orders.update(id, { settlement_status: 'none' });
  recordTracking(id, to, 'delivery:' + key);
  return { duplicate: false, order: staffOrder(db.ly_orders.get(id), user) };
}
/** Cash on delivery ledger entries, idempotent by key. */
function cashEntry(user, { order_id, kind, amount_lyd, carrier_fee_lyd = 0, key, ref = null, settlement_ref = null }) {
  const dupe = db.ly_cash.find((c) => c.key === key);
  if (dupe) return dupe;
  const e = db.ly_cash.insert({ order_id, kind, amount_lyd: lyd(amount_lyd), carrier_fee_lyd: lyd(carrier_fee_lyd), key, ref, settlement_ref, at: now(), actor: actorOf(user) });
  note(user, 'settlement', order_id, { kind, amount_lyd: e.amount_lyd, key });
  return e;
}
/** Finance: the carrier remitted cash for these orders (reference from the carrier's statement). */
function remit(user, { order_ids = [], settlement_ref, amounts = {}, key }) {
  need(user, 'finance');
  const ref = str(settlement_ref, 80); if (!ref) throw httpError(400, 'Enter the settlement reference');
  const k = str(key, 100); if (!/^[\w:.-]{6,100}$/.test(k)) throw httpError(400, 'A settlement needs a unique key');
  const out = [];
  for (const id of list(order_ids).slice(0, 500).map(String)) {
    const o = db.ly_orders.get(id); if (!o) continue;
    const collected = db.ly_cash.all((c) => c.order_id === id && c.kind === 'collected').reduce((a, c) => a + c.amount_lyd - c.carrier_fee_lyd, 0);
    if (!collected) { out.push({ order_id: id, skipped: 'not_collected' }); continue; }
    const amount = amounts[id] !== undefined ? lyd(amounts[id]) : lyd(collected);
    const e = cashEntry(user, { order_id: id, kind: 'remitted', amount_lyd: amount, key: `${k}:${id}`, settlement_ref: ref });
    const remitted = db.ly_cash.all((c) => c.order_id === id && c.kind === 'remitted').reduce((a, c) => a + c.amount_lyd, 0);
    const diff = lyd(collected - remitted);
    db.ly_orders.update(id, { settlement_status: Math.abs(diff) < 0.001 ? 'remitted' : 'discrepancy' });
    out.push({ order_id: id, entry: e.id, difference_lyd: diff });
  }
  return { settlement_ref: ref, orders: out };
}
function cashSummary(user, { from = 0, to = Infinity } = {}) {
  need(user, 'finance');
  const rows = db.ly_cash.all((c) => c.at >= from && c.at <= to);
  const sum = (k, f = 'amount_lyd') => lyd(rows.filter((c) => c.kind === k).reduce((a, c) => a + c[f], 0));
  const discrepancies = db.ly_orders.all((o) => o.settlement_status === 'discrepancy').map((o) => o.id);
  return { expected_lyd: sum('expected'), collected_lyd: sum('collected'), carrier_fees_lyd: sum('collected', 'carrier_fee_lyd'), remitted_lyd: sum('remitted'), unsettled_lyd: lyd(sum('collected') - sum('collected', 'carrier_fee_lyd') - sum('remitted')), discrepancies, entries: rows.sort((a, b) => b.at - a.at).slice(0, 500) };
}
function staffOrder(o, user) {
  const fin = funcsOf(user).includes('finance');
  return { ...o, events: list(o.events).slice(-100), ...(fin ? { cash: db.ly_cash.all((c) => c.order_id === o.id) } : {}) };
}
function searchOrders(user, { q = '', city = '', status = '', route = '', seller_id = '', location_id = '', from = '', to = '' } = {}) {
  need(user, 'orders');
  const n = norm(q); const f = Number(from) || 0; const t = Number(to) || Infinity;
  return db.ly_orders.all((o) => (!status || o.delivery_status === status) && (!city || o.recipient.city_id === city) && (!route || o.lines.some((l) => l.route === route))
    && (!seller_id || o.lines.some((l) => l.seller_id === seller_id)) && (!location_id || o.lines.some((l) => l.location_id === location_id)) && o.created_at >= f && o.created_at <= t
    && (!n || o.id.toLowerCase().includes(n) || norm(o.recipient.name).includes(n) || String(o.recipient.phone).includes(q.replace(/\s/g, '')) || norm(o.recipient.city).includes(n) || o.deliveries.some((d) => String(d.tracking || '').toLowerCase().includes(n))))
    .sort((a, b) => b.created_at - a.created_at).slice(0, 500).map((o) => staffOrder(o, user));
}
function overview(user, filters = {}) {
  const fns = funcsOf(user); if (!fns.length) throw httpError(403, 'Your account has no Libya access');
  const orders = fns.includes('orders') ? searchOrders(user, filters) : [];
  const by = {}; for (const o of orders) by[o.delivery_status] = (by[o.delivery_status] || 0) + 1;
  const low = fns.includes('stock') ? db.ly_stock.all((s) => free(s) <= 2).map((s) => ({ ...s, free: free(s) })) : null;
  return {
    functions: fns, market_open: open(),
    orders_by_status: fns.includes('orders') ? by : null,
    awaiting_shipment: fns.includes('orders') ? orders.filter((o) => ['confirmed', 'packed'].includes(o.delivery_status)).length : null,
    delivery_failures: fns.includes('orders') ? orders.filter((o) => ['refused', 'returned_to_sender', 'delivery_attempted'].includes(o.delivery_status)).length : null,
    returns_open: fns.includes('orders') ? db.ly_returns.all((r) => r.status !== 'closed').length : null,
    low_stock: low,
    unsettled_cod_lyd: fns.includes('finance') ? cashSummary(user).unsettled_lyd : null,
    offers: fns.includes('catalog') ? { draft: db.ly_offers.all((o) => o.status === 'draft').length, published: db.ly_offers.all((o) => o.status === 'published').length, paused: db.ly_offers.all((o) => o.status === 'paused').length } : null
  };
}
/** CSV export of Libya orders. Money columns need the finance function. */
function exportOrders(user, filters = {}) {
  const fin = funcsOf(user).includes('finance');
  const rows = searchOrders(user, filters);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['order', 'created', 'city', 'area', 'status', 'routes', 'items', ...(fin ? ['total_lyd', 'payment', 'settlement'] : [])];
  return [head.join(','), ...rows.map((o) => [o.id, new Date(o.created_at).toISOString(), o.recipient.city, o.recipient.area || '', o.delivery_status, [...new Set(o.lines.map((l) => l.route))].join(' '), o.lines.reduce((a, l) => a + l.qty, 0), ...(fin ? [o.totals.total_lyd, o.payment.method, o.settlement_status] : [])].map(esc).join(','))].join('\n');
}

// ---------------- returns ----------------
function openReturn(user, orderId, b = {}) {
  need(user, 'orders');
  const o = db.ly_orders.get(orderId); if (!o) throw httpError(404, 'Order not found');
  if (!['delivered', 'returned_to_sender', 'refused'].includes(o.delivery_status)) throw httpError(409, 'Only delivered or returned orders can be returned');
  const lines = list(b.lines).map((l) => ({ line: Math.floor(Number(l.line)), qty: Math.floor(Number(l.qty)) })).filter((l) => o.lines[l.line] && l.qty >= 1 && l.qty <= o.lines[l.line].qty);
  if (!lines.length) throw httpError(400, 'Choose the items being returned');
  const reason = str(b.reason, 200); if (!reason) throw httpError(400, 'Give the return reason');
  const r = db.ly_returns.insert({ order_id: orderId, lines, reason, status: 'requested', created_by: actorOf(user), restocked: false });
  note(user, 'return', r.id, { order_id: orderId, reason });
  return r;
}
/** Inspection: per line how many units are fit to sell again. Only those go back to stock, once. */
function inspectReturn(user, id, b = {}) {
  need(user, 'stock');
  const r = db.ly_returns.get(id); if (!r) throw httpError(404, 'Return not found');
  if (r.restocked) return { ...r, duplicate: true };
  const o = db.ly_orders.get(r.order_id);
  const results = r.lines.map((ln) => {
    const x = list(b.results).find((y) => Math.floor(Number(y.line)) === ln.line) || {};
    const approved = Math.max(0, Math.min(ln.qty, Math.floor(Number(x.approved_qty) || 0)));
    return { line: ln.line, qty: ln.qty, approved_qty: approved, rejected_qty: ln.qty - approved, note: str(x.note, 200) };
  });
  const loc = b.location_id ? db.ly_locations.get(String(b.location_id)) : null;
  for (const res of results) {
    if (!res.approved_qty) continue;
    const line = o.lines[res.line];
    const locId = loc?.id || line.location_id;
    if (!locId) throw httpError(400, 'Choose the location the approved units go back to');
    applyMove(user, { offer_id: line.offer_id, variant_id: line.variant_id, location_id: locId, delta: res.approved_qty, reason: 'return_inspected', ref: r.id });
  }
  const saved = db.ly_returns.update(id, { status: 'inspected', inspection: results, inspected_at: now(), inspected_by: actorOf(user), restocked: true });
  if (o.delivery_status !== 'returned' && (DELIVERY_FLOW[o.delivery_status] || []).includes('returned')) updateOrderStatus(o.id, 'returned', { reason: 'return_inspected' }, user);
  return saved;
}
/** Refund (finance only), recorded in the audit log; never twice for the same key. */
function refund(user, id, b = {}) {
  need(user, 'finance');
  const r = db.ly_returns.get(id); if (!r) throw httpError(404, 'Return not found');
  if (r.refund) return { ...r, duplicate: true };
  const amount = lyd(b.amount_lyd); if (!(amount > 0)) throw httpError(400, 'Enter the refund amount');
  const o = db.ly_orders.get(r.order_id);
  if (amount > o.totals.total_lyd) throw httpError(400, 'A refund cannot be more than the order total');
  const method = str(b.method, 40) || 'cash';
  const saved = db.ly_returns.update(id, { refund: { amount_lyd: amount, method, ref: str(b.ref, 80) || null, at: now(), by: actorOf(user) }, status: 'closed' });
  note(user, 'refund', id, { order_id: r.order_id, amount_lyd: amount, method });
  return saved;
}

module.exports = {
  LY, ROUTES, ROUTE_LABEL, FUNCS, config, saveConfig, open, funcsOf, need,
  saveCity, findCity, publicCities, routeOk, saveLocation, adjustStock, stockOf, free,
  saveOffer, reviewOffer, setStatus, publishable, bulk, searchOffers, viewForStaff,
  browse, offerView, shopInfo, quote, checkout, buyerOrders, phone,
  inboundReceived, orderEvent, remit, cashSummary, searchOrders, overview, exportOrders, staffOrder,
  openReturn, inspectReturn, refund, release, releaseExpired, reserve
};
