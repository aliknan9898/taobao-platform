// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Encrypted, portable backups of the whole database to a PRIVATE Cloudflare R2 bucket (default "kinan-backups").
 *
 * Format (portable, no Kinan code needed to read it): a JSON document { app, version, at, collections } — the same as
 * the admin download — gzipped, then encrypted with AES-256-GCM:
 *     "KNB1" (4 bytes) | iv (12) | auth tag (16) | ciphertext
 * The key is BACKUP_ENCRYPTION_KEY (32 random bytes, base64). Without the key a backup cannot be read, so the owner keeps
 * an offline copy of it (see docs/BACKUP_RESTORE.md). Identity-document photos are included: the copy is encrypted.
 *
 * Off until configured: BACKUP_ENCRYPTION_KEY + R2_ACCOUNT_ID + the R2 keys (BACKUP_R2_ACCESS_KEY_ID /
 * BACKUP_R2_SECRET_ACCESS_KEY, or the shared R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) + BACKUP_R2_BUCKET (default kinan-backups).
 * Retention: every daily backup for BACKUP_KEEP_DAYS (30), then the first backup of each month for BACKUP_KEEP_MONTHS (12).
 * Product photos are not in the backup: they live in their own R2 bucket (R2_BUCKET); the backup keeps the link map (media).
 */
const crypto = require('crypto');
const zlib = require('zlib');
const db = require('../db');

const MAGIC = Buffer.from('KNB1');
const PREFIX = 'db/';

function cfg(env = process.env) {
  const t = (k) => String(env[k] || '').trim();
  return {
    account: t('R2_ACCOUNT_ID'), keyId: t('BACKUP_R2_ACCESS_KEY_ID') || t('R2_ACCESS_KEY_ID'), secret: t('BACKUP_R2_SECRET_ACCESS_KEY') || t('R2_SECRET_ACCESS_KEY'),
    bucket: t('BACKUP_R2_BUCKET') || 'kinan-backups', key: t('BACKUP_ENCRYPTION_KEY'),
    keepDays: Number(env.BACKUP_KEEP_DAYS) > 0 ? Number(env.BACKUP_KEEP_DAYS) : 30, keepMonths: Number(env.BACKUP_KEEP_MONTHS) > 0 ? Number(env.BACKUP_KEEP_MONTHS) : 12
  };
}
function keyBytes(b64) {
  const k = Buffer.from(String(b64 || ''), 'base64');
  if (k.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 random bytes in base64 (e.g. `openssl rand -base64 32`)');
  return k;
}
const enabled = (env = process.env) => { const c = cfg(env); try { keyBytes(c.key); } catch { return false; } return Boolean(c.account && c.keyId && c.secret && c.bucket); };

// ---------- format ----------
function snapshot() {
  return { app: 'kinan', version: 1, at: new Date().toISOString(), collections: db.exportAll() };
}
function encrypt(obj, b64key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(b64key), iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 })), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
function decrypt(buf, b64key) {
  if (!Buffer.isBuffer(buf) || buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not a Kinan backup file');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(b64key), buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  const gz = Buffer.concat([d.update(buf.subarray(32)), d.final()]); // throws if the key is wrong or the file was changed
  return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
}

// ---------- R2 (S3 API) ----------
async function s3(method, path, { query = '', body = Buffer.alloc(0), headers = {} } = {}, env = process.env) {
  const c = cfg(env); const { signV4 } = require('./media');
  const host = `${c.account}.r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const h = { ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const authorization = signV4({ method, host, path, query, headers: h, payloadHash, region: 'auto', service: 's3', keyId: c.keyId, secret: c.secret, amzDate });
  const r = await fetch(`https://${host}${path}${query ? `?${query}` : ''}`, { method, headers: { ...h, Authorization: authorization }, body: ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : body, signal: AbortSignal.timeout(60000) });
  if (!r.ok && !(method === 'DELETE' && r.status === 404)) throw new Error(`R2 ${method} HTTP ${r.status}`);
  return r;
}
const objPath = (bucket, key) => `/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
async function list(env = process.env) {
  const c = cfg(env); const keys = []; let token = '';
  do {
    const q = [`list-type=2`, `prefix=${encodeURIComponent(PREFIX)}`, ...(token ? [`continuation-token=${encodeURIComponent(token)}`] : [])].sort().join('&');
    const xml = await (await s3('GET', `/${encodeURIComponent(c.bucket)}`, { query: q }, env)).text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    token = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || '';
  } while (token);
  return keys.sort();
}

/** Which backups to delete: keep every one of the last `keepDays` days and the first of each of the last `keepMonths` months. */
function expired(keys, now = Date.now(), { keepDays = 30, keepMonths = 12 } = {}) {
  const dated = keys.map((k) => ({ k, d: (k.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] })).filter((x) => x.d).sort((a, b) => a.k.localeCompare(b.k));
  const firstOfMonth = new Set(); const seen = new Set();
  for (const x of dated) { const m = x.d.slice(0, 7); if (!seen.has(m)) { seen.add(m); firstOfMonth.add(x.k); } }
  const dayMs = 86400e3; const today = new Date(now).toISOString().slice(0, 10);
  const age = (d) => Math.round((Date.parse(today) - Date.parse(d)) / dayMs);
  const monthsAgo = (d) => { const a = new Date(now); const b = new Date(d); return (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + a.getUTCMonth() - b.getUTCMonth(); };
  return dated.filter((x) => !(age(x.d) < keepDays) && !(firstOfMonth.has(x.k) && monthsAgo(x.d) < keepMonths)).map((x) => x.k);
}

/** Make one encrypted backup now and upload it. Returns a manifest saved in settings (backup_last). */
async function run({ reason = 'daily', env = process.env } = {}) {
  if (!enabled(env)) return { skipped: 'off — set BACKUP_ENCRYPTION_KEY, R2_ACCOUNT_ID and the R2 keys' };
  const c = cfg(env); const t0 = Date.now();
  await db.flush(); // what is in memory is what is in the database
  const snap = snapshot();
  const body = encrypt(snap, c.key);
  const stamp = snap.at.replace(/[:.]/g, '-');
  const key = `${PREFIX}${snap.at.slice(0, 10)}/kinan-${stamp}-${reason.replace(/[^a-z0-9-]/gi, '')}.knb`;
  await s3('PUT', objPath(c.bucket, key), { body, headers: { 'content-type': 'application/octet-stream' } }, env);
  const manifest = { id: 'backup_last', key, at: snap.at, reason, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'),
    counts: Object.fromEntries(Object.entries(snap.collections).map(([k, v]) => [k, v.length])), ms: Date.now() - t0 };
  if (db.settings.get('backup_last')) db.settings.update('backup_last', manifest); else db.settings.insert(manifest);
  let removed = 0;
  try { for (const k of expired(await list(env), Date.now(), c)) { await s3('DELETE', objPath(c.bucket, k), {}, env); removed++; } } catch (e) { console.warn('[backup] retention:', e.message); }
  console.log(`[backup] ${reason}: ${key} · ${(body.length / 1024).toFixed(0)} KB · ${manifest.ms} ms · ${removed} old removed`);
  return { ...manifest, removed };
}

/** For monitoring: age of the last off-site backup. */
function status(now = Date.now()) {
  const m = db.settings.get('backup_last');
  return { enabled: enabled(), bucket: cfg().bucket, last: m ? { at: m.at, key: m.key, bytes: m.bytes, counts: m.counts } : null, age_hours: m ? Math.round((now - Date.parse(m.at)) / 36e5 * 10) / 10 : null };
}

/** Hourly: the daily backup at 02:00 UTC; a Telegram alert when the newest one is over 26 hours old. */
async function tick(now = Date.now()) {
  if (!enabled()) return null;
  const h = new Date(now).getUTCHours(); const st = status(now);
  if (h === 2 && (!st.last || st.age_hours > 20)) {
    try { return await run({ reason: 'daily' }); } catch (e) { console.error('[backup]', e.message); await require('../push').telegram(`⚠️ Kinan backup failed: ${e.message}`).catch(() => {}); return null; }
  }
  const alertKey = `backup_alert:${new Date(now).toISOString().slice(0, 10)}`;
  if (st.last && st.age_hours > 26 && !db.settings.get(alertKey)) {
    db.settings.insert({ id: alertKey, at: now });
    await require('../push').telegram(`⚠️ The last Kinan backup is ${st.age_hours} hours old (${st.last.key}). Check Admin → Backups.`).catch(() => {});
  }
  return null;
}

/**
 * Restore a backup into a store (staging only). `target` is a db module initialised on an EMPTY database.
 * Returns how many documents were written per collection.
 */
async function restoreInto(target, snap) {
  if (!snap || snap.app !== 'kinan' || !snap.collections) throw new Error('Not a Kinan backup');
  const nonEmpty = Object.keys(snap.collections).filter((k) => target[k === 'oauth_states' ? 'oauthStates' : k]?.all().length);
  if (nonEmpty.length) throw new Error(`The target is not empty (${nonEmpty.slice(0, 5).join(', ')}): restore only into a new, empty staging database`);
  const counts = {};
  for (const [name, docs] of Object.entries(snap.collections)) {
    const coll = target[name === 'oauth_states' ? 'oauthStates' : name]; if (!coll) continue;
    for (const d of docs) coll.insert(d);
    counts[name] = docs.length;
  }
  await target.flush();
  return counts;
}

module.exports = { cfg, enabled, encrypt, decrypt, snapshot, expired, run, status, tick, restoreInto, list, MAGIC };
