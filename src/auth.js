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
const ROLES = ['admin', 'seller', 'buyer', 'warehouse'];

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
const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, seller_id: u.seller_id };

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
  return publicUser(user);
}

function createStaff({ email, password, name, role }) {
  if (!['admin', 'warehouse'].includes(role)) throw httpError(400, 'Invalid role');
  if (!validEmail(email) || !password || password.length < 8) throw httpError(400, 'Invalid data');
  email = email.trim().toLowerCase();
  if (db.users.find((u) => u.email === email)) throw httpError(409, 'Email is already registered');
  return publicUser(db.users.insert({ email, name, role, status: 'active', pass: hashPassword(password) }));
}

function login(email, password) {
  const u = db.users.find((x) => x.email === String(email || '').trim().toLowerCase());
  if (!u || !checkPassword(String(password || ''), u.pass)) throw httpError(401, 'Incorrect email or password');
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

module.exports = { register, createStaff, login, logout, authenticate, requireRole, bootstrapAdmin, httpError, publicUser, ROLES, hashPassword };
