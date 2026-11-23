// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Administrative audit trail: who did what in Admin and Warehouse, when, from where, and whether it worked.
 * Recorded for every change (POST/PUT/PATCH/DELETE) under /api/admin and /api/warehouse, and for reads of
 * sensitive data (backups, identity documents, the people list, exports). Request bodies are never stored: only
 * their field names, plus a short reason/note when one is given — so passwords, keys and card data cannot leak here.
 * Kept AUDIT_KEEP_DAYS (400) days.
 */
const db = require('./db');

const SENSITIVE_READ = /^\/api\/admin\/(backup(\/|$)|mailbox\/(inbox|messages\/[^/]+)$|team-orders$|sellers\/[^/]+\/verification|users$|.*(export|csv)(\/|$|\?))/;
const SECRET_KEY = /pass|secret|token|key|card|iban|account_number|cvc|otp|code$/i;

function wanted(method, path, user) {
  if (path === '/api/admin/team/presence') return false;
  // restricted employees: every Admin API call, allowed or refused, so the owner sees what they tried
  if (['operator', 'ly_staff'].includes(user?.role) && /^\/api\/admin(\/|$)/.test(path)) return true;
  if (method === 'POST' && /^\/api\/auth\/(login|logout)$/.test(path)) return true;
  if (!/^\/api\/(admin|warehouse)(\/|$)/.test(path)) return false;
  return method !== 'GET' && method !== 'HEAD' ? true : SENSITIVE_READ.test(path);
}

function record({ req, path, user, status, params, error }) {
  if (!user || !wanted(req.method, path, user)) return null; // anonymous calls are refused before any work; not worth a record
  const body = req._json && typeof req._json === 'object' && !Array.isArray(req._json) ? req._json : null;
  const reason = body && ['reason', 'note', 'why', 'comment'].map((k) => body[k]).find((v) => typeof v === 'string' && v.trim());
  return db.audit.insert({
    at: Date.now(), method: req.method, path, params: params || {}, status,
    actor: user ? { id: user.id, email: user.email || null, role: user.role, owner: Boolean(user.owner) } : null,
    ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64),
    fields: body ? Object.keys(body).filter((k) => !SECRET_KEY.test(k)).slice(0, 30) : [],
    ...(req.auditMailbox ? { mailbox: req.auditMailbox } : {}),
    ...(req.auditMailId ? { message_id: req.auditMailId } : {}),
    ...(reason && !path.startsWith('/api/admin/mailbox/') ? { reason: reason.slice(0, 200) } : {}),
    ...(error ? { error: String(error).slice(0, 200) } : {})
  });
}

function list({ limit = 200, actor = '', path = '' } = {}) {
  return db.audit.all((a) => (!actor || a.actor?.id === actor || a.actor?.email === actor) && (!path || a.path.includes(path)))
    .sort((a, b) => b.at - a.at).slice(0, Math.min(1000, Math.max(1, Number(limit) || 200)));
}

function prune(now = Date.now()) {
  const keep = (Number(process.env.AUDIT_KEEP_DAYS) > 0 ? Number(process.env.AUDIT_KEEP_DAYS) : 400) * 86400e3;
  let n = 0; for (const a of db.audit.all((x) => now - x.at > keep)) { db.audit.remove(a.id); n++; }
  return n;
}

module.exports = { wanted, record, list, prune };
