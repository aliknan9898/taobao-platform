// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Partner organisations, stores, API keys and entitlements (managed by KINAN admins only).
 *
 * Keys: "knp_test_…" (sandbox) or "knp_live_…" (production), 32 random base62 characters after the prefix.
 * Only a SHA-256 hash and a short lookup prefix are stored; the full key is shown once when issued.
 * Live keys cannot be issued until the owner enables production (PARTNER_LIVE_ENABLED=1). */
'use strict';
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../auth');

const SCOPES = ['catalog:read', 'quotes:write', 'orders:write', 'orders:read', 'returns:write', 'returns:read', 'documents:read', 'webhooks:manage'];
const BATCH1_SCOPES = ['catalog:read', 'quotes:write', 'orders:write', 'orders:read']; // Batches 1–2 (kept for keys issued before Batch 3)
const AVAILABLE_SCOPES = SCOPES; // every scope has endpoints since Batch 3
const MARKETS = ['DE', 'GB', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'IE', 'MT', 'PL', 'SE'];
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const liveEnabled = () => process.env.PARTNER_LIVE_ENABLED === '1';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function randomB62(n) { const b = crypto.randomBytes(n * 2); let out = ''; for (let i = 0; out.length < n && i < b.length; i++) if (b[i] < 248) out += B62[b[i] % 62]; return out.length === n ? out : randomB62(n); }

const clean = (s, max = 120) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function createOrg({ name, contact_email, notes } = {}, by) {
  const n = clean(name); if (n.length < 2) throw httpError(400, 'Organisation name is required');
  return db.partner_orgs.insert({ name: n, contact_email: clean(contact_email, 160) || null, notes: clean(notes, 600), status: 'active', created_by: by?.id || null });
}

/** A store belongs to one organisation; entitlements decide what its keys can see. */
function createStore(orgId, { name, platform = 'custom', markets = ['DE'], categories = [], excluded = [], locales = ['en'], markup_pct = 0 } = {}, by) {
  const org = db.partner_orgs.get(String(orgId)); if (!org) throw httpError(404, 'Organisation not found');
  const n = clean(name); if (n.length < 2) throw httpError(400, 'Store name is required');
  return db.partner_stores.insert({ org_id: org.id, name: n, platform: clean(platform, 40), status: 'active', entitlements: normEnt({ markets, categories, excluded, locales }), price_list: { version: 1, markup_pct: Math.max(0, Number(markup_pct) || 0), currency: 'EUR' }, created_by: by?.id || null });
}

function normEnt({ markets = [], categories = [], excluded = [], locales = ['en'] } = {}) {
  const m = [...new Set((Array.isArray(markets) ? markets : String(markets).split(',')).map((x) => String(x).trim().toUpperCase()).filter((x) => MARKETS.includes(x)))];
  if (!m.length) throw httpError(400, `Choose at least one market (${MARKETS.join(', ')})`);
  const list = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean))].slice(0, 500);
  return { markets: m, categories: list(categories), excluded: list(excluded), locales: list(locales).length ? list(locales) : ['en'] };
}

/** Change what a store may see. Emits store-scoped withdraw/upsert events so its feed converges (see catalog.js). */
function updateStore(storeId, patch = {}, by) {
  const st = db.partner_stores.get(String(storeId)); if (!st) throw httpError(404, 'Store not found');
  const next = {};
  if (patch.name !== undefined) next.name = clean(patch.name);
  if (patch.status !== undefined) { if (!['active', 'paused'].includes(patch.status)) throw httpError(400, 'Status must be active or paused'); next.status = patch.status; }
  if (patch.markup_pct !== undefined) next.price_list = { ...st.price_list, markup_pct: Math.max(0, Number(patch.markup_pct) || 0), version: (st.price_list?.version || 1) + 1 };
  const entChanged = ['markets', 'categories', 'excluded', 'locales'].some((k) => patch[k] !== undefined);
  const before = st.entitlements;
  if (entChanged) next.entitlements = normEnt({ ...before, ...Object.fromEntries(['markets', 'categories', 'excluded', 'locales'].filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])) });
  const out = db.partner_stores.update(st.id, { ...next, updated_by: by?.id || null });
  if (entChanged || next.price_list) require('./catalog').entitlementChanged(out, before, !!next.price_list);
  return out;
}

function issueKey(storeId, { env = 'sandbox', scopes = AVAILABLE_SCOPES, label = '' } = {}, by) {
  const st = db.partner_stores.get(String(storeId)); if (!st) throw httpError(404, 'Store not found');
  if (!['sandbox', 'live'].includes(env)) throw httpError(400, 'Environment must be sandbox or live');
  if (env === 'live' && !liveEnabled()) throw httpError(403, 'Live partner keys are switched off until the owner approves production (PARTNER_LIVE_ENABLED)');
  const sc = [...new Set((Array.isArray(scopes) ? scopes : String(scopes).split(',')).map((x) => String(x).trim()).filter(Boolean))];
  const bad = sc.filter((x) => !SCOPES.includes(x)); if (bad.length || !sc.length) throw httpError(400, `Unknown scopes: ${bad.join(', ') || 'none chosen'}`);
  const secret = `knp_${env === 'live' ? 'live' : 'test'}_${randomB62(32)}`;
  const rec = db.partner_keys.insert({ store_id: st.id, env, prefix: secret.slice(0, 17), hash: sha(secret), scopes: sc, label: clean(label, 60), created_by: by?.id || null, last_used_at: null, revoked_at: null });
  return { key: secret, id: rec.id, prefix: rec.prefix, env, scopes: sc, note: 'Copy this key now — it is not shown again.' };
}

function revokeKey(keyId, by) {
  const k = db.partner_keys.get(String(keyId)); if (!k) throw httpError(404, 'Key not found');
  if (k.revoked_at) return k;
  return db.partner_keys.update(k.id, { revoked_at: Date.now(), revoked_by: by?.id || null });
}

/** Resolve a bearer key to { key, store, org }; null when unknown, revoked, or the store/org is not usable. */
function resolve(secret) {
  const s = String(secret || '');
  if (!/^knp_(test|live)_[0-9A-Za-z]{32}$/.test(s)) return null;
  const k = db.partner_keys.find((x) => x.prefix === s.slice(0, 17));
  if (!k || k.revoked_at) return null;
  const a = Buffer.from(k.hash, 'hex'); const b = Buffer.from(sha(s), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (k.env === 'live' && !liveEnabled()) return null;
  const store = db.partner_stores.get(k.store_id); const org = store && db.partner_orgs.get(store.org_id);
  if (!store || !org || org.status !== 'active') return null;
  if (!k.last_used_at || Date.now() - k.last_used_at > 60e3) db.partner_keys.update(k.id, { last_used_at: Date.now() });
  return { key: k, store, org };
}

/** Admin overview: organisations with their stores and key metadata (never hashes). */
function overview() {
  const keys = db.partner_keys.all();
  return {
    live_enabled: liveEnabled(), markets: MARKETS, scopes: SCOPES, available_scopes: AVAILABLE_SCOPES,
    orgs: db.partner_orgs.all().map((o) => ({ ...o, stores: db.partner_stores.all((s) => s.org_id === o.id).map((s) => ({ ...s, keys: keys.filter((k) => k.store_id === s.id).map(({ hash, ...k }) => k) })) }))
  };
}

module.exports = { SCOPES, BATCH1_SCOPES, AVAILABLE_SCOPES, MARKETS, createOrg, createStore, updateStore, issueKey, revokeKey, resolve, overview, liveEnabled, _sha: sha };
