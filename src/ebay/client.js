'use strict';
/**
 * eBay REST APIs (Sell Inventory, Account, Fulfillment; Commerce Taxonomy).
 * Keys come from env only: EBAY_CLIENT_ID (App ID), EBAY_CLIENT_SECRET (Cert ID), EBAY_RUNAME (redirect URL name),
 * EBAY_ENV = sandbox | production. The seller's sign-in (user token + refresh token) is kept in settings.
 */
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../auth');

const SID = 'ebay_auth';
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment'
];

const env = () => (String(process.env.EBAY_ENV || '').toLowerCase() === 'production' ? 'production' : 'sandbox');
const sandbox = () => env() === 'sandbox';
const apiBase = () => (sandbox() ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com');
const authBase = () => (sandbox() ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com');
const configured = () => Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && process.env.EBAY_RUNAME);
const basic = () => Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');

function saved() { return db.settings.get(SID) || null; }
function save(doc) { const s = saved(); return s ? db.settings.update(SID, doc) : db.settings.insert({ id: SID, ...doc }); }
function connected() { const s = saved(); return Boolean(configured() && s && s.refresh_token && s.env === env() && (s.refresh_exp || 0) > Date.now()); }

async function token(form) {
  if (!configured()) throw httpError(503, 'eBay keys are not set yet (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME)');
  const res = await fetch(`${apiBase()}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20000)
  }).catch((e) => { throw httpError(502, `eBay could not be reached (${e.message})`); });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status === 400 || res.status === 401 ? 400 : 502, `eBay sign-in failed: ${j.error_description || j.error || res.status}`);
  return j;
}

/** The link the admin opens to let Kinan list on their eBay account. */
function authUrl() {
  if (!configured()) throw httpError(503, 'eBay keys are not set yet (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME)');
  const state = crypto.randomBytes(16).toString('hex');
  db.oauthStates.insert({ state, kind: 'ebay', created_at: Date.now() });
  const q = new URLSearchParams({ client_id: process.env.EBAY_CLIENT_ID, redirect_uri: process.env.EBAY_RUNAME, response_type: 'code', scope: SCOPES.join(' '), state });
  return `${authBase()}/oauth2/authorize?${q}`;
}

async function handleCallback(code, state) {
  const st = state && db.oauthStates.all((x) => x.state === state && x.kind === 'ebay')[0];
  if (!st || Date.now() - st.created_at > 30 * 60e3) throw httpError(400, 'The eBay link expired — press Connect again');
  db.oauthStates.remove(st.id);
  if (!code) throw httpError(400, 'eBay did not send a sign-in code');
  const j = await token({ grant_type: 'authorization_code', code, redirect_uri: process.env.EBAY_RUNAME });
  save({ env: env(), access_token: j.access_token, access_exp: Date.now() + (j.expires_in - 120) * 1000, refresh_token: j.refresh_token, refresh_exp: Date.now() + (j.refresh_token_expires_in || 47304000) * 1000, connected_at: Date.now() });
  return true;
}

function disconnect() { const s = saved(); if (s) db.settings.update(SID, { access_token: null, refresh_token: null, refresh_exp: 0 }); }

async function userToken() {
  const s = saved();
  if (!connected()) throw httpError(409, 'eBay is not connected — press Connect eBay in the admin');
  if (s.access_token && s.access_exp > Date.now()) return s.access_token;
  const j = await token({ grant_type: 'refresh_token', refresh_token: s.refresh_token, scope: SCOPES.join(' ') });
  save({ access_token: j.access_token, access_exp: Date.now() + (j.expires_in - 120) * 1000 });
  return j.access_token;
}

let app = null;
async function appToken() {
  if (app && app.exp > Date.now() && app.env === env()) return app.token;
  const j = await token({ grant_type: 'client_credentials', scope: SCOPES[0] });
  app = { token: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000, env: env() };
  return app.token;
}

/** One API call. Errors carry eBay's own message and error ids (e.errors). */
async function api(method, path, body, { user = true, lang, marketplace, query } = {}) {
  const t = user ? await userToken() : await appToken();
  const headers = { Authorization: `Bearer ${t}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (lang) { headers['Content-Language'] = lang; headers['Accept-Language'] = lang; }
  if (marketplace) headers['X-EBAY-C-MARKETPLACE-ID'] = marketplace;
  const url = `${apiBase()}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
    .catch((e) => { throw httpError(502, `eBay could not be reached (${e.message})`); });
  if (res.status === 204) return {};
  const text = await res.text();
  let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
  if (!res.ok) {
    const errs = j.errors || [];
    const msg = errs.map((x) => x.longMessage || x.message).filter(Boolean).join(' · ') || `HTTP ${res.status}`;
    const e = httpError(res.status >= 500 ? 502 : res.status === 401 ? 409 : 400, `eBay: ${msg}`.slice(0, 600));
    e.errors = errs; e.ebayStatus = res.status;
    throw e;
  }
  // Partial success (e.g. bulk calls) also lists warnings
  return j;
}

/** eBay's Marketplace Account Deletion check: sha256(challengeCode + verificationToken + endpoint). */
function challenge(code, endpoint) {
  return crypto.createHash('sha256').update(String(code)).update(String(process.env.EBAY_VERIFICATION_TOKEN || '')).update(endpoint).digest('hex');
}

function status() {
  const s = saved();
  return { configured: configured(), env: env(), connected: connected(), connected_at: s?.connected_at || null, refresh_expires_at: s?.refresh_exp || null, deletion_token_set: Boolean(process.env.EBAY_VERIFICATION_TOKEN) };
}

module.exports = { api, authUrl, handleCallback, disconnect, connected, configured, env, status, challenge, SCOPES, _reset: () => { app = null; } };
