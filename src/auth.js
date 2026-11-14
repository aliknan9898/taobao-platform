// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Accounts & sessions. Roles: admin | seller | buyer | warehouse.
 * Web sites use an HttpOnly cookie; native apps send `Authorization: Bearer <token>`.
 */
const crypto = require('crypto');
const db = require('./db');
const { config } = require('./config');

const SESSION_TTL = 30 * 86400e3;
const ROLES = ['admin', 'seller', 'buyer', 'warehouse', 'procurement', 'finance', 'support'];
/** Staff roles the admin can create, and what each one is for. */
const STAFF_ROLES = {
  admin: 'Everything', procurement: 'Buys orders on Taobao / AliExpress, answers item requests',
  warehouse: 'Receives, checks and ships parcels in China', finance: 'Withdrawals, refunds, wallets and reports',
  support: 'Customer questions: orders, returns, item requests, password links'
};

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, s, k] = String(stored).split('$');
  if (!s || !k) return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(k, 'hex'));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
/** An address on the admin allowlist (ADMIN_EMAIL / ADMIN_GOOGLE_EMAILS). */
const ownerEmail = (e) => Boolean(e && config.adminGoogleEmails.includes(String(e).trim().toLowerCase()));
/**
 * The platform owner: an allowlisted address that is PROVEN — the admin account, or an account Google has confirmed
 * (signed in with Google at least once). An allowlisted email typed into a sign-up form proves nothing, so it gives no rights.
 * Has full access to every app.
 */
const isOwner = (u) => Boolean(u && u.email && ownerEmail(u.email) && (u.role === 'admin' || u.google_sub));
const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, seller_id: u.seller_id, owner: isOwner(u) || undefined };

/** The owner's seller shop (created on first use, already approved). */
function ownerSeller(user) {
  let s = user.seller_id && db.sellers.get(user.seller_id);
  if (!s) {
    s = db.sellers.insert({ user_id: user.id, shop_name: String(user.name || 'Kinan').slice(0, 60), status: 'active', commission_pct: config.defaultCommissionPct, auto_pay: false, taobao: null });
    db.users.update(user.id, { seller_id: s.id });
  }
  return s;
}

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }

/**
 * One email can have a customer account (Kinan Shop) AND a seller account (Seller Center) — two separate
 * accounts, each with its own password and session. Staff emails stay unique.
 */
const APP_ROLE = { shop: 'buyer', seller: 'seller' };
const isStaff = (u) => u && (u.role === 'admin' || Boolean(STAFF_ROLES[u.role]));
const usersByEmail = (email) => db.users.all((u) => u.email === String(email || '').trim().toLowerCase());

function register({ email, password, name, role, shop_name, lang }) {
  if (!['buyer', 'seller'].includes(role)) throw httpError(400, 'Account type not allowed');
  if (!validEmail(email)) throw httpError(400, 'Invalid email');
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  email = email.trim().toLowerCase();
  // The owner's addresses sign in with Google only: nobody can claim them with a password
  if (ownerEmail(email)) throw httpError(409, 'This email signs in with Google — tap “Continue with Google”');
  const same = usersByEmail(email);
  if (same.some((u) => u.role === role || isStaff(u))) throw httpError(409, role === 'seller' ? 'This email already has a seller account — sign in instead' : 'This email already has a Kinan Shop account — sign in instead');
  const user = db.users.insert({ email, name: String(name || '').slice(0, 80), role, status: 'active', pass: hashPassword(password), lang: ['ar', 'en'].includes(lang) ? lang : null });
  if (role === 'seller') {
    // Sellers start as "pending" until an admin approves them
    const seller = db.sellers.insert({
      user_id: user.id, shop_name: String(shop_name || name || email).slice(0, 80),
      status: 'pending', commission_pct: config.defaultCommissionPct, auto_pay: false, taobao: null
    });
    return publicUser(db.users.update(user.id, { seller_id: seller.id }));
  }
  require('./notify').customerWelcome(user); // welcome email for new Kinan Shop customers
  return publicUser(user);
}

function createStaff({ email, password, name, role }) {
  if (!STAFF_ROLES[role]) throw httpError(400, 'Invalid role');
  if (!validEmail(email) || !password || password.length < 8) throw httpError(400, 'Invalid data');
  email = email.trim().toLowerCase();
  if (db.users.find((u) => u.email === email)) throw httpError(409, 'Email is already registered');
  return publicUser(db.users.insert({ email, name, role, status: 'active', pass: hashPassword(password) }));
}

/** Sign in. `app` (shop / seller) picks the right account when the email has both. */
function login(email, password, app) {
  const all = usersByEmail(email);
  const role = APP_ROLE[app];
  // The app's own account first; staff and the owner can sign in anywhere
  const list = role ? all.filter((u) => u.role === role || isStaff(u) || isOwner(u)) : all;
  // The owner's addresses (except the admin account set up with ADMIN_PASSWORD) sign in with Google only
  const u = list.find((x) => x.pass && !(ownerEmail(x.email) && x.role !== 'admin') && checkPassword(String(password || ''), x.pass));
  if (!u) {
    if (list.some((x) => ownerEmail(x.email) && x.role !== 'admin')) throw httpError(401, 'This account uses Google sign-in — tap “Continue with Google”');
    if (list.some((x) => !x.pass && x.google_sub)) throw httpError(401, 'This account uses Google sign-in — tap “Continue with Google”');
    if (list.some((x) => !x.pass && x.facebook_id)) throw httpError(401, 'This account uses Facebook sign-in — tap “Continue with Facebook”');
    if (role && !list.length && all.length) throw httpError(401, role === 'seller' ? 'This email has no seller account yet — tap “Open a shop”' : 'This email has no Kinan Shop account yet — tap “Create account”');
    throw httpError(401, 'Incorrect email or password');
  }
  return createSession(u);
}

/** Start a session for a user who has already been verified (password or Google). */
function createSession(u) {
  if (u.status !== 'active') throw httpError(403, 'Account is suspended');
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions.insert({ token_hash: sha(token), user_id: u.id, expires_at: Date.now() + SESSION_TTL });
  return { token, user: publicUser(u) };
}

function logout(token) {
  const s = db.sessions.find((x) => x.token_hash === sha(token));
  if (s) db.sessions.remove(s.id);
}

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** Each app keeps its own sign-in cookie, so the same email can be signed in to Kinan Shop and the Seller Center at once. */
const cookieName = (role) => (role === 'seller' ? 'ssid' : 'sid');
/** Requests from the Seller Center (its pages, its API, or calls marked X-Kinan-App: seller). */
const sellerContext = (req) => req.headers['x-kinan-app'] === 'seller' || /^\/(api\/seller|seller)(\/|$|\?|\.)/.test(req.url || '');
function readCookie(req, name) {
  const c = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.slice(name.length + 1)) : null;
}
function tokenFromRequest(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (sellerContext(req)) {
    const t = readCookie(req, 'ssid');
    if (t) return t;
    // Sellers signed in before separate cookies existed keep their session
    const old = readCookie(req, 'sid'); const s = old && db.sessions.find((x) => x.token_hash === sha(old));
    const u = s && db.users.get(s.user_id);
    return u && (u.role === 'seller' || isOwner(u)) ? old : null;
  }
  return readCookie(req, 'sid');
}

function authenticate(req) {
  const t = tokenFromRequest(req);
  if (!t) return null;
  const s = db.sessions.find((x) => x.token_hash === sha(t));
  if (!s || s.expires_at < Date.now()) return null;
  const u = db.users.get(s.user_id);
  if (!u || u.status !== 'active') return null;
  return publicUser(u);
}

function requireRole(user, ...roles) {
  if (!user) throw httpError(401, 'Please sign in first');
  if (user.owner && !roles.includes(user.role)) {
    // Owner: act as whichever role this route needs (admin first, so admin-only checks pass)
    const role = roles.includes('admin') ? 'admin' : roles[0];
    const acting = { ...user, role };
    if (role === 'seller') { const s = ownerSeller(user); acting.seller_id = s.id; return { user: acting, seller: s }; }
    return { user: acting };
  }
  if (!roles.includes(user.role)) throw httpError(403, 'Not allowed for this account');
  if (user.role === 'seller') {
    const s = db.sellers.get(user.seller_id);
    if (!s) throw httpError(403, 'Seller account not found');
    return { user, seller: s };
  }
  return { user };
}

function bootstrapAdmin() {
  if (db.users.find((u) => u.role === 'admin')) return;
  if (config.bootstrapAdminEmail && config.bootstrapAdminPassword) {
    createStaff({ email: config.bootstrapAdminEmail, password: config.bootstrapAdminPassword, name: 'Admin', role: 'admin' });
    console.log(`[auth] admin created: ${config.bootstrapAdminEmail}`);
  } else {
    console.warn('[auth] no admin yet — set ADMIN_EMAIL and ADMIN_PASSWORD');
  }
}

// ---------- password reset ----------
const RESET_TTL = 3600e3;
/** One-hour, single-use reset token. Only its hash is stored. */
/**
 * Google has just confirmed this address for an account that was not linked to Google yet. For the owner's addresses,
 * a password or sessions on it may have been set up by someone else (sign-ups were not checked before): drop them.
 */
function secureOwnerLink(u) {
  if (!u || !ownerEmail(u.email) || u.role === 'admin') return u;
  for (const x of db.sessions.all((t) => t.user_id === u.id)) db.sessions.remove(x.id);
  return u.pass ? db.users.update(u.id, { pass: null }) : u;
}

/**
 * Once, after the update that made Google the owner's only way in: owner-address accounts that Google never confirmed
 * lose their password and sessions (they may not be the owner's). The owner signs in again with Google.
 */
function secureOwnerAccounts() {
  if (db.settings.get('set_owner_secured_v1')) return 0;
  let n = 0;
  for (const u of db.users.all((x) => ownerEmail(x.email) && x.role !== 'admin')) {
    const sessions = db.sessions.all((t) => t.user_id === u.id);
    for (const x of sessions) db.sessions.remove(x.id);
    if (u.pass) db.users.update(u.id, { pass: null });
    if (sessions.length || u.pass) n++;
  }
  db.settings.insert({ id: 'set_owner_secured_v1', at: Date.now(), accounts: n });
  if (n) console.log(`[auth] owner email accounts secured: ${n} (sign in with Google)`);
  return n;
}

function createResetToken(user) {
  for (const t of db.tokens.all((x) => x.kind === 'reset' && x.user_id === user.id)) db.tokens.remove(t.id);
  const token = crypto.randomBytes(32).toString('base64url');
  db.tokens.insert({ kind: 'reset', token_hash: sha(token), user_id: user.id, expires_at: Date.now() + RESET_TTL });
  return token;
}
function resetPassword(token, password) {
  if (!password || String(password).length < 8) throw httpError(400, 'Password must be at least 8 characters');
  const t = token && db.tokens.find((x) => x.kind === 'reset' && x.token_hash === sha(token));
  if (!t || t.expires_at < Date.now()) throw httpError(400, 'This reset link has expired or was already used. Ask for a new one.');
  db.tokens.remove(t.id);
  const u = db.users.get(t.user_id);
  if (!u || u.status !== 'active') throw httpError(403, 'Account is not active');
  db.users.update(u.id, { pass: hashPassword(String(password)) });
  for (const s of db.sessions.all((x) => x.user_id === u.id)) db.sessions.remove(s.id); // sign out everywhere
  return createSession(db.users.get(u.id));
}

module.exports = { isOwner, ownerEmail, secureOwnerLink, secureOwnerAccounts, isStaff, usersByEmail, APP_ROLE, cookieName, sellerContext, tokenFromRequest, STAFF_ROLES, createResetToken, resetPassword, register, createStaff, login, createSession, validEmail, logout, authenticate, requireRole, bootstrapAdmin, httpError, publicUser, ROLES, hashPassword };
