// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Taobao authorization.
 * Kinan's own Distribution Platform account (connected once by the admin) is used for every seller: sellers
 * never sign in to Taobao, and Kinan buys and pays each purchase order. A seller's own account (older setup)
 * is only used while Kinan's account is not connected.
 */
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { call } = require('./client');
const API = require('./apis');

const DAY = 86400e3;
const STATE_TTL = 30 * 60e3;

const PLATFORM = 'set_taobao_platform';
const PREFS = 'set_taobao_prefs';
const platform = () => db.settings.get(PLATFORM)?.taobao || null;
const platformConnected = () => { const t = platform(); return Boolean(t && t.access_token && t.expires_at > Date.now()); };
function savePlatform(t) { const doc = { taobao: t }; return db.settings.get(PLATFORM) ? db.settings.update(PLATFORM, doc) : db.settings.insert({ id: PLATFORM, ...doc }); }
/** Kinan's Taobao settings: pay purchase orders automatically from Kinan's balance. */
function prefs() { return { auto_pay: true, ...(db.settings.get(PREFS) || {}) }; }
function savePrefs(b = {}) {
  const doc = { auto_pay: b.auto_pay === undefined ? prefs().auto_pay : Boolean(b.auto_pay) };
  db.settings.get(PREFS) ? db.settings.update(PREFS, doc) : db.settings.insert({ id: PREFS, ...doc });
  return prefs();
}

/** sellerId = null: connect Kinan's own account (admin). */
function buildAuthorizeUrl(sellerId, returnTo) {
  const state = crypto.randomBytes(16).toString('hex');
  db.oauthStates.insert({ id: `st_${state}`, seller_id: sellerId || null, platform: !sellerId, return_to: returnTo || null, expires_at: Date.now() + STATE_TTL });
  const u = new URL(config.authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', config.redirectUri);
  u.searchParams.set('force_auth', 'true');
  u.searchParams.set('client_id', config.appKey);
  u.searchParams.set('state', state);
  return u.toString();
}

function normalize(r) {
  const now = Date.now();
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: now + Number(r.expires_in || 0) * 1000,
    refresh_expires_at: Number(r.refresh_expires_in || 0) > 0 ? now + Number(r.refresh_expires_in) * 1000 : 0,
    taobao_seller_id: String(r.seller_id || r.seller_Id || ''),
    account: r.account,
    short_code: r.short_code
  };
}

async function handleCallback(code, state) {
  const st = db.oauthStates.get(`st_${state}`);
  if (state) db.oauthStates.remove(`st_${state}`);
  if (!st || st.expires_at < Date.now()) throw Object.assign(new Error('The connection request expired, please try again'), { status: 400 });
  const r = await call(API.TOKEN_CREATE, { code });
  const t = normalize(r);
  if (!t.access_token) throw new Error('Taobao did not return an access token');
  if (st.platform) { savePlatform({ ...t, connected_at: Date.now() }); return { platform: true, return_to: st.return_to }; }
  // One distribution account ↔ one seller on your platform
  const clash = db.sellers.find((s) => s.id !== st.seller_id && s.taobao && s.taobao.taobao_seller_id && s.taobao.taobao_seller_id === t.taobao_seller_id);
  if (clash) throw Object.assign(new Error('This Distribution Platform account is already linked to another seller'), { status: 409 });
  db.sellers.update(st.seller_id, { taobao: { ...t, connected_at: Date.now() } });
  return { seller_id: st.seller_id, return_to: st.return_to };
}

/** Refresh a token record (Kinan's or a seller's) and store the new one with save(). */
async function refreshWith(t, save) {
  if (!t || !t.refresh_token || !t.refresh_expires_at || t.refresh_expires_at <= Date.now()) {
    throw Object.assign(new Error('Taobao authorization expired — reconnect required'), { status: 401 });
  }
  const r = await call(API.TOKEN_REFRESH, { refresh_token: t.refresh_token });
  const n = normalize(r);
  n.refresh_expires_at = t.refresh_expires_at; // not reset by refresh
  if (!n.taobao_seller_id) n.taobao_seller_id = t.taobao_seller_id;
  save({ ...t, ...n });
  return n.access_token;
}
async function validToken(t, save, who) {
  if (t.expires_at - Date.now() < 7 * DAY && t.refresh_expires_at > Date.now()) {
    try { return await refreshWith(t, save); } catch (e) { if (t.expires_at > Date.now()) return t.access_token; throw e; }
  }
  if (t.expires_at <= Date.now()) throw Object.assign(new Error(`Taobao authorization expired for ${who} — reconnect in the admin dashboard`), { status: 401 });
  return t.access_token;
}

/** The token used for a seller's Taobao calls: Kinan's account when connected, else the seller's own. */
async function tokenFor(sellerId) {
  const p = platform();
  if (p && p.access_token) return validToken(p, (t) => savePlatform(t), 'Kinan’s Taobao account');
  const s = sellerId && db.sellers.get(sellerId);
  const t = s && s.taobao;
  if (!t) throw Object.assign(new Error('Kinan’s Taobao account is not connected yet — the admin connects it in the dashboard'), { status: 409 });
  return validToken(t, (x) => db.sellers.update(sellerId, { taobao: x }), 'this seller');
}

/** What the admin sees about Kinan's account. */
function platformStatus() { return { ...status({ taobao: platform() }), configured: Boolean(config.appKey), prefs: prefs() }; }

function status(seller) {
  const t = seller && seller.taobao;
  if (!t) return { connected: false };
  return {
    connected: t.expires_at > Date.now(),
    account: t.account,
    expires_at: t.expires_at,
    refresh_expires_at: t.refresh_expires_at,
    needs_reauth_soon: Boolean(t.refresh_expires_at && t.refresh_expires_at - Date.now() < 7 * DAY)
  };
}

function disconnectPlatform() { db.settings.remove(PLATFORM); }

/** First start with Kinan's account: if the owner already connected Taobao in their own seller shop, that becomes Kinan's account. */
function adoptOwnerToken() {
  if (platform()) return false;
  const { isOwner } = require('../auth');
  const s = db.sellers.find((x) => x.taobao && x.taobao.access_token && isOwner(db.users.get(x.user_id)));
  if (!s) return false;
  savePlatform({ ...s.taobao, adopted_from_seller: s.id, connected_at: s.taobao.connected_at || Date.now() });
  console.log(`[taobao] Kinan's Taobao account set from the owner's shop (${s.taobao.account || s.id}) — used for every seller now`);
  return true;
}

async function refreshAllDue() {
  if (platform()) { try { await tokenFor(null); } catch { /* shown in the admin dashboard */ } }
  for (const s of db.sellers.all((x) => x.taobao)) {
    try { await tokenFor(s.id); } catch { /* surfaced in dashboard */ }
  }
}

module.exports = { buildAuthorizeUrl, handleCallback, tokenFor, status, refreshAllDue, platformConnected, platformStatus, prefs, savePrefs, disconnectPlatform, adoptOwnerToken };
