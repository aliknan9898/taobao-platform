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
/** The platform owner: an address on the admin allowlist (ADMIN_EMAIL / ADMIN_GOOGLE_EMAILS). Has full access to every app. */
const isOwner = (u) => Boolean(u && u.email && config.adminGoogleEmails.includes(String(u.email).toLowerCase()));
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

function register({ email, password, name, role, shop_name }) {
  if (!['buyer', 'seller'].includes(role)) throw httpError(400, 'Account type not allowed');
  if (!validEmail(email)) throw httpError(400, 'Invalid email');
  if (!password || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  email = email.trim().toLowerCase();
  if (db.users.find((u) => u.email === email)) throw httpError(409, 'Email is already registered');
  const user = db.users.insert({ email, name: String(name || '').slice(0, 80), role, status: 'active', pass: hashPassword(password) });
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

function login(email, password) {
  const u = db.users.find((x) => x.email === String(email || '').trim().toLowerCase());
  if (!u || !u.pass || !checkPassword(String(password || ''), u.pass)) {
    if (u && !u.pass && u.google_sub) throw httpError(401, 'This account uses Google sign-in — tap “Continue with Google”');
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

function tokenFromRequest(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const c = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith('sid='));
  return c ? decodeURIComponent(c.slice(4)) : null;
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

module.exports = { isOwner, STAFF_ROLES, createResetToken, resetPassword, register, createStaff, login, createSession, validEmail, logout, authenticate, requireRole, bootstrapAdmin, httpError, publicUser, ROLES, hashPassword };
