// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * CJdropshipping API 2.0 client (https://developers.cjdropshipping.com/api2.0/v1/).
 * - Sign-in with the account's API key (CJ_API_KEY) → access token (180 days) + refresh token, kept in the database.
 * - CJ allows 1 request per second: every call goes through one queue.
 * - Responses are { code, result, message, data }; anything but result=true / code=200 is an error.
 */
const db = require('../db');

const BASE = process.env.CJ_API_URL || 'https://developers.cjdropshipping.com/api2.0/v1';
const SID = 'set_cj_token';
const enabled = () => Boolean(process.env.CJ_API_KEY);

class CjError extends Error {
  constructor(message, code, status = 502) { super(message); this.code = code; this.status = status; }
}

// ---------------- one call per second ----------------
let chain = Promise.resolve(); let last = 0;
const GAP = Number(process.env.CJ_MIN_GAP_MS ?? 1100);
function queued(fn) {
  const run = chain.then(async () => {
    const wait = last + GAP - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

async function raw(method, path, { query, body, token } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    for (const x of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(x));
  }
  const r = await fetch(url, {
    method, signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(token ? { 'CJ-Access-Token': token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let j; try { j = await r.json(); } catch { throw new CjError(`CJ answered ${r.status}`, r.status); }
  if (r.status === 429 || j.code === 1600200) throw new CjError('CJ is busy (too many requests) — try again in a moment', j.code, 429);
  if (!(j.result === true || j.code === 200) || (j.success === false)) throw new CjError(`CJ: ${j.message || 'request failed'}`, j.code);
  return j.data;
}

// ---------------- tokens ----------------
function saved() { return db.settings.get(SID) || null; }
function save(d) {
  const doc = {
    access_token: d.accessToken, refresh_token: d.refreshToken, open_id: d.openId != null ? String(d.openId) : saved()?.open_id || null,
    access_expires_at: d.accessTokenExpiryDate ? new Date(d.accessTokenExpiryDate).getTime() || null : null,
    refresh_expires_at: d.refreshTokenExpiryDate ? new Date(d.refreshTokenExpiryDate).getTime() || null : null,
    key_hint: String(process.env.CJ_API_KEY || '').slice(-6), updated_at: Date.now()
  };
  return saved() ? db.settings.update(SID, doc) : db.settings.insert({ id: SID, ...doc });
}

let inflight = null;
async function token({ force = false } = {}) {
  if (!enabled()) throw new CjError('CJdropshipping is not connected — add CJ_API_KEY on the server', 'NO_KEY', 503);
  const s = saved();
  const sameKey = s && s.key_hint === String(process.env.CJ_API_KEY).slice(-6);
  const fresh = sameKey && s.access_token && (!s.access_expires_at || s.access_expires_at - Date.now() > 2 * 86400e3);
  if (fresh && !force) return s.access_token;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (sameKey && s.refresh_token && (!s.refresh_expires_at || s.refresh_expires_at > Date.now())) {
        try { return save(await queued(() => raw('POST', '/authentication/refreshAccessToken', { body: { refreshToken: s.refresh_token } }))).access_token; } catch { /* fall back to a new sign-in */ }
      }
      return save(await queued(() => raw('POST', '/authentication/getAccessToken', { body: { apiKey: process.env.CJ_API_KEY } }))).access_token;
    } finally { inflight = null; }
  })();
  return inflight;
}

/** Authenticated call; signs in again once if CJ says the token is no longer valid. */
async function call(method, path, opts = {}) {
  const t = await token();
  try { return await queued(() => raw(method, path, { ...opts, token: t })); }
  catch (e) {
    if ([1600001, 1600002, 1600003].includes(Number(e.code))) { const t2 = await token({ force: true }); return queued(() => raw(method, path, { ...opts, token: t2 })); }
    throw e;
  }
}

const openId = () => saved()?.open_id || null;

module.exports = { call, token, enabled, openId, CjError, BASE };
