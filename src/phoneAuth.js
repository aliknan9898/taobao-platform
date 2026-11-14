// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Sign in to Kinan Shop with a phone number: a 6-digit code by SMS, no password. A new number creates a customer account.
 * SMS sender (the first one set up is used):
 *   Twilio Verify   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID  (Twilio makes and checks the code; fraud guard)
 *   Brevo SMS       BREVO_API_KEY (already used for email) + SMS_SENDER (≤11 letters, e.g. "Kinan"); Kinan makes the code
 * Safety: codes last 10 minutes, 5 wrong tries end a code, one SMS a minute and 5 an hour per number, and only numbers
 * from PHONE_LOGIN_PREFIXES (default: Europe, the UK and North America) — stops SMS-pumping fraud on far-away numbers.
 * The owner and staff never sign in by phone.
 */
const crypto = require('crypto');
const db = require('./db');
const { httpError, createSession, isOwner } = require('./auth');

const TTL = 10 * 60e3; const TRIES = 5; const GAP = 60e3; const PER_HOUR = 5;
const DEFAULT_PREFIXES = '+44,+353,+356,+33,+49,+39,+34,+351,+31,+32,+352,+43,+41,+45,+46,+47,+358,+354,+48,+420,+421,+36,+40,+359,+30,+357,+385,+386,+370,+371,+372,+1';
const prefixes = () => String(process.env.PHONE_LOGIN_PREFIXES || DEFAULT_PREFIXES).split(',').map((x) => x.trim()).filter((x) => /^\+\d{1,4}$/.test(x));
const twilio = () => (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SID ? { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, service: process.env.TWILIO_VERIFY_SID } : null);
const brevo = () => (process.env.BREVO_API_KEY && process.env.SMS_SENDER ? { key: process.env.BREVO_API_KEY, sender: String(process.env.SMS_SENDER).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 11) } : null);
const provider = () => (twilio() ? 'twilio' : brevo() ? 'brevo' : null);
const enabled = () => Boolean(provider());
const pepper = () => process.env.SESSION_SECRET || process.env.APP_SECRET || 'kinan-phone';
const hash = (s) => crypto.createHmac('sha256', pepper()).update(String(s)).digest('hex');

/** "+356 7912 3456", "00356…" → "+35679123456"; null when it is not a full international number. */
function normalize(raw) {
  let s = String(raw || '').replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
const sid = (phone) => `ph_${hash(phone).slice(0, 40)}`;

async function sendTwilio(phone, lang) {
  const t = twilio();
  const r = await fetch(`https://verify.twilio.com/v2/Services/${t.service}/Verifications`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Basic ${Buffer.from(`${t.sid}:${t.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: phone, Channel: 'sms', ...(lang === 'ar' ? { Locale: 'ar' } : {}) })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(r.status === 429 ? 429 : 502, `The code could not be sent${j.message ? `: ${j.message}` : ''}`);
}
async function checkTwilio(phone, code) {
  const t = twilio();
  const r = await fetch(`https://verify.twilio.com/v2/Services/${t.service}/VerificationCheck`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Basic ${Buffer.from(`${t.sid}:${t.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: phone, Code: code })
  });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.status === 'approved';
}
async function sendBrevo(phone, code, lang) {
  const b = brevo();
  const content = lang === 'ar' ? `رمز الدخول إلى كنان: ${code}\nصالح 10 دقائق. لا تشاركه مع أحد.` : `Your Kinan sign-in code: ${code}\nValid for 10 minutes. Do not share it.`;
  const r = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'api-key': b.key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: b.sender, recipient: phone.replace('+', ''), content, type: 'transactional' })
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw httpError(502, `The code could not be sent${j.message ? `: ${j.message}` : ''}`); }
}

/** Send a sign-in code by SMS. */
async function start({ phone, lang }) {
  if (!enabled()) throw httpError(503, 'Sign-in by phone is not set up yet');
  const p = normalize(phone);
  if (!p) throw httpError(400, 'Enter your number with the country code, e.g. +356 7912 3456');
  if (!prefixes().some((x) => p.startsWith(x))) throw httpError(400, 'Sign-in by phone is not available for this country yet — use email or Google');
  const id = sid(p); const now = Date.now(); const prev = db.oauthStates.get(id);
  const sent = (prev?.sent || []).filter((t) => now - t < 3600e3);
  if (sent.length && now - sent[sent.length - 1] < GAP) throw httpError(429, 'Please wait a minute before asking for a new code');
  if (sent.length >= PER_HOUR) throw httpError(429, 'Too many codes for this number — try again in an hour');
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  if (provider() === 'twilio') await sendTwilio(p, lang); else await sendBrevo(p, code, lang);
  const doc = { kind: 'phone', code_hash: provider() === 'twilio' ? null : hash(`${p}:${code}`), tries: 0, sent: [...sent, now], expires_at: now + TTL };
  if (prev) db.oauthStates.update(id, doc); else db.oauthStates.insert({ id, ...doc });
  return { sent: true, phone: p.replace(/^(\+\d{1,3})\d+(\d{2})$/, '$1 •••• $2'), expires_in: TTL / 1000 };
}

/** Check the code; sign in (or create the customer account for this number). */
async function verify({ phone, code, name, lang }) {
  const p = normalize(phone); const c = String(code || '').replace(/\D/g, '');
  if (!p || c.length !== 6) throw httpError(400, 'Enter the 6-digit code');
  const id = sid(p); const st = db.oauthStates.get(id);
  if (!st || st.kind !== 'phone' || st.expires_at < Date.now()) throw httpError(400, 'This code has expired — ask for a new one');
  if (st.tries >= TRIES) throw httpError(429, 'Too many wrong codes — ask for a new one');
  db.oauthStates.update(id, { tries: st.tries + 1 });
  const ok = st.code_hash ? crypto.timingSafeEqual(Buffer.from(st.code_hash), Buffer.from(hash(`${p}:${c}`))) : await checkTwilio(p, c);
  if (!ok) throw httpError(400, 'That code is not right');
  db.oauthStates.update(id, { expires_at: 0, code_hash: null });
  let u = db.users.find((x) => x.phone_login === p && x.role === 'buyer');
  if (db.users.find((x) => x.phone_login === p && (isOwner(x) || x.role !== 'buyer'))) throw httpError(403, 'This number signs in with Google or a password');
  if (u && u.status && u.status !== 'active') throw httpError(403, 'This account is not active');
  let created = false;
  if (!u) {
    u = db.users.insert({ email: null, name: String(name || '').trim().slice(0, 80) || `Customer ${p.slice(-4)}`, role: 'buyer', status: 'active', pass: null, phone_login: p, phone: p, lang: ['ar', 'en'].includes(lang) ? lang : null });
    created = true;
  }
  const { token } = createSession(u);
  return { token, user: u, created };
}

module.exports = { enabled, provider, start, verify, normalize };
