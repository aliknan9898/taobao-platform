// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Kinan gift cards: a shopper buys one by card (amount in their own currency), Kinan emails the code to the person it is
 * for, who adds it to their Kinan wallet and spends it on any order (all of it, or part with a card for the rest).
 * Codes: KINAN-XXXX-XXXX (no look-alike letters); never expire; one use. Kept in db.giftcards.
 */
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../auth');
const { config } = require('../config');

const MIN = 5; const MAX = 500;
const money = (v) => Math.round(Number(v) * 100) / 100;
const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do { const b = crypto.randomBytes(8); c = `KINAN-${[...b.subarray(0, 4)].map((x) => ALPHA[x % 32]).join('')}-${[...b.subarray(4)].map((x) => ALPHA[x % 32]).join('')}`; } while (db.giftcards.find((g) => g.code === c));
  return c;
}
const base = () => config.currency.toUpperCase();
const fmt = (v, cur) => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(v); } catch { return `${v} ${cur}`; } };

/** Start buying a gift card: returns the card (pending) and what the shop needs to take the card payment. */
async function create(buyer, b = {}) {
  const cur = String(b.currency || base()).toUpperCase();
  const amount = money(b.amount);
  if (!(amount >= MIN && amount <= MAX)) throw httpError(400, `Choose an amount between ${MIN} and ${MAX}`);
  const to = str(b.to_email, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw httpError(400, 'Enter the email of the person it is for');
  let rate = 1;
  if (cur !== base()) { rate = require('./fx').chargeRate(cur); if (!(rate > 0)) throw httpError(400, 'This currency is not available'); }
  const value = money(amount / rate); // what it adds to the wallet (the shop's own currency)
  const g = db.giftcards.insert({
    buyer_id: buyer.id, amount, currency: cur, value, value_currency: base(), to_email: to, to_name: str(b.to_name, 60), from_name: str(b.from_name || buyer.name, 60),
    message: str(b.message, 300), status: 'pending'
  });
  const pseudo = { id: g.id, buyer_id: buyer.id, total: value, currency: config.currency, ...(cur !== base() ? { charge: { currency: cur.toLowerCase(), rate, total: amount } } : {}) };
  const stripe = require('../payments/stripe');
  const payment = await stripe.createPaymentIntent(pseudo);
  db.giftcards.update(g.id, { payment: { provider: payment.provider, intent_id: payment.intent_id } });
  return { id: g.id, amount, currency: cur, client_secret: payment.client_secret || null, demo: payment.provider === 'demo' };
}

/** The card payment went through (Stripe webhook, or the shop confirming right after paying). */
async function paid(pi) {
  const id = pi?.metadata?.order_id; const g = id && db.giftcards.get(id);
  if (!g) return null;
  if (g.status !== 'pending') return g;
  const stripe = require('../payments/stripe');
  const want = stripe.toMinor(g.amount, g.currency.toLowerCase());
  if (pi.amount_received !== want || String(pi.currency).toLowerCase() !== g.currency.toLowerCase()) {
    console.warn('[giftcards] amount mismatch', g.id, pi.id); await stripe.refundIntent(pi.id, 'duplicate').catch(() => {}); return null;
  }
  return deliver(g.id, { intent_id: pi.id });
}
/** Give the card its code and email it to the person it is for (and a receipt to the buyer). */
function deliver(id, { intent_id } = {}) {
  const g = db.giftcards.get(id);
  if (!g || g.status !== 'pending') return g;
  const code = newCode();
  const out = db.giftcards.update(id, { status: 'active', code, paid_at: Date.now(), payment: { ...(g.payment || {}), intent_id: intent_id || g.payment?.intent_id } });
  const mailer = require('../mailer');
  const face = fmt(g.amount, g.currency);
  try {
    mailer.send({
      to: g.to_email, key: `gc:${g.id}`, kind: 'order', subject: `${g.from_name || 'Someone'} sent you a ${face} Kinan gift card 🎁`,
      title: `${face} to spend at Kinan`, highlight: code,
      lines: [g.to_name ? `Hi ${g.to_name},` : 'Hi,', `${g.from_name || 'Someone'} sent you a Kinan gift card worth ${face}.`, ...(g.message ? [`“${g.message}”`] : []), 'Add it to your Kinan wallet with the code above, then use it on any order. It does not expire.'],
      button: { text: 'Add to my wallet', url: `${config.publicBaseUrl}/#/giftcards/${code}` }
    });
    const buyer = db.users.get(g.buyer_id);
    if (buyer?.email) mailer.send({ to: buyer.email, key: `gcr:${g.id}`, kind: 'order', subject: `Your ${face} Kinan gift card was sent`, title: 'Gift card sent', lines: [`We emailed a ${face} Kinan gift card to ${g.to_email}.`, `Code: ${code}`] });
  } catch (e) { console.warn('[giftcards] email:', e.message); }
  try { require('../push').telegram(`🎁 Gift card sold: ${face} (to ${g.to_email.replace(/(^.).*(@.*$)/, '$1…$2')})`); } catch { /* optional */ }
  return out;
}

/** The shop asks right after paying (no need to wait for the webhook). */
async function confirm(user, id) {
  const g = db.giftcards.get(id);
  if (!g || g.buyer_id !== user.id) throw httpError(404, 'Not found');
  if (g.status !== 'pending') return view(g);
  const stripe = require('../payments/stripe');
  if (stripe.demoMode()) return view(deliver(id, { intent_id: `demo_${id}` }));
  const pi = await stripe.retrieveIntent(g.payment?.intent_id);
  if (pi && pi.status === 'succeeded') await paid(pi);
  return view(db.giftcards.get(id));
}

/** Add a gift card to the wallet of the shopper who has the code. */
function redeem(user, code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const norm = c.length === 13 && c.startsWith('KINAN') ? `KINAN-${c.slice(5, 9)}-${c.slice(9)}` : String(code || '').toUpperCase().trim();
  const tries = db.settings.get(`gc_tries_${user.id}`) || { n: 0, at: 0 };
  const fresh = Date.now() - tries.at > 3600e3;
  if (!fresh && tries.n >= 10) throw httpError(429, 'Too many tries — please wait an hour');
  const g = db.giftcards.find((x) => x.code === norm);
  if (!g || g.status === 'pending') {
    const doc = { n: (fresh ? 0 : tries.n) + 1, at: fresh ? Date.now() : tries.at };
    if (db.settings.get(`gc_tries_${user.id}`)) db.settings.update(`gc_tries_${user.id}`, doc); else db.settings.insert({ id: `gc_tries_${user.id}`, ...doc });
    throw httpError(404, 'This gift card code is not valid');
  }
  if (g.status === 'redeemed') throw httpError(409, g.redeemed_by === user.id ? 'You already added this gift card' : 'This gift card was already used');
  if (g.status !== 'active') throw httpError(409, 'This gift card cannot be used');
  db.giftcards.update(g.id, { status: 'redeemed', redeemed_by: user.id, redeemed_at: Date.now() });
  require('./shop').walletEntry(user.id, g.value, `Gift card ${g.code}`, { kind: 'giftcard', giftcard_id: g.id });
  return { added: g.value, currency: config.currency, face: g.amount, face_currency: g.currency, balance: require('./shop').walletOf(user.id).balance };
}

function view(g) { return g && { id: g.id, amount: g.amount, currency: g.currency, to_email: g.to_email, to_name: g.to_name, status: g.status, sent_at: g.paid_at || null, redeemed: g.status === 'redeemed' }; }
function mine(user) { return db.giftcards.all((g) => g.buyer_id === user.id && g.status !== 'pending').sort((a, b) => b.created_at - a.created_at).slice(0, 50).map(view); }

module.exports = { create, paid, confirm, redeem, mine, deliver, MIN, MAX };
