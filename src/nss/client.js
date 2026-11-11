// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * NextSmartShip Open API (version 2026-07-01): China warehouse + international shipping.
 * OAuth2 client credentials (NSS_CLIENT_ID / NSS_CLIENT_SECRET) → Bearer token valid 24 h.
 */
const BASE = (process.env.NSS_API_URL || 'https://api.nextsmartship.com').replace(/\/$/, '');
const VERSION = '2026-07-01';
const enabled = () => Boolean(process.env.NSS_CLIENT_ID && process.env.NSS_CLIENT_SECRET);

class NssError extends Error { constructor(message, status, code, fields) { super(message); this.status = status >= 400 && status < 500 ? 502 : 502; this.httpStatus = status; this.code = code; this.fields = fields; } }

let tok = null; let inflight = null;
async function token(force = false) {
  if (!enabled()) throw new NssError('NextSmartShip is not connected — add NSS_CLIENT_ID and NSS_CLIENT_SECRET', 503, 'NO_KEY');
  if (!force && tok && tok.exp - Date.now() > 10 * 60e3) return tok.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(`${BASE}/oauth/token`, {
        method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: process.env.NSS_CLIENT_ID, client_secret: process.env.NSS_CLIENT_SECRET, grant_type: 'client_credentials' })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) throw new NssError(`NextSmartShip sign-in failed (${r.status}) ${j.error?.message || j.error_description || j.error || ''}`.trim(), r.status, 'AUTH');
      tok = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 };
      return tok.value;
    } finally { inflight = null; }
  })();
  return inflight;
}

/** Call /api/2026-07-01/<path>. Signs in again once if the token was rejected. */
async function call(method, path, { query, body } = {}, retry = true) {
  const url = new URL(`${BASE}/api/${VERSION}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const r = await fetch(url, { method, signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry) { tok = null; return call(method, path, { query, body }, false); }
  const text = await r.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw new NssError(`NextSmartShip: ${j.error?.message || j.message || `HTTP ${r.status}`}`, r.status, j.error?.code, j.error?.fields);
  return j;
}

/** Start-up check: sign in and read the account balance. */
async function check() {
  if (!enabled()) return { ok: false, message: 'not configured' };
  try { const b = await call('GET', '/balance'); return { ok: true, message: `signed in · balance ${JSON.stringify(b.data ?? b).slice(0, 160)}` }; }
  catch (e) { return { ok: false, message: e.message }; }
}

module.exports = { call, token, enabled, check, NssError, BASE, VERSION };
