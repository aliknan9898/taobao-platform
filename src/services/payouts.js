// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Paying sellers: settings, fees, the payout calendar and automatic sending.
 *  - Settings (admin → Withdrawals): payout days (e.g. Monday and Thursday) and hour, automatic sending on/off, and per
 *    method (bank, PayPal, Payoneer, Wise, Stripe): on/off, minimum and fee (fixed + %). The seller sees the fee and
 *    what arrives before asking.
 *  - PayPal Payouts API (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=live|sandbox): test payments and
 *    withdrawals to PayPal accounts are sent by Kinan with one tap, or automatically on payout days.
 *  - Stripe Connect (Express): the seller opens a Stripe account from the Seller Center; Stripe checks their identity
 *    and their bank account or debit card (Visa / Mastercard) — no test payment needed. Withdrawals are sent as Stripe
 *    transfers (STRIPE_PAYOUT_CURRENCY, default eur = the Stripe balance currency).
 *  - Bank (IBAN), Payoneer and Wise are paid by hand on payout days (Kinan's admin lists what is due).
 */
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');

const SID = 'payout_settings';
const TZ = 'Europe/Malta';
const METHODS = ['bank', 'paypal', 'payoneer', 'wise', 'stripe'];
const DEFAULTS = {
  days: [1, 4], hour: 10, auto: false,
  methods: { bank: { enabled: true, min: 10, fee_fixed: 0, fee_pct: 0 }, paypal: { enabled: true, min: 20, fee_fixed: 0, fee_pct: 0 }, payoneer: { enabled: true, min: 20, fee_fixed: 0, fee_pct: 0 },
    wise: { enabled: true, min: 10, fee_fixed: 0, fee_pct: 0 }, stripe: { enabled: true, min: 10, fee_fixed: 0, fee_pct: 0 } }
};
const money = (n) => Math.round(Number(n) * 100) / 100;
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function settings() {
  const s = db.settings.get(SID) || {};
  const out = { days: Array.isArray(s.days) && s.days.length ? s.days : DEFAULTS.days, hour: s.hour ?? DEFAULTS.hour, auto: Boolean(s.auto), methods: {} };
  for (const m of METHODS) out.methods[m] = { ...DEFAULTS.methods[m], ...((s.methods || {})[m] || {}) };
  return out;
}
function save(b = {}) {
  const cur = settings();
  const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : cur.days;
  if (!days.length) throw httpError(400, 'Choose at least one payout day');
  const methods = {};
  for (const m of METHODS) {
    const v = { ...cur.methods[m], ...((b.methods || {})[m] || {}) };
    methods[m] = { enabled: Boolean(v.enabled), min: num(v.min, 1, 100000, 10), fee_fixed: num(v.fee_fixed, 0, 100, 0), fee_pct: num(v.fee_pct, 0, 20, 0) };
  }
  const doc = { days, hour: Math.floor(num(b.hour ?? cur.hour, 0, 23, 10)), auto: b.auto === undefined ? cur.auto : Boolean(b.auto), methods };
  if (db.settings.get(SID)) db.settings.update(SID, doc); else db.settings.insert({ id: SID, ...doc });
  return view();
}
/** Fee and what arrives, for an amount sent with a method. */
function feeFor(method, amount) {
  const m = settings().methods[method] || DEFAULTS.methods.bank;
  const fee = money(Math.min(amount, (m.fee_fixed || 0) + amount * (m.fee_pct || 0) / 100));
  return { fee, net: money(amount - fee), min: m.min, enabled: m.enabled };
}
function malta(t = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}` };
}
/** The next payout day (today counts until the payout hour). */
function nextPayoutDay(now = Date.now()) {
  const s = settings();
  for (let i = 0; i < 8; i++) {
    const t = now + i * 86400e3; const m = malta(t);
    if (s.days.includes(m.dow) && (i > 0 || m.hour < s.hour + 1)) return { day: m.day, weekday: DAYS[m.dow] };
  }
  return null;
}
function view() {
  const s = settings();
  return { ...s, day_names: s.days.map((d) => DAYS[d]), next: nextPayoutDay(), paypal: paypalReady(), paypal_env: paypalEnv(), stripe_connect: stripeReady() };
}

// ---------------- PayPal Payouts ----------------
const paypalEnv = () => (String(process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox' ? 'sandbox' : 'live');
const paypalReady = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const paypalBase = () => (paypalEnv() === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com');
let ppToken = null;
async function paypalToken() {
  if (ppToken && ppToken.exp > Date.now() + 60e3) return ppToken.v;
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw httpError(502, `PayPal: ${j.error_description || j.error || r.status}`);
  ppToken = { v: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 };
  return ppToken.v;
}
async function paypal(path, body, method = 'POST') {
  const r = await fetch(`${paypalBase()}${path}`, { method, signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${await paypalToken()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(502, `PayPal: ${j.message || j.name || r.status}${j.details?.[0]?.issue ? ` (${j.details[0].issue})` : ''}`);
  return j;
}
/** Send money to a PayPal account; returns the batch id. */
async function paypalSend({ email, amount, currency, id, note, subject }) {
  if (!paypalReady()) throw httpError(409, 'PayPal Payouts is not set up (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
  const j = await paypal('/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: `${id}_${crypto.randomBytes(3).toString('hex')}`, email_subject: subject || 'You have a payment from Kinan', email_message: note || 'Payment from Kinan' },
    items: [{ recipient_type: 'EMAIL', amount: { value: money(amount).toFixed(2), currency: String(currency).toUpperCase() }, receiver: email, note: note || 'Kinan', sender_item_id: id }]
  });
  return j.batch_header?.payout_batch_id;
}
/** PayPal batch → 'SUCCESS' | 'PENDING' | 'UNCLAIMED' | 'FAILED' … (of its one item). */
async function paypalStatus(batchId) {
  const j = await paypal(`/v1/payments/payouts/${batchId}`, null, 'GET');
  const it = (j.items || [])[0] || {};
  return { status: it.transaction_status || j.batch_header?.batch_status || 'PENDING', error: it.errors?.message || null, fee: it.payout_item_fee?.value || null };
}

// ---------------- Stripe Connect ----------------
const stripeReady = () => Boolean(config.stripeSecretKey) && !require('../payments/stripe').demoMode();
async function stripeApi(path, params, method = 'POST', key) {
  const { form } = require('../payments/stripe');
  const r = await fetch(`${config.stripeApiUrl}${path}`, { method, signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${config.stripeSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: method === 'POST' ? form(params || {}) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(r.status === 400 ? 400 : 502, `Stripe: ${j.error?.message || r.status}`);
  return j;
}
/** Start (or continue) the seller's Stripe Express onboarding; returns the Stripe link to open. */
async function stripeOnboard(seller) {
  if (!stripeReady()) throw httpError(409, 'Payouts with Stripe are not available yet');
  if (!settings().methods.stripe.enabled) throw httpError(409, 'Payouts with Stripe are switched off');
  let acct = seller.stripe_connect?.id;
  if (!acct) {
    const u = db.users.get(seller.user_id);
    const country = String(seller.kyc?.details?.country || 'MT').toUpperCase().slice(0, 2);
    const a = await stripeApi('/accounts', { type: 'express', country, email: u?.email || undefined, capabilities: { transfers: { requested: true } }, business_profile: { name: seller.shop_name, url: `${config.publicBaseUrl}/s/${seller.id}` }, metadata: { kinan_seller: seller.id } }, 'POST', `acct_${seller.id}`);
    acct = a.id;
    db.sellers.update(seller.id, { stripe_connect: { id: acct, created_at: Date.now(), payouts_enabled: false } });
  }
  const base = String(config.publicBaseUrl).replace(/\/$/, '');
  const link = await stripeApi('/account_links', { account: acct, type: 'account_onboarding', refresh_url: `${base}/seller?stripe=retry#/earnings`, return_url: `${base}/seller?stripe=done#/earnings` });
  return { url: link.url };
}
/** Read the seller's Stripe account; when Stripe allows payouts, it becomes a confirmed payout method. */
async function stripeRefresh(seller) {
  const id = seller.stripe_connect?.id; if (!id || !stripeReady()) return null;
  const a = await stripeApi(`/accounts/${id}`, null, 'GET');
  const ext = (a.external_accounts?.data || [])[0];
  const info = { id, payouts_enabled: Boolean(a.payouts_enabled && a.capabilities?.transfers === 'active'), details_submitted: Boolean(a.details_submitted), requirements: (a.requirements?.currently_due || []).slice(0, 5),
    destination: ext ? (ext.object === 'card' ? `${ext.brand || 'Card'} •••• ${ext.last4}` : `${ext.bank_name || 'Bank'} •••• ${ext.last4}`) : null, checked_at: Date.now() };
  const s = db.sellers.update(seller.id, { stripe_connect: { ...(seller.stripe_connect || {}), ...info } });
  const list = Array.isArray(s.payout_methods) ? s.payout_methods : [];
  const cur = list.find((m) => m.type === 'stripe' && m.status !== 'removed');
  if (info.payouts_enabled) {
    const rec = { id: cur?.id || `pm_${crypto.randomBytes(6).toString('hex')}`, type: 'stripe', holder: s.kyc?.details?.full_name || s.shop_name, account: id, destination: info.destination, status: 'verified', verified_at: cur?.verified_at || Date.now(), created_at: cur?.created_at || Date.now(), is_default: cur ? cur.is_default : !list.some((m) => m.status === 'verified' && m.is_default), note: null };
    db.sellers.update(s.id, { payout_methods: cur ? list.map((m) => (m.id === cur.id ? { ...m, ...rec } : m)) : [...list, rec] });
    if (!cur) { try { require('../push').telegram(`✅ ${s.shop_name} connected Stripe for payouts (${info.destination || 'account'})`); } catch { /* optional */ } }
  }
  return info;
}
async function stripeTransfer({ account, amount, id, note }) {
  const cur = String(process.env.STRIPE_PAYOUT_CURRENCY || 'eur').toLowerCase();
  const base = config.currency.toLowerCase(); let value = amount;
  if (cur !== base) { const r = require('./fx').chargeRate(cur.toUpperCase()); if (!r) throw httpError(409, `No exchange rate for ${cur.toUpperCase()}`); value = amount * r; }
  const t = await stripeApi('/transfers', { amount: Math.round(value * 100), currency: cur, destination: account, description: note || 'Kinan earnings', metadata: { kinan_payout: id } }, 'POST', `tr_${id}`);
  return { id: t.id, amount: money(value), currency: cur.toUpperCase() };
}

// ---------------- sending ----------------
/** Send a requested withdrawal through PayPal or Stripe (the others are paid by hand). */
// A process-local guard prevents overlapping sends; the persisted processing state
// prevents a restart from automatically retrying an ambiguous provider request.
const sending = new Set();
async function send(payoutId, admin) {
  if (sending.has(payoutId)) throw httpError(409, 'Withdrawal is already being sent');
  sending.add(payoutId);
  try {
    const p = db.payouts.get(payoutId);
    if (!p) throw httpError(404, 'Withdrawal not found');
    if (p.status !== 'requested') throw httpError(409, 'This withdrawal is not waiting');
    const method = p.details?.method; const net = money(p.net ?? p.amount);
    if (method !== 'paypal' && method !== 'stripe') throw httpError(400, 'This method is paid by hand — send it from your bank, Payoneer or Wise, then tap Mark paid');
    db.payouts.update(p.id, { status: 'processing', sending_at: Date.now(), by: admin?.id || 'auto', provider: method, send_error: null });
    // Never call an external money-moving API before the intent is durable.
    // If the flush fails, leave processing for manual reconciliation.
    await db.flush();
    try {
      if (method === 'paypal') {
        const batch = await paypalSend({ email: p.details.email, amount: net, currency: p.currency, id: p.id, note: `Kinan earnings — ${db.sellers.get(p.seller_id)?.shop_name || ''}` });
        const out = db.payouts.update(p.id, { provider_ref: batch, reference: `PayPal ${batch}` });
        await db.flush();
        return out;
      }
      const t = await stripeTransfer({ account: p.details.account, amount: net, id: p.id });
      const out = db.payouts.update(p.id, { status: 'paid', provider_ref: t.id, reference: `Stripe ${t.id} (${t.amount} ${t.currency})`, paid_at: Date.now() });
      await db.flush();
      require('../notify').payoutUpdate(out);
      return out;
    } catch (e) {
      // Timeouts and network errors are ambiguous: the provider may have paid.
      // Never reset to 'requested' automatically or another click may double-pay.
      db.payouts.update(p.id, { send_error: String(e.message).slice(0, 300), reconciliation_required: true });
      try { await db.flush(); } catch (flushError) { console.error('[payouts] reconciliation state persistence failed', flushError.message); }
      throw e;
    }
  } finally { sending.delete(payoutId); }
}
/** Follow PayPal payouts that are still processing. */
async function checkProcessing() {
  for (const p of db.payouts.all((x) => x.status === 'processing' && x.provider === 'paypal' && x.provider_ref)) {
    try {
      const st = await paypalStatus(p.provider_ref);
      if (st.status === 'SUCCESS') { const out = db.payouts.update(p.id, { status: 'paid', paid_at: Date.now(), provider_fee: st.fee }); require('../notify').payoutUpdate(out); }
      else if (['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'].includes(st.status)) {
        db.payouts.update(p.id, { status: 'requested', send_error: `PayPal: ${st.status}${st.error ? ` — ${st.error}` : ''}` });
        try { require('../push').telegram(`⚠️ PayPal payout failed (${st.status}) for ${db.sellers.get(p.seller_id)?.shop_name}: ${st.error || ''}`); } catch { /* optional */ }
      } else if (st.status === 'UNCLAIMED' && !p.unclaimed_told) {
        db.payouts.update(p.id, { unclaimed_told: true });
        try { require('../push').telegram(`ℹ️ PayPal payout unclaimed: ${db.sellers.get(p.seller_id)?.shop_name} has not accepted it yet (PayPal returns it after 30 days).`); } catch { /* optional */ }
      }
    } catch (e) { console.warn('[payouts] paypal status', e.message); }
  }
}
/** Send a payout account's test payment through PayPal. */
async function sendTest(sellerId, methodId, admin) {
  const s = db.sellers.get(sellerId); const m = (s?.payout_methods || []).find((x) => x.id === methodId);
  if (!m) throw httpError(404, 'Payout method not found');
  if (m.type !== 'paypal') throw httpError(400, 'Only PayPal tests can be sent from here — send the others by hand, then tap Test sent');
  const batch = await paypalSend({ email: m.email, amount: m.test_amount, currency: m.test_currency || 'USD', id: `${m.id}_t`, subject: 'Kinan test payment', note: 'Kinan test payment — enter this exact amount in your Seller Center to confirm your account' });
  return require('./money').decideMethod(sellerId, methodId, { action: 'test_sent', reference: `PayPal ${batch}` }, admin);
}
let lastAuto = null;
/** Every few minutes: follow PayPal; on payout days at the payout hour, send what can be sent automatically. */
async function tick(now = Date.now()) {
  await checkProcessing().catch(() => {});
  const s = settings(); const m = malta(now);
  if (!s.days.includes(m.dow) || m.hour < s.hour || lastAuto === m.day) return null;
  lastAuto = m.day;
  const due = db.payouts.all((p) => p.status === 'requested');
  if (!due.length) return { sent: 0 };
  let sent = 0; const hand = [];
  for (const p of due) {
    const auto = s.auto && ((p.details?.method === 'paypal' && paypalReady()) || (p.details?.method === 'stripe' && stripeReady()));
    if (!auto) { hand.push(p); continue; }
    try { await send(p.id, null); sent++; } catch (e) { hand.push(p); console.warn('[payouts] auto', e.message); }
  }
  try {
    const cur = config.currency.toUpperCase();
    require('../push').telegram([`💸 Payout day: ${due.length} withdrawal(s)`, sent ? `✅ ${sent} sent automatically` : null,
      hand.length ? `✋ ${hand.length} to pay by hand: ${hand.map((p) => `${db.sellers.get(p.seller_id)?.shop_name} ${money(p.net ?? p.amount)} ${cur} (${p.details?.method})`).join(', ')}` : null, `${config.publicBaseUrl}/admin`].filter(Boolean).join('\n'));
  } catch { /* optional */ }
  return { sent, hand: hand.length };
}

module.exports = { settings, save, view, feeFor, nextPayoutDay, send, sendTest, tick, checkProcessing, stripeOnboard, stripeRefresh, paypalReady, stripeReady, METHODS };
