// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * "Continue with Google" for Kinan Shop (customers) and the Seller Center (sellers).
 * OAuth 2.0 authorization-code flow with state + nonce. The ID token comes straight from
 * Google's token endpoint over TLS, so its claims are trusted after checking iss/aud/exp/nonce.
 * Admin: only addresses on the allowlist (ADMIN_EMAIL / ADMIN_GOOGLE_EMAILS). Warehouse staff use passwords.
 */
const crypto = require('crypto');
const db = require('./db');
const { config } = require('./config');
const { httpError, createSession, isOwner } = require('./auth');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_TTL = 10 * 60e3;
const APPS = { shop: { role: 'buyer', home: '/' }, seller: { role: 'seller', home: '/seller' }, admin: { role: 'admin', home: '/admin' } };

const enabled = () => Boolean(config.googleClientId && config.googleClientSecret);

/** Only same-site hash routes are allowed as the place to land after sign-in. */
const safeNext = (n) => (typeof n === 'string' && /^#\/[\w\-/%.?=&]*$/.test(n) && n.length < 200 ? n : '');

function authorizeUrl(app, next, lang) {
  if (!enabled()) throw httpError(503, 'Google sign-in is not set up yet');
  if (!APPS[app]) throw httpError(400, 'Unknown app');
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  db.oauthStates.insert({ id: `gg_${state}`, kind: 'google', app, nonce, next: safeNext(next), lang: ['ar', 'en'].includes(lang) ? lang : null, expires_at: Date.now() + STATE_TTL });
  const q = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: config.googleRedirectUri, response_type: 'code',
    scope: 'openid email profile', state, nonce, prompt: 'select_account'
  });
  return `${AUTH_URL}?${q}`;
}

function decodeIdToken(jwt) {
  const part = String(jwt || '').split('.')[1];
  if (!part) throw httpError(400, 'Google did not return an ID token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Admin dashboard: the Google email must be on the allowlist. Links to (or creates) that admin account. */
function adminUser(claims) {
  const email = String(claims.email || '').toLowerCase();
  if (!config.adminGoogleEmails.includes(email)) throw httpError(403, 'This Google account is not allowed to open the admin dashboard');
  const mine = db.users.all((x) => x.email === email);
  let u = mine.find((x) => x.role === 'admin') || mine.find((x) => isOwner(x) && x.role !== 'buyer') || mine.find((x) => x.role === 'buyer') || mine[0];
  // The owner often signs in to the shop first with the same Gmail: an allowlisted customer account becomes the admin account
  if (u && u.role === 'buyer') u = db.users.update(u.id, { role: 'admin' });
  // The owner keeps their existing role (e.g. seller) and still gets the admin dashboard — see requireRole
  if (u && u.role !== 'admin' && !isOwner(u)) throw httpError(409, `${email} is already a ${u.role} account — use another Gmail for the admin dashboard`);
  if (u && u.google_sub && u.google_sub !== claims.sub) throw httpError(403, 'Google account mismatch');
  if (!u) u = db.users.insert({ email, name: String(claims.name || 'Admin').slice(0, 80), role: 'admin', status: 'active', pass: null, google_sub: claims.sub });
  else if (!u.google_sub) u = db.users.update(u.id, { google_sub: claims.sub });
  return u;
}

/** Find or create the Kinan account for a verified Google identity. */
function upsertUser(claims, app, lang) {
  if (app === 'admin') return adminUser(claims);
  const email = String(claims.email || '').toLowerCase();
  const role = APPS[app].role;
  // The same Gmail can have a customer account and a seller account: use the one for this app
  const mine = db.users.all((x) => x.google_sub === claims.sub || x.email === email);
  const owner = mine.find((x) => isOwner(x));
  if (owner) return owner.google_sub ? owner : db.users.update(owner.id, { google_sub: claims.sub });
  if (mine.some((x) => !['buyer', 'seller'].includes(x.role))) throw httpError(403, 'Staff accounts must sign in with email and password');
  let u = mine.find((x) => x.role === role);
  if (u) {
    if (!u.google_sub) u = db.users.update(u.id, { google_sub: claims.sub });
    return u;
  }
  const name = String(claims.name || claims.given_name || email.split('@')[0]).slice(0, 80);
  u = db.users.insert({ email, name, role, status: 'active', pass: null, google_sub: claims.sub, avatar: claims.picture || null, lang: lang || (/^ar/i.test(String(claims.locale || '')) ? 'ar' : null) });
  if (role === 'seller') {
    const seller = db.sellers.insert({
      user_id: u.id, shop_name: `${String(claims.given_name || name).slice(0, 60)}'s Shop`,
      status: 'pending', commission_pct: config.defaultCommissionPct, auto_pay: false, taobao: null
    });
    u = db.users.update(u.id, { seller_id: seller.id });
  } else require('./notify').customerWelcome(u);
  return u;
}

/** Handle Google's redirect. Returns { token, redirect }. */
async function callback({ code, state, error }) {
  const st = state && db.oauthStates.get(`gg_${state}`);
  if (state) db.oauthStates.remove(`gg_${state}`);
  if (!st || st.kind !== 'google' || st.expires_at < Date.now()) throw httpError(400, 'Sign-in link expired. Please try again.');
  const home = APPS[st.app].home;
  if (error || !code) return { redirect: st.app === 'shop' ? '/#/signin' : home };
  try { return await finish(code, st, home); } catch (e) { e.home = home; throw e; }
}

async function finish(code, st, home) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: config.googleRedirectUri, grant_type: 'authorization_code' })
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(502, `Google sign-in failed: ${tok.error_description || tok.error || r.status}`);
  const c = decodeIdToken(tok.id_token);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) throw httpError(400, 'Invalid Google token issuer');
  if (c.aud !== config.googleClientId) throw httpError(400, 'Google token was issued for another app');
  if (!(Number(c.exp) * 1000 > Date.now())) throw httpError(400, 'Google token expired');
  if (c.nonce !== st.nonce) throw httpError(400, 'Google sign-in could not be verified');
  if (!c.email || !(c.email_verified === true || c.email_verified === 'true')) throw httpError(403, 'Your Google email address is not verified');

  const u = upsertUser(c, st.app, st.lang);
  const { token } = createSession(u);
  return { token, role: st.app === 'seller' ? 'seller' : 'buyer', redirect: `${home}${st.app === 'admin' ? '' : st.next || (st.app === 'shop' ? '#/' : '')}` };
}

module.exports = { enabled, authorizeUrl, callback, safeNext };
