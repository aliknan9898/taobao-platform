// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * "Continue with Facebook" for Kinan Shop (customers) and the Seller Center (sellers).
 * OAuth 2.0 code flow (Facebook Login): state checked, code exchanged server-side, profile read with appsecret_proof.
 *   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET   from developers.facebook.com → your app → App settings → Basic
 *   FACEBOOK_API_VERSION                   Graph API version (default v24.0)
 * Redirect URI to add in Facebook Login → Settings: <PUBLIC_BASE_URL>/auth/facebook/callback
 * Data deletion callback (App settings → Basic): <PUBLIC_BASE_URL>/auth/facebook/delete
 * The owner and staff never sign in with Facebook (they use Google / password), so a Facebook account with the same
 * email cannot take those over.
 */
const crypto = require('crypto');
const db = require('./db');
const { config } = require('./config');
const { httpError, createSession, isOwner, ownerEmail } = require('./auth');

const STATE_TTL = 10 * 60e3;
const APPS = { shop: { role: 'buyer', home: '/' }, seller: { role: 'seller', home: '/seller' } };
const appId = () => String(process.env.FACEBOOK_APP_ID || '').trim();
const secret = () => String(process.env.FACEBOOK_APP_SECRET || '').trim();
const ver = () => (/^v\d+\.\d+$/.test(process.env.FACEBOOK_API_VERSION || '') ? process.env.FACEBOOK_API_VERSION : 'v24.0');
const redirectUri = () => `${String(config.publicBaseUrl || '').replace(/\/$/, '')}/auth/facebook/callback`;
const enabled = () => Boolean(appId() && secret());
const safeNext = (n) => (typeof n === 'string' && /^#\/[\w\-/%.?=&]*$/.test(n) && n.length < 200 ? n : '');

function authorizeUrl(app, next, lang) {
  if (!enabled()) throw httpError(503, 'Facebook sign-in is not set up yet');
  if (!APPS[app]) throw httpError(400, 'Unknown app');
  const state = crypto.randomBytes(24).toString('base64url');
  db.oauthStates.insert({ id: `fb_${state}`, kind: 'facebook', app, next: safeNext(next), lang: ['ar', 'en'].includes(lang) ? lang : null, expires_at: Date.now() + STATE_TTL });
  const q = new URLSearchParams({ client_id: appId(), redirect_uri: redirectUri(), state, response_type: 'code', scope: 'public_profile,email', auth_type: 'rerequest' });
  return `https://www.facebook.com/${ver()}/dialog/oauth?${q}`;
}

async function graph(path, params) {
  const r = await fetch(`https://graph.facebook.com/${ver()}/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw httpError(502, `Facebook sign-in failed: ${j.error?.message || r.status}`);
  return j;
}

/** Find or create the Kinan account for a Facebook identity (by its Facebook id, then by its email). */
function upsertUser(p, app, lang) {
  const role = APPS[app].role;
  const email = String(p.email || '').toLowerCase().trim();
  const linked = db.users.all((x) => x.facebook_id === p.id);
  let u = linked.find((x) => x.role === role);
  if (!u) {
    if (!email) throw httpError(400, 'Your Facebook account does not share an email address. Sign in with your phone number or email instead.');
    const mine = db.users.all((x) => x.email === email);
    // the owner and staff use Google or a password: never opened through Facebook
    if (mine.some((x) => isOwner(x) || !['buyer', 'seller'].includes(x.role)) || ownerEmail(email)) throw httpError(403, 'This account signs in with Google or a password');
    u = mine.find((x) => x.role === role);
    if (u) {
      if (u.facebook_id && u.facebook_id !== p.id) throw httpError(403, 'This Kinan account is linked to another Facebook account');
      u = db.users.update(u.id, { facebook_id: p.id });
    }
  }
  if (u) {
    if (u.status && u.status !== 'active') throw httpError(403, 'This account is not active');
    return u;
  }
  const name = String(p.name || email.split('@')[0]).slice(0, 80);
  u = db.users.insert({ email, name, role, status: 'active', pass: null, facebook_id: p.id, avatar: p.picture?.data?.url || null, lang: lang || null });
  if (role === 'seller') {
    const seller = db.sellers.insert({ user_id: u.id, shop_name: `${name.split(' ')[0].slice(0, 60)}'s Shop`, status: 'pending', commission_pct: config.defaultCommissionPct, auto_pay: false, taobao: null });
    u = db.users.update(u.id, { seller_id: seller.id });
  } else require('./notify').customerWelcome(u);
  return u;
}

/** Facebook's redirect: returns { token, role, redirect }. */
async function callback({ code, state, error }) {
  const st = state && db.oauthStates.get(`fb_${state}`);
  if (state) db.oauthStates.remove(`fb_${state}`);
  if (!st || st.kind !== 'facebook' || st.expires_at < Date.now()) throw httpError(400, 'Sign-in link expired. Please try again.');
  const home = APPS[st.app].home;
  if (error || !code) return { redirect: st.app === 'shop' ? '/#/signin' : home };
  try {
    const tok = await graph('oauth/access_token', { client_id: appId(), client_secret: secret(), redirect_uri: redirectUri(), code });
    const proof = crypto.createHmac('sha256', secret()).update(tok.access_token).digest('hex');
    const p = await graph('me', { fields: 'id,name,email,picture.type(large)', access_token: tok.access_token, appsecret_proof: proof });
    if (!p.id) throw httpError(502, 'Facebook did not return your account');
    const u = upsertUser(p, st.app, st.lang);
    const { token } = createSession(u);
    return { token, role: APPS[st.app].role, redirect: `${home}${st.next || (st.app === 'shop' ? '#/' : '')}` };
  } catch (e) { e.home = home; throw e; }
}

/** Data deletion request from Facebook (signed_request): unlink Facebook from the account and say where to check. */
function deletionRequest(signed) {
  const [sig, payload] = String(signed || '').split('.');
  if (!sig || !payload || !enabled()) throw httpError(400, 'Bad request');
  const want = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) throw httpError(400, 'Bad signature');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const code = crypto.randomBytes(8).toString('hex');
  for (const u of db.users.all((x) => x.facebook_id && x.facebook_id === String(data.user_id))) db.users.update(u.id, { facebook_id: null, avatar: null });
  return { url: `${String(config.publicBaseUrl || '').replace(/\/$/, '')}/privacy#data-deletion`, confirmation_code: code };
}

module.exports = { enabled, authorizeUrl, callback, deletionRequest, _upsertUser: upsertUser };
