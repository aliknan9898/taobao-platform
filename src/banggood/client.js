// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Banggood Dropship API client (https://api.banggood.com, Open Platform "Dropship" documents).
 * - GET /getAccessToken?app_id=&app_secret= → { code: 0, access_token, expires_in }; kept in the database.
 * - Every other call carries access_token, lang=en and currency=USD; code 0 = success.
 * - 21020 = token expired, 21030 / 11020 = token missing or wrong → sign in again once.
 * - Banggood only answers from the server IP addresses registered in its Open Platform.
 * - BANGGOOD_SANDBOX=1 uses apibeta.banggood.com with apiTest=1.
 */
const db = require('../db');

const SANDBOX = () => process.env.BANGGOOD_SANDBOX === '1';
const BASE = () => process.env.BANGGOOD_API_URL || (SANDBOX() ? 'https://apibeta.banggood.com' : 'https://api.banggood.com');
const SID = 'set_banggood_token';
const enabled = () => Boolean(process.env.BANGGOOD_APP_ID && process.env.BANGGOOD_APP_SECRET);

class BanggoodError extends Error {
  constructor(message, code, status = 502) { super(message); this.code = code; this.status = status; }
}
const TOKEN_CODES = new Set([21020, 21030, 11020]);
const MESSAGES = {
  12029: 'Quantity must be below 100', 12031: 'Unknown Banggood warehouse', 12032: 'Banggood does not recognise this country',
  12033: 'Unknown product option (poa_id)', 12034: 'Unknown Banggood product', 12027: 'Product ID is missing', 12087: 'This product is no longer sold on Banggood',
  12082: 'Too many orders asked at once', 12062: 'This order was already sent to Banggood', 1: 'Banggood could not add the order — open banggood.com → ApiOrderList', 31010: 'Banggood refused this server — register the server’s IP addresses in the Banggood Open Platform',
  12021: 'Choose a category', 12022: 'Choose a sub-category (Banggood does not list root categories)',
  41010: 'Banggood call limit reached — Banggood blocks calls for up to 48 hours', 21030: 'Banggood token mismatch', 21020: 'Banggood token expired', 31020: 'Banggood account error — check the Dropship program approval and the server IP addresses'
};

// One call at a time, a short gap between calls (Banggood publishes no rate limit)
let chain = Promise.resolve(); let last = 0;
const GAP = Number(process.env.BANGGOOD_MIN_GAP_MS ?? 300);
function queued(fn) {
  const run = chain.then(async () => { const w = last + GAP - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); last = Date.now(); return fn(); });
  chain = run.catch(() => {});
  return run;
}

/** PHP-style form encoding (product_list[0][product_id]=…) as the official sample sends it. */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}

async function raw(method, path, params = {}, { accept = [] } = {}) {
  const url = new URL(`${BASE()}/${path.replace(/^\//, '')}`);
  const all = { ...params, ...(SANDBOX() ? { apiTest: 1 } : {}) };
  const init = { method, signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } };
  if (method === 'GET') for (const [k, v] of Object.entries(all)) { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); }
  else { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = form(all).toString(); }
  const r = await fetch(url, init);
  let j; try { j = await r.json(); } catch { throw new BanggoodError(`Banggood answered ${r.status}`, r.status); }
  const code = Number(j.code ?? j.error ?? 0); // the Translate API answers with "error" instead of "code"
  if (code !== 0 && accept.includes(code)) return j; // e.g. importOrder answers 1 with the failed products listed
  if (code !== 0) throw new BanggoodError(`Banggood: ${MESSAGES[code] || j.msg || j.errMsg || 'request failed'} (${code})`, code, code === 12034 || code === 12087 ? 404 : 502);
  return j;
}

function saved() { return db.settings.get(SID) || null; }
let inflight = null;
async function token({ force = false } = {}) {
  if (!enabled()) throw new BanggoodError('Banggood is not connected — add BANGGOOD_APP_ID and BANGGOOD_APP_SECRET on the server', 'NO_KEY', 503);
  const s = saved();
  const hint = String(process.env.BANGGOOD_APP_ID).slice(-6);
  if (!force && s && s.app_hint === hint && s.access_token && s.expires_at - Date.now() > 10 * 60e3) return s.access_token;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const j = await queued(() => raw('GET', 'getAccessToken', { app_id: process.env.BANGGOOD_APP_ID, app_secret: process.env.BANGGOOD_APP_SECRET }));
      if (!j.access_token) throw new BanggoodError('Banggood did not return an access token', 'NO_TOKEN');
      const doc = { access_token: j.access_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000, app_hint: hint, updated_at: Date.now() };
      saved() ? db.settings.update(SID, doc) : db.settings.insert({ id: SID, ...doc });
      return j.access_token;
    } finally { inflight = null; }
  })();
  return inflight;
}

/** Authenticated call; signs in again once when Banggood says the token is expired or wrong. */
async function call(method, path, params = {}, opts = {}) {
  const withToken = (t) => ({ ...params, access_token: t, lang: params.lang || 'en', currency: params.currency || 'USD' });
  const t = await token();
  try { return await queued(() => raw(method, path, withToken(t), opts)); }
  catch (e) {
    if (TOKEN_CODES.has(Number(e.code))) { const t2 = await token({ force: true }); return queued(() => raw(method, path, withToken(t2), opts)); }
    throw e;
  }
}

module.exports = { call, token, enabled, BanggoodError, form, BASE };
