// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Sign-in from the Kinan Shop iPhone / Android apps with Google and with Apple.
 * The app signs in with the provider's own SDK and sends Kinan the ID token; Kinan checks the token's signature against
 * the provider's published keys (JWKS), its issuer, audience (our app ids), expiry and, for Apple, the nonce — then
 * signs the customer in with a normal Kinan session (Bearer token). Customers only (the Seller Center stays on the web).
 *
 * Off until configured:
 *   Google: GOOGLE_IOS_CLIENT_ID and/or GOOGLE_ANDROID_CLIENT_ID (GOOGLE_CLIENT_ID, the web client, is accepted too)
 *   Apple:  APPLE_BUNDLE_ID (the iOS app's bundle id). For token revocation on account deletion (Apple asks apps to do
 *           this) also APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (the .p8 key, PEM text).
 */
const crypto = require('crypto');
const db = require('./db');
const { config } = require('./config');
const { httpError, createSession, ownerEmail, isStaff } = require('./auth');

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_JWKS = 'https://appleid.apple.com/auth/keys';
const APPLE_ISS = 'https://appleid.apple.com';
const LANGS = ['en', 'ar', 'fr', 'de', 'it', 'es'];

const googleAudiences = () => [process.env.GOOGLE_IOS_CLIENT_ID, process.env.GOOGLE_ANDROID_CLIENT_ID, config.googleClientId].map((x) => String(x || '').trim()).filter(Boolean);
const googleEnabled = () => Boolean(process.env.GOOGLE_IOS_CLIENT_ID || process.env.GOOGLE_ANDROID_CLIENT_ID);
const appleAudiences = () => [process.env.APPLE_BUNDLE_ID, process.env.APPLE_SERVICE_ID].map((x) => String(x || '').trim()).filter(Boolean);
const appleEnabled = () => Boolean(process.env.APPLE_BUNDLE_ID);
const appleRevokeReady = () => Boolean(appleEnabled() && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);

// ---------- JWT checks ----------
const jwksCache = new Map(); // url → { at, keys }
async function jwks(url, force = false) {
  const hit = jwksCache.get(url);
  if (hit && !force && Date.now() - hit.at < 3600e3) return hit.keys;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw httpError(502, 'The sign-in service did not answer');
  const j = await r.json();
  const keys = Array.isArray(j.keys) ? j.keys : [];
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

/** Verify an RS256 JWT against a JWKS; returns its claims or throws 401. */
async function verifyJwt(token, { jwksUrl, issuers, audiences }, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw httpError(400, 'Invalid sign-in token');
  let head; let claims;
  try { head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw httpError(400, 'Invalid sign-in token'); }
  if (head.alg !== 'RS256' || !head.kid) throw httpError(401, 'Sign-in token not accepted');
  let key = (await jwks(jwksUrl)).find((k) => k.kid === head.kid);
  if (!key) key = (await jwks(jwksUrl, true)).find((k) => k.kid === head.kid); // keys rotate: refresh once
  if (!key) throw httpError(401, 'Sign-in token not accepted');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw httpError(401, 'Sign-in token not accepted');
  if (!issuers.includes(claims.iss)) throw httpError(401, 'Sign-in token from an unknown issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => audiences.includes(a))) throw httpError(401, 'Sign-in token was issued for another app');
  if (!(Number(claims.exp) * 1000 > now - 60e3)) throw httpError(401, 'Sign-in token expired — please try again');
  if (claims.iat && Number(claims.iat) * 1000 > now + 5 * 60e3) throw httpError(401, 'Sign-in token not accepted');
  return claims;
}
const verified = (v) => v === true || v === 'true';

// ---------- Google ----------
async function google({ id_token, lang } = {}) {
  if (!googleEnabled()) throw httpError(503, 'Google sign-in for the app is not set up yet');
  const c = await verifyJwt(id_token, { jwksUrl: GOOGLE_JWKS, issuers: ['accounts.google.com', 'https://accounts.google.com'], audiences: googleAudiences() });
  if (!c.email || !verified(c.email_verified)) throw httpError(403, 'Your Google email address is not verified');
  // Same rules as the website's Google sign-in (owner protection, linking an existing customer account by email)
  const u = require('./googleAuth')._upsertUser(c, 'shop', LANGS.includes(lang) ? lang : null);
  return session(u);
}

// ---------- Apple ----------
async function apple({ identity_token, nonce, name, authorization_code, lang } = {}) {
  if (!appleEnabled()) throw httpError(503, 'Sign in with Apple is not set up yet');
  if (!nonce) throw httpError(400, 'Missing nonce');
  const c = await verifyJwt(identity_token, { jwksUrl: APPLE_JWKS, issuers: [APPLE_ISS], audiences: appleAudiences() });
  // The app hands Apple the SHA-256 of its nonce; Apple puts that hash in the token
  const want = crypto.createHash('sha256').update(String(nonce)).digest('hex');
  if (c.nonce !== want && c.nonce !== String(nonce)) throw httpError(401, 'Sign in with Apple could not be verified');
  const email = c.email && verified(c.email_verified ?? true) ? String(c.email).toLowerCase() : null;
  let u = db.users.find((x) => x.apple_sub === c.sub);
  if (u && u.role !== 'buyer') throw httpError(403, 'This Apple ID is linked to a staff account');
  if (!u && email) {
    if (ownerEmail(email)) throw httpError(409, 'This email signs in with Google — tap “Continue with Google”');
    const same = db.users.all((x) => x.email === email);
    if (same.some((x) => isStaff(x))) throw httpError(403, 'Staff accounts must sign in with email and password');
    u = same.find((x) => x.role === 'buyer');
    if (u) u = db.users.update(u.id, { apple_sub: c.sub });
  }
  if (!u) {
    // Apple sends the name only the first time, to the app (not in the token)
    const nm = String(name || '').trim().slice(0, 80) || (email && !/privaterelay\.appleid\.com$/i.test(email) ? email.split('@')[0] : 'Kinan customer');
    u = db.users.insert({ email, name: nm, role: 'buyer', status: 'active', pass: null, apple_sub: c.sub, apple_relay: Boolean(email && /privaterelay\.appleid\.com$/i.test(email)), lang: LANGS.includes(lang) ? lang : null });
    try { if (email) require('./notify').customerWelcome(u); } catch { /* optional */ }
  }
  // Keep Apple's refresh token so the authorisation can be revoked when the customer deletes the account
  if (authorization_code && appleRevokeReady()) {
    try { const rt = await appleRefreshToken(String(authorization_code)); if (rt) u = db.users.update(u.id, { apple_refresh_token: rt }); } catch (e) { console.warn('[apple] code exchange:', e.message); }
  }
  return session(u);
}

function session(u) {
  const { token, user } = createSession(db.users.get(u.id));
  return { token, user };
}

/** Apple's client secret: an ES256 JWT signed with the team's Sign in with Apple key, valid 5 minutes. */
function appleClientSecret(now = Date.now()) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'ES256', kid: process.env.APPLE_KEY_ID });
  const body = b64({ iss: process.env.APPLE_TEAM_ID, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 300, aud: APPLE_ISS, sub: process.env.APPLE_BUNDLE_ID });
  const key = crypto.createPrivateKey(String(process.env.APPLE_PRIVATE_KEY).replace(/\\n/g, '\n'));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}
async function appleRefreshToken(code) {
  const r = await fetch(`${APPLE_ISS}/auth/token`, {
    method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: process.env.APPLE_BUNDLE_ID, client_secret: appleClientSecret() })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.refresh_token || null;
}
/** Account deletion: revoke the app's Apple authorisation (best effort). */
async function appleRevoke(user) {
  const u = db.users.get(user.id) || user;
  if (!u.apple_refresh_token || !appleRevokeReady()) return false;
  const r = await fetch(`${APPLE_ISS}/auth/revoke`, {
    method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.APPLE_BUNDLE_ID, client_secret: appleClientSecret(), token: u.apple_refresh_token, token_type_hint: 'refresh_token' })
  });
  return r.ok;
}

module.exports = { google, apple, appleRevoke, googleEnabled, appleEnabled, verifyJwt, _jwksCache: jwksCache };
