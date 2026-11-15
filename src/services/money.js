// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Seller withdrawals and customer returns.
 *  - Seller balance: payable ledger net (incl. negative refund entries) − withdrawals requested or paid.
 *  - Withdrawals go to a verified payout account (IBAN, PayPal, Payoneer, Wise), are paid by hand and recorded by the
 *    admin with a reference.
 *  - Returns: the customer asks within RETURN_DAYS of delivery; the admin approves/rejects and refunds
 *    to the Kinan wallet or the original card. Refunds can be charged back to the seller's earnings.
 */
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');
const stripe = require('../payments/stripe');
const shop = require('./shop');
const notify = require('../notify');

const money = (n) => Math.round(Number(n) * 100) / 100;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const RETURN_DAYS = Number(process.env.RETURN_DAYS || 14);
const MIN_WITHDRAWAL = Number(process.env.MIN_WITHDRAWAL || 10);

// ---------------- Seller balance & withdrawals ----------------

/** The smallest withdrawal any switched-on method accepts (MIN_WITHDRAWAL if none set). */
function minWithdrawal() { try { const ms = Object.values(require('./payouts').settings().methods).filter((m) => m.enabled).map((m) => m.min); return ms.length ? Math.min(...ms) : MIN_WITHDRAWAL; } catch { return MIN_WITHDRAWAL; } }
function sellerBalance(sellerId) {
  const led = db.ledger.all((l) => l.seller_id === sellerId && l.status !== 'void');
  const sum = (f) => money(led.filter(f).reduce((a, l) => a + l.net, 0));
  const pays = db.payouts.all((p) => p.seller_id === sellerId);
  const psum = (st) => money(pays.filter((p) => p.status === st).reduce((a, p) => a + p.amount, 0));
  const earned = sum((l) => l.status === 'payable' || l.status === 'paid');
  const requested = money(psum('requested') + psum('processing')); const paid = psum('paid');
  return { currency: config.currency, pending: sum((l) => l.status === 'pending_payout'), available: money(earned - requested - paid), requested, withdrawn: paid, min_withdrawal: minWithdrawal() };
}

// ---------------- Payout methods (verified with a small test payment) ----------------
// A seller adds where they want to be paid: a bank account (IBAN), PayPal, Payoneer or Wise. Kinan sends a small test
// payment with random cents (0.51–0.99) and the seller types the exact amount they received: only then is the method
// verified and usable for withdrawals. This proves the account exists and belongs to the seller, and stops a stolen
// login from redirecting earnings. Card numbers are never collected (card payouts need a licensed provider).
const TYPES = { bank: 'Bank account (IBAN)', paypal: 'PayPal', payoneer: 'Payoneer', wise: 'Wise', stripe: 'Stripe (bank or card)' };
const MAX_METHODS = 4; const TRIES = 3;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** IBAN check digits (ISO 13616, mod 97). */
function ibanOk(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const r = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0; for (const ch of r) m = (m * 10 + Number(ch)) % 97;
  return m === 1;
}
const norm = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
/** Does the account holder look like the person verified for the shop (KYC) or the shop owner? */
function nameMatches(seller, holder) {
  const want = [seller.kyc?.details?.full_name, db.users.get(seller.user_id)?.name].filter(Boolean).map(norm);
  const h = norm(holder); if (!h.length || !want.length) return null;
  return want.some((w) => w.length && w.filter((x) => h.includes(x)).length >= Math.min(2, w.length));
}
function cleanMethod(d = {}) {
  const type = Object.hasOwn(TYPES, d.type || d.method) && (d.type || d.method) !== 'stripe' ? (d.type || d.method) : null;
  if (!type) throw httpError(400, 'Choose bank account, PayPal, Payoneer or Wise');
  const out = { type, holder: str(d.holder, 100) };
  if (!out.holder) throw httpError(400, 'Enter the account holder name, exactly as on the account');
  if (type === 'bank') {
    out.iban = str(d.iban, 50).replace(/\s+/g, '').toUpperCase(); out.bic = str(d.bic, 20).replace(/\s+/g, '').toUpperCase();
    if (!ibanOk(out.iban)) throw httpError(400, 'This IBAN is not valid — check it on your bank statement');
    if (out.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(out.bic)) throw httpError(400, 'This BIC / SWIFT code is not valid');
  } else {
    out.email = str(d.email, 120).toLowerCase();
    if (!EMAIL.test(out.email)) throw httpError(400, `Enter the email of your ${TYPES[type]} account`);
    if (type === 'payoneer' && d.payoneer_id) out.payoneer_id = str(d.payoneer_id, 30).replace(/\D/g, '');
  }
  return out;
}
const masked = (m) => (m.type === 'stripe' ? (m.destination || 'Stripe account') : m.type === 'bank' ? `IBAN ${m.iban.slice(0, 4)} •••• ${m.iban.slice(-4)}` : m.email.replace(/^(.).*(@.*)$/, '$1•••$2'));
/** What the seller sees (never the test amount). */
function methodView(m) {
  return { id: m.id, type: m.type, type_name: TYPES[m.type], label: masked(m), holder: m.holder, status: m.status, tries_left: Math.max(0, TRIES - (m.tries || 0)), note: m.note || null,
    created_at: m.created_at, test_sent_at: m.test_sent_at || null, verified_at: m.verified_at || null, is_default: Boolean(m.is_default) };
}
function methodsOf(seller) { return Array.isArray(seller.payout_methods) ? seller.payout_methods : []; }
function saveMethods(seller, list) { return db.sellers.update(seller.id, { payout_methods: list }); }

function addMethod(seller, body) {
  const list = methodsOf(seller).filter((m) => m.status !== 'removed');
  if (list.length >= MAX_METHODS) throw httpError(400, `You can keep up to ${MAX_METHODS} payout methods — remove one first`);
  if (!require('./payouts').settings().methods[body.type || body.method]?.enabled) throw httpError(400, 'This payout method is not available right now');
  const m = cleanMethod(body);
  const key = m.type === 'bank' ? m.iban : m.email;
  if (list.some((x) => x.type === m.type && (x.iban || x.email) === key)) throw httpError(409, 'You already added this account');
  const cents = 51 + require('crypto').randomInt(0, 49);
  const rec = { id: `pm_${require('crypto').randomBytes(6).toString('hex')}`, ...m, status: 'pending_test', test_amount: cents / 100,
    test_currency: m.type === 'bank' && /^GB/.test(m.iban) ? 'GBP' : m.type === 'bank' ? 'EUR' : 'USD', tries: 0, name_ok: nameMatches(seller, m.holder), created_at: Date.now(), is_default: false };
  saveMethods(seller, [...methodsOf(seller), rec]);
  try { require('../push').telegram(`🏦 Payout method to verify: ${seller.shop_name} — ${TYPES[m.type]} (${masked(rec)}). Send a test of ${rec.test_amount} ${rec.test_currency}.\n${config.publicBaseUrl}/admin`); } catch { /* optional */ }
  try { notify.payoutMethodChanged(seller, rec); } catch { /* optional */ }
  return methodView(rec);
}
function removeMethod(seller, id) {
  const list = methodsOf(seller); const m = list.find((x) => x.id === id && x.status !== 'removed');
  if (!m) throw httpError(404, 'Payout method not found');
  if (db.payouts.find((p) => p.seller_id === seller.id && p.status === 'requested' && p.method_id === id)) throw httpError(409, 'A withdrawal to this account is in progress');
  saveMethods(seller, list.map((x) => (x.id === id ? { ...x, status: 'removed', is_default: false, removed_at: Date.now() } : x)));
  return { ok: true };
}
function setDefault(seller, id) {
  const list = methodsOf(seller); if (!list.some((x) => x.id === id && x.status === 'verified')) throw httpError(400, 'Only a verified account can be the default');
  saveMethods(seller, list.map((x) => ({ ...x, is_default: x.id === id }))); return { ok: true };
}
/** The seller types the amount of the test payment they received. */
function confirmMethod(seller, id, { amount }) {
  const list = methodsOf(seller); const m = list.find((x) => x.id === id);
  if (!m || m.status === 'removed') throw httpError(404, 'Payout method not found');
  if (m.status === 'verified') return methodView(m);
  if (m.status !== 'test_sent') throw httpError(409, 'Kinan has not sent the test payment yet — you will get an email when it is on its way');
  const a = Math.round(Number(String(amount).replace(',', '.')) * 100) / 100;
  if (!(a > 0)) throw httpError(400, 'Enter the amount you received, for example 0.73');
  const tries = (m.tries || 0) + 1; let upd;
  if (a === m.test_amount) upd = { status: 'verified', verified_at: Date.now(), tries, is_default: !list.some((x) => x.id !== id && x.status === 'verified' && x.is_default) };
  else upd = { tries, ...(tries >= TRIES ? { status: 'failed', note: 'The amount did not match 3 times. Kinan will check it with you.' } : {}) };
  const out = { ...m, ...upd };
  saveMethods(seller, list.map((x) => (x.id === id ? out : x)));
  if (out.status === 'verified') { try { require('../push').telegram(`✅ Payout method verified: ${seller.shop_name} — ${TYPES[m.type]} (${masked(m)})`); } catch { /* optional */ } }
  if (upd.status !== 'verified' && out.status !== 'failed') throw httpError(400, `That is not the amount we sent — ${TRIES - tries} try(s) left`);
  if (out.status === 'failed') throw httpError(400, out.note);
  return methodView(out);
}
/** Owner: payout methods waiting for a test payment (or for the seller to confirm). */
function adminMethods({ status } = {}) {
  const out = [];
  for (const s of db.sellers.all((x) => methodsOf(x).length)) for (const m of methodsOf(s)) {
    if (m.status === 'removed' || (status && status !== 'all' && m.status !== status)) continue;
    out.push({ seller_id: s.id, shop: s.shop_name, ...m, label: masked(m), type_name: TYPES[m.type] });
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}
function decideMethod(sellerId, id, { action, note, reference }, admin) {
  const s = db.sellers.get(sellerId); if (!s) throw httpError(404, 'Shop not found');
  const list = methodsOf(s); const m = list.find((x) => x.id === id && x.status !== 'removed');
  if (!m) throw httpError(404, 'Payout method not found');
  let upd;
  if (action === 'test_sent') {
    if (!['pending_test', 'failed'].includes(m.status)) throw httpError(409, 'This account is not waiting for a test payment');
    const again = m.status === 'failed';
    upd = { status: 'test_sent', test_sent_at: Date.now(), test_reference: str(reference, 80), tries: 0, note: null, ...(again ? { test_amount: (51 + require('crypto').randomInt(0, 49)) / 100 } : {}), by: admin.id };
  } else if (action === 'verify') upd = { status: 'verified', verified_at: Date.now(), verified_by: admin.id, note: str(note, 200) || 'Verified by Kinan', is_default: !list.some((x) => x.id !== id && x.status === 'verified' && x.is_default) };
  else if (action === 'reject') {
    if (!str(note, 300)) throw httpError(400, 'Tell the seller why');
    upd = { status: 'rejected', note: str(note, 300), by: admin.id };
  } else throw httpError(400, 'Unknown action');
  const out = { ...m, ...upd };
  saveMethods(s, list.map((x) => (x.id === id ? out : x)));
  try { notify.payoutMethodUpdate(s, out); } catch { /* optional */ }
  return { ...out, label: masked(out) };
}

function requestWithdrawal(seller, { amount, method_id }) {
  if (seller.status !== 'active') throw httpError(403, 'Your shop is not active');
  const bal = sellerBalance(seller.id);
  const a = money(amount);
  if (!(a >= minWithdrawal())) throw httpError(400, `The minimum withdrawal is ${minWithdrawal()} ${config.currency.toUpperCase()}`);
  if (a > bal.available) throw httpError(409, 'That is more than your available earnings');
  if (db.payouts.find((p) => p.seller_id === seller.id && (p.status === 'requested' || p.status === 'processing'))) throw httpError(409, 'You already have a withdrawal waiting — Kinan will process it soon');
  const verified = methodsOf(seller).filter((m) => m.status === 'verified');
  const m = verified.find((x) => x.id === method_id) || (!method_id ? verified.find((x) => x.is_default) || verified[0] : null);
  if (!m) throw httpError(400, 'Add a payout account and confirm the test payment first');
  // a payout account verified in the last 24 hours: wait (a stolen login cannot redirect earnings at once)
  if (Date.now() - (m.verified_at || 0) < 24 * 3600e3 && verified.length > 1) throw httpError(409, 'This account was verified less than 24 hours ago — for your safety, withdraw to it from tomorrow');
  const P = require('./payouts'); const f = P.feeFor(m.type, a);
  if (!f.enabled) throw httpError(400, `Withdrawals to ${TYPES[m.type]} are switched off for now — choose another account`);
  if (a < f.min) throw httpError(400, `The minimum withdrawal to ${TYPES[m.type]} is ${f.min} ${config.currency.toUpperCase()}`);
  const d = { method: m.type, holder: m.holder, iban: m.iban || '', bic: m.bic || '', email: m.email || '', payoneer_id: m.payoneer_id || '', account: m.account || '', destination: m.destination || '' };
  const next = P.nextPayoutDay();
  require('../push').telegram(`💸 Withdrawal request: ${seller.shop_name} — ${a} ${config.currency.toUpperCase()}${f.fee ? ` (fee ${f.fee}, sends ${f.net})` : ''} to ${TYPES[m.type]} (${masked(m)})${next ? ` · payout day ${next.weekday}` : ''}\n${config.publicBaseUrl}/admin`);
  return db.payouts.insert({ seller_id: seller.id, amount: a, fee: f.fee, net: f.net, currency: config.currency, details: d, method_id: m.id, status: 'requested', payout_day: next?.day || null });
}

function listPayouts({ sellerId, status } = {}) {
  return db.payouts.all((p) => (!sellerId || p.seller_id === sellerId) && (!status || p.status === status))
    .sort((a, b) => b.created_at - a.created_at)
    .map((p) => ({ ...p, shop: db.sellers.get(p.seller_id)?.shop_name }));
}

function decidePayout(id, { action, reference, note }, admin) {
  const p = db.payouts.get(id);
  if (!p) throw httpError(404, 'Withdrawal not found');
  if (p.status !== 'requested') throw httpError(409, 'This withdrawal was already handled');
  if (action === 'paid') {
    const out = db.payouts.update(id, { status: 'paid', reference: str(reference, 80), paid_at: Date.now(), by: admin.id });
    notify.payoutUpdate(out); return out;
  }
  if (action === 'decline') {
    if (!str(note, 300)) throw httpError(400, 'Tell the seller why');
    const out = db.payouts.update(id, { status: 'declined', note: str(note, 300), by: admin.id });
    notify.payoutUpdate(out); return out;
  }
  throw httpError(400, 'Unknown action');
}

// ---------------- Returns ----------------

const REASONS = ['damaged', 'wrong_item', 'not_as_described', 'missing_parts', 'changed_mind', 'other'];
const IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function deliveredAt(o) { return (o.timeline || []).filter((t) => t.event === 'delivered' || t.event === 'status:delivered').map((t) => t.at).pop() || null; }

function requestReturn(buyer, orderId, b = {}) {
  const o = db.orders.get(orderId);
  if (!o || o.buyer_id !== buyer.id) throw httpError(404, 'Order not found');
  if (o.status !== 'delivered') throw httpError(409, 'You can ask for a return once the order is delivered');
  const at = deliveredAt(o);
  if (at && Date.now() - at > RETURN_DAYS * 86400e3) throw httpError(409, `Returns must be requested within ${RETURN_DAYS} days of delivery`);
  if (db.returns.find((r) => r.order_id === o.id && ['requested', 'approved'].includes(r.status))) throw httpError(409, 'You already have an open return for this order');
  const reason = REASONS.includes(b.reason) ? b.reason : null;
  if (!reason) throw httpError(400, 'Choose a reason');
  const lines = (Array.isArray(b.lines) ? b.lines : []).map(String).filter((n) => o.lines.some((l) => l.line_no === n));
  if (!lines.length) throw httpError(400, 'Choose the item(s) you want to return');
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 3).map(String);
  for (const ph of photos) if (!IMG.test(ph) || ph.length > 400 * 1024) throw httpError(400, 'Photos must be JPEG, PNG or WebP under 300 KB');
  const value = money(o.lines.filter((l) => lines.includes(l.line_no)).reduce((a, l) => a + l.price * l.qty, 0));
  require('../push').telegram(`↩️ Return request for order ${o.id.slice(-8).toUpperCase()}: ${reason}\n${config.publicBaseUrl}/admin`);
  return db.returns.insert({ order_id: o.id, buyer_id: buyer.id, lines, reason, note: str(b.note, 1000), photos, value, status: 'requested' });
}

/** Admin: approve (customer sends it back) / reject / refund (wallet or card; optionally charged to the seller). */
async function decideReturn(id, { action, note, amount, refund_to = 'wallet', charge_seller = true }, admin) {
  const r = db.returns.get(id);
  if (!r) throw httpError(404, 'Return not found');
  const o = db.orders.get(r.order_id);
  if (['refunded', 'rejected'].includes(r.status)) throw httpError(409, 'This return is closed');
  if (action === 'approve') { const out = db.returns.update(id, { status: 'approved', admin_note: str(note, 1000) }); notify.returnUpdate(out); return out; }
  if (action === 'reject') {
    if (!str(note, 1000)) throw httpError(400, 'Tell the customer why');
    const out = db.returns.update(id, { status: 'rejected', admin_note: str(note, 1000) }); notify.returnUpdate(out); return out;
  }
  if (action !== 'refund') throw httpError(400, 'Unknown action');
  const a = money(amount ?? r.value);
  const already = money(db.returns.all((x) => x.order_id === o.id && x.status === 'refunded').reduce((s, x) => s + (x.refund_amount || 0), 0));
  if (!(a > 0) || a > money(o.total - already)) throw httpError(400, `Refund must be between 0 and ${money(o.total - already)}`);
  const to = refund_to === 'card' && o.payment?.provider === 'stripe' ? 'card' : 'wallet';
  if (to === 'card') await stripe.refund(o, a);
  else shop.walletEntry(o.buyer_id, a, `Refund — return for order ${o.id.slice(-8).toUpperCase()}`, { order_id: o.id, kind: 'refund' });
  if (charge_seller) {
    // Split the refund between the sellers of the returned items, in proportion to their value
    const lines = o.lines.filter((l) => r.lines.includes(l.line_no));
    const total = lines.reduce((s, l) => s + l.price * l.qty, 0) || 1;
    const bySeller = {};
    for (const l of lines) bySeller[l.seller_id] = (bySeller[l.seller_id] || 0) + (l.price * l.qty) / total;
    for (const [sellerId, share] of Object.entries(bySeller)) {
      db.ledger.insert({ order_id: o.id, seller_id: sellerId, type: 'refund', currency: o.currency, gross: money(-a * share), commission: 0, cost: 0, net: money(-a * share), status: 'payable', return_id: r.id });
    }
  }
  db.orders.update(o.id, (x) => ({ ...x, timeline: [...(x.timeline || []), { at: Date.now(), event: `refund:${a}:${to}`, by: admin.id }] }));
  const out = db.returns.update(id, { status: 'refunded', refund_amount: a, refund_to: to, charged_seller: Boolean(charge_seller), admin_note: str(note, 1000) || r.admin_note || '' });
  notify.returnUpdate(out);
  return out;
}

const REASON_LABEL = { damaged: 'Arrived damaged', wrong_item: 'Wrong item', not_as_described: 'Not as described', missing_parts: 'Missing parts', changed_mind: 'Changed my mind', other: 'Other' };
const buyerReturnView = (r) => ({ id: r.id, status: r.status, reason: r.reason, reason_label: REASON_LABEL[r.reason], note: r.note, lines: r.lines, value: r.value, admin_note: r.admin_note || '', refund_amount: r.refund_amount || null, refund_to: r.refund_to || null, created_at: r.created_at });

function adminReturns() {
  return db.returns.all().sort((a, b) => b.created_at - a.created_at).map((r) => {
    const o = db.orders.get(r.order_id);
    return { ...r, reason_label: REASON_LABEL[r.reason], buyer: db.users.get(r.buyer_id)?.email, currency: o?.currency, order_total: o?.total, paid_by: o?.payment?.provider,
      items: (o?.lines || []).filter((l) => r.lines.includes(l.line_no)).map((l) => ({ title: l.title, props: l.props, qty: l.qty, price: l.price, shop: db.sellers.get(l.seller_id)?.shop_name })) };
  });
}

module.exports = { addMethod, removeMethod, setDefault, confirmMethod, adminMethods, decideMethod, methodView, methodsOf, ibanOk, TYPES, sellerBalance, minWithdrawal, requestWithdrawal, listPayouts, decidePayout, requestReturn, decideReturn, buyerReturnView, adminReturns, RETURN_DAYS, REASON_LABEL };
