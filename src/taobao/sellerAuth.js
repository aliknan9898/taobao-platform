'use strict';
/**
 * Per-seller Taobao authorization.
 * Each merchant on your platform authorizes YOUR app with THEIR OWN distribution-platform account
 * ("Allow logged-in users" policy for ERP apps). Purchases are made and paid from their account.
 */
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { call } = require('./client');
const API = require('./apis');

const DAY = 86400e3;
const STATE_TTL = 30 * 60e3;

function buildAuthorizeUrl(sellerId, returnTo) {
  const state = crypto.randomBytes(16).toString('hex');
  db.oauthStates.insert({ id: `st_${state}`, seller_id: sellerId, return_to: returnTo || null, expires_at: Date.now() + STATE_TTL });
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
  // One distribution account ↔ one seller on your platform
  const clash = db.sellers.find((s) => s.id !== st.seller_id && s.taobao && s.taobao.taobao_seller_id && s.taobao.taobao_seller_id === t.taobao_seller_id);
  if (clash) throw Object.assign(new Error('This Distribution Platform account is already linked to another seller'), { status: 409 });
  db.sellers.update(st.seller_id, { taobao: { ...t, connected_at: Date.now() } });
  return { seller_id: st.seller_id, return_to: st.return_to };
}

async function refresh(sellerId) {
  const s = db.sellers.get(sellerId);
  const t = s && s.taobao;
  if (!t || !t.refresh_token || !t.refresh_expires_at || t.refresh_expires_at <= Date.now()) {
    throw Object.assign(new Error('Taobao authorization expired for this seller — reconnect required'), { status: 401 });
  }
  const r = await call(API.TOKEN_REFRESH, { refresh_token: t.refresh_token });
  const n = normalize(r);
  n.refresh_expires_at = t.refresh_expires_at; // not reset by refresh
  if (!n.taobao_seller_id) n.taobao_seller_id = t.taobao_seller_id;
  db.sellers.update(sellerId, { taobao: { ...t, ...n } });
  return n.access_token;
}

async function tokenFor(sellerId) {
  const s = db.sellers.get(sellerId);
  const t = s && s.taobao;
  if (!t) throw Object.assign(new Error('The seller has not connected a Distribution Platform account yet'), { status: 409 });
  if (t.expires_at - Date.now() < 7 * DAY && t.refresh_expires_at > Date.now()) {
    try { return await refresh(sellerId); } catch (e) { if (t.expires_at > Date.now()) return t.access_token; throw e; }
  }
  if (t.expires_at <= Date.now()) throw Object.assign(new Error('Taobao authorization expired for this seller'), { status: 401 });
  return t.access_token;
}

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

async function refreshAllDue() {
  for (const s of db.sellers.all((x) => x.taobao)) {
    try { await tokenFor(s.id); } catch { /* surfaced in dashboard */ }
  }
}

module.exports = { buildAuthorizeUrl, handleCallback, tokenFor, status, refreshAllDue };
