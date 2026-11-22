// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* WooCommerce REST API (wc/v3) client for the KINAN partner connector.
 *
 * WooCommerce shops live on any domain, so every request goes through the same guard as partner webhooks:
 * https only, the host must resolve to public addresses only (checked on every request), and the connection is
 * pinned to the checked address (no DNS rebinding). Redirects are refused, requests time out after 30 s and answers
 * are capped at 5 MB. Authentication is HTTP Basic with the consumer key and secret over HTTPS.
 * Credentials ({consumer_key, consumer_secret, webhook_secret}) are sealed in partner_connection.credentials. */
'use strict';
const https = require('https');
const net = require('net');
const pg = require('../pg');
const W = require('../webhooks');
const { open } = require('../orders').internal;

const MAX_BYTES = 5 * 1024 * 1024;
class WooError extends Error {
  constructor(message, { retryable = false, auth = false, status, code } = {}) { super(message); Object.assign(this, { retryable, auth, status, code }); }
}

/** Normalise a shop address to https://host[:port][/path] (no trailing slash); throws 400-style errors. */
function normalizeBase(raw) {
  let u;
  try { u = W.checkUrl(String(raw || '').trim()); } catch (e) { const err = new Error(e.extra?.errors?.[0]?.detail || 'Enter the shop address as https://…'); err.status = 400; throw err; }
  if (u.search) { const err = new Error('Enter the shop address without ?query'); err.status = 400; throw err; }
  const path = u.pathname.replace(/\/+$/, '').replace(/\/wp-json.*$/, '');
  return { base: `https://${u.host}${path}`, key: `${u.host}${path}`.toLowerCase() };
}

/** Default transport: pinned HTTPS. Returns { status, headers, text }. */
async function pinned(url, { method = 'GET', headers = {}, body = null } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new WooError('Only https:// shops are supported');
  const address = await W.resolvePublic(u.hostname).catch((e) => { throw new WooError(e.private ? 'The shop address resolves to a private network address' : `Shop not reachable: ${e.message}`, { retryable: !e.private }); });
  return new Promise((resolve, reject) => {
    const req = https.request({
      method, host: u.hostname, servername: net.isIP(u.hostname) ? undefined : u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: 30e3,
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address, family: net.isIP(address) }]) : cb(null, address, net.isIP(address)))
    }, (res) => {
      let size = 0; const chunks = [];
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error('answer larger than 5 MB')); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout after 30 s')));
    req.on('error', reject);
    req.end(body || undefined);
  });
}
let transport = pinned;
/** Tests route requests to a fake WooCommerce; production uses the pinned HTTPS transport. */
function setTransport(fn) { transport = fn || pinned; }

async function markAuthFailed(c, why) {
  await pg.q(`UPDATE partner_connection SET state = 'auth_failed', last_error = $2, updated_at = now() WHERE id = $1 AND state <> 'uninstalled'`, [c.id, String(why).slice(0, 300)]);
  c.state = 'auth_failed';
}

/**
 * Call the wc/v3 API. `creds` overrides the connection's sealed credentials (used while connecting).
 * Returns { data, headers }. Throws WooError (auth → connection marked auth_failed, retryable for 429/5xx/network).
 */
async function api(c, method, path, { query, body, creds, namespace = 'wc/v3' } = {}) {
  const k = creds || open(c.env, c.credentials);
  const base = c.base || `https://${c.shop_domain}`;
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null))}` : '';
  const url = `${base}/wp-json/${namespace}${path}${qs}`;
  let r;
  try {
    r = await transport(url, { method, headers: { Authorization: `Basic ${Buffer.from(`${k.consumer_key}:${k.consumer_secret}`).toString('base64')}`, Accept: 'application/json', 'User-Agent': 'KINAN-Connector/1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : null });
  } catch (e) { if (e instanceof WooError) throw e; throw new WooError(`Shop not reachable: ${e.message}`, { retryable: true }); }
  let data = null; try { data = r.text ? JSON.parse(r.text) : null; } catch { /* not JSON */ }
  if (r.status >= 300 && r.status < 400) throw new WooError(`The shop redirected the request (${r.status}). Check the shop address (https, with or without www).`, { status: r.status });
  if (r.status === 401 || r.status === 403) {
    if (!creds) await markAuthFailed(c, 'WooCommerce refused the API key (deleted, or permissions changed). Connect the shop again.');
    throw new WooError(`WooCommerce refused the API key (${r.status})`, { auth: true, status: r.status, code: data?.code });
  }
  if (r.status === 429 || r.status >= 500) throw new WooError(`Shop busy (${r.status})`, { retryable: true, status: r.status });
  if (r.status >= 400) throw new WooError(`WooCommerce: ${(data && (data.message || data.code)) || r.status}`.slice(0, 300), { status: r.status, code: data?.code });
  if (data === null && r.text) throw new WooError('The shop answered something that is not JSON. Is WooCommerce installed and are pretty permalinks on?', { status: r.status });
  return { data, headers: r.headers || {} };
}

module.exports = { WooError, normalizeBase, setTransport, api, markAuthFailed, _pinned: pinned };
