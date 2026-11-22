// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Shopify Admin GraphQL client for the KINAN partner connector.
 *
 * - API version pinned by SHOPIFY_API_VERSION (default 2026-10, verified against shopify.dev when Batch 4 was built).
 * - Shop hosts are validated (<name>.myshopify.com only), so a request can never be pointed at another host.
 * - Tokens are expiring offline tokens (authorization code grant with expiring=1, or client credentials for KINAN's
 *   own development stores). Access tokens are refreshed shortly before they expire; a refresh rejected with 401 means
 *   the merchant must reinstall (state auth_failed).
 * - Every request has a 30 s timeout and refuses redirects. Throttling (429 / THROTTLED) is reported as retryable.
 * - Credentials are sealed (AES-256-GCM) in partner_connection.credentials and never logged. */
'use strict';
const pg = require('../pg');
const { J, seal, open } = require('../orders').internal;

const VERSION = () => process.env.SHOPIFY_API_VERSION || '2026-10';
const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const validShop = (s) => typeof s === 'string' && SHOP_RE.test(s);
const appKey = () => process.env.SHOPIFY_API_KEY || '';
const appSecret = () => process.env.SHOPIFY_API_SECRET || '';
const configured = () => !!(appKey() && appSecret());

class ShopifyError extends Error {
  constructor(message, { retryable = false, auth = false, status, userErrors } = {}) { super(message); Object.assign(this, { retryable, auth, status, userErrors }); }
}

let transport = (url, init) => fetch(url, init);
/** Tests route requests to a fake Shopify; production uses fetch. Every request refuses redirects and times out after 30 s. */
function setTransport(fn) { transport = fn || ((url, init) => fetch(url, init)); }

async function call(url, init) {
  try { return await transport(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30e3) }); } catch (e) { throw new ShopifyError(`Shopify unreachable: ${e.message}`, { retryable: true }); }
}

/** POST /admin/oauth/access_token with form fields; returns the token set as KINAN stores it. */
async function tokenRequest(shop, fields) {
  if (!validShop(shop)) throw new ShopifyError('Invalid shop domain');
  const r = await call(`https://${shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ client_id: appKey(), client_secret: appSecret(), ...fields }).toString() });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 400 || r.status === 403) throw new ShopifyError(`Token request refused (${r.status})`, { auth: true, status: r.status });
  if (!r.ok || !body.access_token) throw new ShopifyError(`Token request failed (${r.status})`, { retryable: r.status >= 500 || r.status === 429, status: r.status });
  const now = Date.now();
  return {
    access_token: body.access_token, refresh_token: body.refresh_token || null, scope: body.scope || '',
    expires_at: body.expires_in ? now + Number(body.expires_in) * 1000 : null,
    refresh_expires_at: body.refresh_token_expires_in ? now + Number(body.refresh_token_expires_in) * 1000 : null
  };
}
const exchangeCode = (shop, code) => tokenRequest(shop, { code, expiring: '1' });
const clientCredentials = (shop) => tokenRequest(shop, { grant_type: 'client_credentials' });

async function saveTokens(conn, t) {
  await pg.q('UPDATE partner_connection SET credentials = $2, scopes = COALESCE($3, scopes), updated_at = now() WHERE id = $1', [conn.id, J(seal(conn.env, t)), t.scope || null]);
  conn.credentials = seal(conn.env, t); conn._tokens = t;
}
async function markAuthFailed(conn, why) {
  await pg.q(`UPDATE partner_connection SET state = 'auth_failed', last_error = $2, updated_at = now() WHERE id = $1 AND state <> 'uninstalled'`, [conn.id, String(why).slice(0, 300)]);
  conn.state = 'auth_failed';
}

/** A valid access token for the connection, refreshing it when it expires within 5 minutes. */
async function accessToken(conn) {
  if (!conn.credentials) throw new ShopifyError('Connection has no credentials', { auth: true });
  const t = conn._tokens || open(conn.env, conn.credentials);
  if (!t.expires_at || t.expires_at - Date.now() > 5 * 60e3) { conn._tokens = t; return t.access_token; }
  try {
    const n = t.refresh_token ? await tokenRequest(conn.shop_domain, { grant_type: 'refresh_token', refresh_token: t.refresh_token })
      : await clientCredentials(conn.shop_domain); // dev-store connections have no refresh token
    await saveTokens(conn, n); return n.access_token;
  } catch (e) { if (e.auth) await markAuthFailed(conn, 'Shopify refused the token refresh. The merchant must reinstall the app.'); throw e; }
}

/**
 * Run one GraphQL operation. Returns data; throws ShopifyError (auth, retryable, or with userErrors).
 * `opts.idempotencyKey` is only documentation here: the key must be in the query text (@idempotent directive).
 */
async function gql(conn, query, variables = {}) {
  if (!validShop(conn.shop_domain)) throw new ShopifyError('Invalid shop domain');
  const send = async (token) => call(`https://${conn.shop_domain}/admin/api/${VERSION()}/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }) });
  let r = await send(await accessToken(conn));
  if (r.status === 401) {
    // the token may have been revoked or rotated: one refresh, then give up
    const t = open(conn.env, conn.credentials); conn._tokens = { ...t, expires_at: 0 };
    r = await send(await accessToken(conn));
    if (r.status === 401) { await markAuthFailed(conn, 'Shopify answered 401: the app was removed or its access revoked.'); throw new ShopifyError('Shopify access revoked', { auth: true, status: 401 }); }
  }
  if (r.status === 402 || r.status === 423) throw new ShopifyError(`Shop unavailable (${r.status})`, { status: r.status });
  if (r.status === 429 || r.status >= 500) throw new ShopifyError(`Shopify busy (${r.status})`, { retryable: true, status: r.status });
  const body = await r.json().catch(() => null);
  if (!body) throw new ShopifyError(`Unreadable Shopify answer (${r.status})`, { retryable: true, status: r.status });
  if (body.errors?.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
    throw new ShopifyError(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}`, { retryable: throttled });
  }
  return body.data;
}
/** Throw when a mutation payload carries userErrors. */
function ok(payload, what) {
  const errs = payload?.userErrors || [];
  if (errs.length) throw new ShopifyError(`${what}: ${errs.map((e) => `${(e.field || []).join('.')} ${e.message}`).join('; ').slice(0, 300)}`, { userErrors: errs });
  return payload;
}

module.exports = { VERSION, validShop, configured, appKey, appSecret, ShopifyError, setTransport, exchangeCode, clientCredentials, saveTokens, accessToken, gql, ok, markAuthFailed };
