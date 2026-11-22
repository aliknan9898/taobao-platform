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

/** Handles the request when it is for the Partner API; returns false otherwise. */
async function handle(req, res, p, url) {
  if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
  const rid = `req_${crypto.randomBytes(9).toString('base64url')}`;
  try {
    if (req.method === 'GET' && p === `${BASE}/openapi.json`) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': rid, 'Cache-Control': 'public, max-age=300' });
      res.end(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'partner-api', 'openapi.json'))); return true;
    }
    if (req.method !== 'GET') throw new PartnerError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', 'Batch 1 of the Partner API is read-only (catalogue).');
    const ctx = authn(req);
    if (ctx.store.status !== 'active') throw new PartnerError(503, 'TEMPORARILY_UNAVAILABLE', 'Store paused', 'KINAN has paused this store’s API access. Contact your KINAN account manager.');
    const wait = take(ctx.store.id);
    if (wait) { problem(res, rid, new PartnerError(429, 'RATE_LIMITED', 'Too many requests', `Limit is ${RATE()} requests per minute per store.`), { 'Retry-After': String(wait) }); return true; }
    const sub = p.slice(BASE.length);
    let out;
    if (sub === '/me') {
      out = {
        environment: ctx.env, organization: { id: ctx.org.id, name: ctx.org.name }, store: { id: ctx.store.id, name: ctx.store.name, platform: ctx.store.platform },
        scopes: ctx.key.scopes, markets: ctx.store.entitlements.markets, locales: ctx.store.entitlements.locales, currencies: ['EUR'],
        price_list: { version: ctx.store.price_list?.version || 1, currency: 'EUR' }, api_version: 'v1'
      };
    } else if (sub === '/catalog/products') {
      need(ctx, 'catalog:read'); out = catalog.snapshot(ctx, marketLocale(ctx, url));
    } else if (sub.startsWith('/catalog/products/')) {
      need(ctx, 'catalog:read');
      const id = decodeURIComponent(sub.slice('/catalog/products/'.length));
      if (!/^kp_[A-Za-z0-9_]{1,80}$/.test(id)) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Product not found');
      out = catalog.product(ctx, id, marketLocale(ctx, url));
    } else if (sub === '/catalog/changes') {
      need(ctx, 'catalog:read'); out = catalog.changes(ctx, marketLocale(ctx, url));
    } else {
      throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Not found', 'Unknown Partner API path. See /api/partner/v1/openapi.json.');
    }
    send(res, 200, out, rid);
  } catch (e) {
    if (!(e instanceof PartnerError) && !e.code) { console.error('[partner]', rid, req.method, p, e.message); problem(res, rid, new PartnerError(500, 'INTERNAL', 'Internal error')); return true; }
    problem(res, rid, e);
  }
  return true;
}

module.exports = { handle, BASE, _buckets: buckets };
