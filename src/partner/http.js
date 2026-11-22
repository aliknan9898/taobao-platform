// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* HTTP layer for the Partner API v1 (/api/partner/v1). Server-to-server only:
 *   - Authorization: Bearer knp_test_… / knp_live_…  (no cookies, no Buyer/Seller sessions)
 *   - every response carries X-Request-Id; errors are RFC 9457 application/problem+json
 *   - per-store rate limit (token bucket) with Retry-After
 * Business rules live in catalog.js / store.js; this file only parses, authorises and formats. */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const catalog = require('./catalog');
const { PartnerError } = catalog;

const BASE = '/api/partner/v1';
const DOCS = 'https://kinan.shop/docs/partner-api#errors';
const RATE = () => Math.max(10, Number(process.env.PARTNER_RATE_PER_MIN) || 120);
const buckets = new Map();
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

function send(res, status, body, rid, extra = {}) {
  const problem = status >= 400;
  res.writeHead(status, { 'Content-Type': problem ? 'application/problem+json; charset=utf-8' : 'application/json; charset=utf-8', 'X-Request-Id': rid, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(body));
}
function problem(res, rid, e, extraHeaders) {
  const status = e.status || 500;
  const body = { type: `${DOCS}-${String(e.code || 'INTERNAL').toLowerCase()}`, title: e.title || (status >= 500 ? 'Internal error' : 'Request failed'), status, code: e.code || (status >= 500 ? 'INTERNAL' : 'INVALID_INPUT'), request_id: rid };
  if (e.detail) body.detail = e.detail;
  if (e.extra?.errors) body.errors = e.extra.errors;
  send(res, status, body, rid, extraHeaders);
}

function take(storeId) {
  const now = Date.now(); const cap = RATE(); const b = buckets.get(storeId) || { tokens: cap, at: now };
  b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 60e3) * cap); b.at = now;
  if (b.tokens < 1) { buckets.set(storeId, b); return Math.ceil(((1 - b.tokens) / cap) * 60); }
  b.tokens -= 1; buckets.set(storeId, b); return 0;
}

function authn(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) throw new PartnerError(401, 'INVALID_CREDENTIAL', 'Missing or invalid credential', 'Send your store key as "Authorization: Bearer knp_test_…".');
  const r = store.resolve(m[1]);
  if (!r) throw new PartnerError(401, 'INVALID_CREDENTIAL', 'Missing or invalid credential', 'The key is unknown, revoked or not enabled for this environment.');
  return { ...r, env: r.key.env };
}
function need(ctx, scope) { if (!ctx.key.scopes.includes(scope)) throw new PartnerError(403, 'INSUFFICIENT_SCOPE', 'Insufficient scope', `This key does not have the "${scope}" scope.`); }
function marketLocale(ctx, url) {
  const q = url.searchParams; const errors = [];
  const market = String(q.get('market') || '').toUpperCase(); const locale = String(q.get('locale') || 'en');
  if (!/^[A-Z]{2}$/.test(market)) errors.push({ field: 'market', code: 'required', detail: 'ISO 3166-1 alpha-2 country, e.g. DE' });
  if (!LOCALE_RE.test(locale)) errors.push({ field: 'locale', code: 'invalid', detail: 'BCP 47 language or language-REGION, e.g. de-DE' });
  const lim = q.get('limit'); if (lim !== null && !(/^\d+$/.test(lim) && Number(lim) >= 1)) errors.push({ field: 'limit', code: 'invalid' });
  if (errors.length) throw new PartnerError(400, 'INVALID_INPUT', 'Invalid query parameters', undefined, { errors });
  if (!(ctx.store.entitlements.markets || []).includes(market)) throw new PartnerError(422, 'UNSUPPORTED_DESTINATION', 'Market not enabled', `Market ${market} is not enabled for your store.`);
  return { market, locale, limit: lim, cursor: q.get('cursor') || '' };
}

/** Quotes and orders need PostgreSQL and the owner's switch (PARTNER_ORDERS_ENABLED=1). */
function ordering() {
  const pgm = require('./pg');
  if (!pgm.enabled()) throw new PartnerError(503, 'TEMPORARILY_UNAVAILABLE', 'Ordering is not enabled yet', 'Quotes and orders are switched off for now. The catalogue works as usual.');
  try { pgm.pool(); } catch { throw new PartnerError(503, 'TEMPORARILY_UNAVAILABLE', 'Ordering unavailable', 'Ordering needs the PostgreSQL database.'); }
  if (!pgm.pool()) throw new PartnerError(503, 'TEMPORARILY_UNAVAILABLE', 'Ordering unavailable', 'Ordering needs the PostgreSQL database.');
  startWorkers();
  return require('./orders');
}
let workers = null;
/** Background upkeep while ordering is on: fulfilment intents and handoff, expired reservations, webhooks, old idempotency records. */
function startWorkers() {
  if (workers || process.env.NODE_ENV === 'test') return;
  const o = require('./orders'); let n = 0; let busy = false;
  const log = (what) => (e) => console.error(`[partner] ${what}`, e.message);
  workers = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      for (const env of ['sandbox', 'live']) {
        await W().dispatch(env).catch(log('webhooks'));
        if (n % 4 === 0) {
          await o.fulfilmentWorker(env).catch(log('worker')); await F().handoffWorker(env).catch(log('handoff')); await o.sweepExpired(env).catch(log('sweep'));
        }
      }
      if (++n % 5760 === 0) await o.purgeIdempotency().catch(() => {});
    } finally { busy = false; }
  }, 15e3);
  workers.unref?.();
}
function sendTrue(res, status, out, rid, headers) { send(res, status, out, rid, headers); return true; }
/** JSON body, at most 64 KB, application/json only. */
function body(req) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return Promise.reject(new PartnerError(415, 'INVALID_INPUT', 'Send application/json'));
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(new PartnerError(413, 'INVALID_INPUT', 'Body too large', 'At most 64 KB.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); resolve(v); } catch { reject(new PartnerError(400, 'INVALID_INPUT', 'Body is not a JSON object')); } });
    req.on('error', reject);
  });
}

// ---------- routes ----------
const ID = { order: 'po_[A-Za-z0-9]{6,64}', endpoint: 'pwe_[A-Za-z0-9]{6,64}', product: 'kp_[A-Za-z0-9_]{1,80}', doc: '[a-z_]{4,20}|credit_pr_[A-Za-z0-9]{6,64}' };
/** Non-200 answers are wrapped as { $status, body, replayed?, location? } so a resource's own `status` field is never mistaken for one. */
const created = (r, location) => ({ $status: r.status, body: r.body, replayed: r.replayed, location: r.replayed ? undefined : location });
const F = () => require('./fulfilment'); const W = () => require('./webhooks'); const D = () => require('./documents');
const ROUTES = [
  ['GET', '/me', null, ({ ctx }) => ({
    environment: ctx.env, organization: { id: ctx.org.id, name: ctx.org.name }, store: { id: ctx.store.id, name: ctx.store.name, platform: ctx.store.platform },
    scopes: ctx.key.scopes, markets: ctx.store.entitlements.markets, locales: ctx.store.entitlements.locales, currencies: ['EUR'],
    price_list: { version: ctx.store.price_list?.version || 1, currency: 'EUR' }, api_version: 'v1'
  })],
  ['GET', '/catalog/products', 'catalog:read', ({ ctx, url }) => catalog.snapshot(ctx, marketLocale(ctx, url))],
  ['GET', `/catalog/products/(${ID.product})`, 'catalog:read', ({ ctx, url, params }) => catalog.product(ctx, params[0], marketLocale(ctx, url))],
  ['GET', '/catalog/changes', 'catalog:read', ({ ctx, url }) => catalog.changes(ctx, marketLocale(ctx, url))],
  ['POST', '/quotes', 'quotes:write', async ({ ctx, req }) => ({ $status: 201, body: await ordering().createQuote(ctx, await body(req)) })],
  ['POST', '/orders', 'orders:write', async ({ ctx, req, idem }) => { const r = await ordering().createOrder(ctx, await body(req), idem); return created(r, r.body.links?.self); }],
  ['GET', '/orders', 'orders:read', ({ ctx, url }) => ordering().listOrders(ctx, { limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor'), external_order_ref: url.searchParams.get('external_order_ref') })],
  ['GET', `/orders/(${ID.order})`, 'orders:read', ({ ctx, params }) => ordering().getOrder(ctx, params[0])],
  ['GET', `/orders/(${ID.order})/shipments`, 'orders:read', ({ ctx, params }) => (ordering(), F().listShipments(ctx, params[0]))],
  ['POST', `/orders/(${ID.order})/cancellations`, 'orders:write', async ({ ctx, req, params, idem }) => { ordering(); return created(await F().requestCancellation(ctx, params[0], await body(req), idem), `${BASE}/orders/${params[0]}/cancellations`); }],
  ['GET', `/orders/(${ID.order})/cancellations`, 'orders:read', ({ ctx, params }) => (ordering(), F().listCancellations(ctx, params[0]))],
  ['POST', `/orders/(${ID.order})/returns`, 'returns:write', async ({ ctx, req, params, idem }) => { ordering(); return created(await F().requestReturn(ctx, params[0], await body(req), idem), `${BASE}/orders/${params[0]}/returns`); }],
  ['GET', `/orders/(${ID.order})/returns`, 'returns:read', ({ ctx, params }) => (ordering(), F().listReturns(ctx, params[0]))],
  ['GET', `/orders/(${ID.order})/documents`, 'documents:read', ({ ctx, params }) => (ordering(), D().list(ctx, params[0]))],
  ['GET', `/orders/(${ID.order})/documents/(${ID.doc})`, 'documents:read', async ({ ctx, params }) => { ordering(); return { pdf: await D().render(ctx, params[0], params[1]) }; }],
  ['POST', `/sandbox/orders/(${ID.order})/simulate`, 'orders:write', async ({ ctx, req, params }) => { ordering(); return F().simulate(ctx, params[0], await body(req)); }],
  ['POST', '/webhook-endpoints', 'webhooks:manage', async ({ ctx, req }) => { ordering(); const e = await W().createEndpoint(ctx, await body(req)); return { $status: 201, body: e, location: `${BASE}/webhook-endpoints/${e.endpoint_id}` }; }],
  ['GET', '/webhook-endpoints', 'webhooks:manage', ({ ctx }) => (ordering(), W().listEndpoints(ctx))],
  ['DELETE', `/webhook-endpoints/(${ID.endpoint})`, 'webhooks:manage', ({ ctx, params }) => (ordering(), W().deleteEndpoint(ctx, params[0]))],
  ['POST', `/webhook-endpoints/(${ID.endpoint})/verify`, 'webhooks:manage', ({ ctx, params }) => (ordering(), W().verifyEndpoint(ctx, params[0]))],
  ['GET', `/webhook-endpoints/(${ID.endpoint})/deliveries`, 'webhooks:manage', ({ ctx, url, params }) => (ordering(), W().listDeliveries(ctx, params[0], { state: url.searchParams.get('state') || undefined, limit: url.searchParams.get('limit') }))],
  ['POST', `/webhook-endpoints/(${ID.endpoint})/replay`, 'webhooks:manage', async ({ ctx, req, params }) => { ordering(); return W().replay(ctx, params[0], await body(req)); }]
].map(([method, pattern, scope, run]) => ({ method, re: new RegExp(`^${pattern}$`), scope, run }));
/** Find the route for a method and path (method null: any method). */
function match(method, sub) {
  for (const r of ROUTES) { if (method && r.method !== method) continue; const m = sub.match(r.re); if (m) return { ...r, params: m.slice(1).map(decodeURIComponent) }; }
  return null;
}

/** Handles the request when it is for the Partner API; returns false otherwise. */
async function handle(req, res, p, url) {
  if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
  const rid = `req_${crypto.randomBytes(9).toString('base64url')}`;
  try {
    if (req.method === 'GET' && p === `${BASE}/openapi.json`) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': rid, 'Cache-Control': 'public, max-age=300' });
      res.end(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'partner-api', 'openapi.json'))); return true;
    }
    const sub = p.slice(BASE.length);
    const route = match(req.method, sub);
    if (!route) {
      if (match(null, sub)) throw new PartnerError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      if (req.method !== 'GET') throw new PartnerError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }
    const ctx = authn(req);
    if (ctx.store.status !== 'active') throw new PartnerError(503, 'TEMPORARILY_UNAVAILABLE', 'Store paused', 'KINAN has paused this store’s API access. Contact your KINAN account manager.');
    const wait = take(ctx.store.id);
    if (wait) { problem(res, rid, new PartnerError(429, 'RATE_LIMITED', 'Too many requests', `Limit is ${RATE()} requests per minute per store.`), { 'Retry-After': String(wait) }); return true; }
    if (!route) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Not found', 'Unknown Partner API path. See /api/partner/v1/openapi.json.');
    if (route.scope) need(ctx, route.scope);
    const r = await route.run({ ctx, req, url, params: route.params, idem: req.headers['idempotency-key'] });
    if (r && r.pdf) {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${r.pdf.name}"`, 'X-Request-Id': rid, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(r.pdf.body); return true;
    }
    if (r && r.$status) return sendTrue(res, r.$status, r.body, rid, { ...(r.replayed ? { 'Idempotent-Replayed': 'true' } : {}), ...(r.location ? { Location: r.location } : {}) });
    send(res, 200, r, rid);
  } catch (e) {
    if (!(e instanceof PartnerError)) { console.error('[partner]', rid, req.method, p, e.message); problem(res, rid, new PartnerError(500, 'INTERNAL', 'Internal error')); return true; }
    problem(res, rid, e);
  }
  return true;
}

module.exports = { handle, BASE, _buckets: buckets };
