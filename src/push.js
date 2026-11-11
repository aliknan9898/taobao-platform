// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Phone notifications.
 * - Web Push (RFC 8030/8291/8292) to installed Kinan apps on Android and iPhone (iOS 16.4+, app added to the
 *   home screen). VAPID keys are created once and kept in the database (or set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY).
 * - Telegram messages to the owner (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) for things that need attention.
 * Everything here is best effort: a failed notification never breaks an order.
 */
const crypto = require('crypto');
const db = require('./db');
const { config } = require('./config');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// ---------------- VAPID keys ----------------
let keys = null;
function vapid() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  else {
    const s = db.settings.get('set_vapid');
    if (s) keys = { publicKey: s.publicKey, privateKey: s.privateKey };
    else {
      const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
      keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
      db.settings.insert({ id: 'set_vapid', ...keys });
    }
  }
  return keys;
}

function signingKey() {
  const { publicKey, privateKey } = vapid();
  const pub = unb64u(publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const sub = config.operator.email ? `mailto:${config.operator.email}` : config.publicBaseUrl;
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: signingKey(), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid().publicKey}`;
}

// ---------------- Payload encryption (aes128gcm, RFC 8291) ----------------
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh); const authSecret = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

async function sendOne(sub, msg) {
  const body = encrypt(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Authorization: vapidHeader(sub.endpoint) },
    body
  });
  if (r.status === 404 || r.status === 410) { db.push_subs.remove(sub.id); return 'gone'; }
  if (!r.ok) throw new Error(`push ${r.status}`);
  return 'sent';
}

// ---------------- Subscriptions ----------------
const PUSH_HOSTS = /(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|windows\.com|notify\.windows\.com|push\.apple\.com)$/;

function subscribe(user, b) {
  const endpoint = String(b?.endpoint || '');
  let host; try { host = new URL(endpoint).hostname; } catch { host = ''; }
  if (!/^https:\/\//.test(endpoint) || !PUSH_HOSTS.test(host)) throw Object.assign(new Error('Unsupported push service'), { status: 400 });
  const p256dh = String(b?.keys?.p256dh || ''); const auth = String(b?.keys?.auth || '');
  if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) throw Object.assign(new Error('Invalid subscription'), { status: 400 });
  for (const s of db.push_subs.all((x) => x.endpoint === endpoint)) db.push_subs.remove(s.id);
  db.push_subs.insert({ user_id: user.id, endpoint, keys: { p256dh, auth }, app: String(b.app || 'shop').slice(0, 10) });
  if (db.push_subs.all((x) => x.user_id === user.id).length > 10) { const old = db.push_subs.all((x) => x.user_id === user.id).sort((a, c) => a.created_at - c.created_at)[0]; db.push_subs.remove(old.id); }
  return { ok: true };
}
function unsubscribe(user, endpoint) { for (const s of db.push_subs.all((x) => x.user_id === user.id && x.endpoint === endpoint)) db.push_subs.remove(s.id); return { ok: true }; }

/** Notify every device of a user. `url` is where tapping the notification opens. */
function toUser(userId, { title, body, url, tag, ar }) {
  if (!userId) return;
  if (ar && db.users.get(userId)?.lang === 'ar') ({ title, body } = { title: ar.title || title, body: ar.body ?? body });
  for (const s of db.push_subs.all((x) => x.user_id === userId)) {
    sendOne(s, { title: String(title).slice(0, 80), body: String(body || '').slice(0, 200), url: url || '/', tag: tag || undefined })
      .catch((e) => console.warn('[push]', e.message));
  }
}

// ---------------- Telegram (owner alerts) ----------------
const tgOn = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
const tgQueue = []; let tgTimer = null;
/** Telegram allows about one message per second to a chat: queue and send in order. */
function telegram(text) {
  if (!tgOn()) return;
  if (tgQueue.length > 50) return; // something is flooding — drop extras
  tgQueue.push(String(text).slice(0, 3500));
  if (!tgTimer) drain();
}
function drain() {
  const text = tgQueue.shift();
  if (text === undefined) { tgTimer = null; return; }
  fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
  }).then((r) => { if (!r.ok) console.warn('[telegram]', r.status); }).catch((e) => console.warn('[telegram]', e.message));
  tgTimer = setTimeout(drain, tgQueue.length ? 1050 : 0); tgTimer.unref?.();
}

module.exports = { vapid, subscribe, unsubscribe, toUser, telegram, tgOn, encrypt, vapidHeader, sendOne };
