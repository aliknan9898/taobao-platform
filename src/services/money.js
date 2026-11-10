// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Seller withdrawals and customer returns.
 *  - Seller balance: payable ledger net (incl. negative refund entries) − withdrawals requested or paid.
 *  - Withdrawals are paid by hand (bank / Wise) and recorded by the admin with a reference.
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

function sellerBalance(sellerId) {
  const led = db.ledger.all((l) => l.seller_id === sellerId && l.status !== 'void');
  const sum = (f) => money(led.filter(f).reduce((a, l) => a + l.net, 0));
  const pays = db.payouts.all((p) => p.seller_id === sellerId);
  const psum = (st) => money(pays.filter((p) => p.status === st).reduce((a, p) => a + p.amount, 0));
  const earned = sum((l) => l.status === 'payable' || l.status === 'paid');
  const requested = psum('requested'); const paid = psum('paid');
  return { currency: config.currency, pending: sum((l) => l.status === 'pending_payout'), available: money(earned - requested - paid), requested, withdrawn: paid, min_withdrawal: MIN_WITHDRAWAL };
}

function cleanDetails(d = {}) {
  const out = { method: ['bank', 'wise', 'paypal'].includes(d.method) ? d.method : 'bank', holder: str(d.holder, 100), iban: str(d.iban, 50).replace(/\s+/g, '').toUpperCase(), bic: str(d.bic, 20).toUpperCase(), email: str(d.email, 120), note: str(d.note, 200) };
  if (!out.holder) throw httpError(400, 'Enter the account holder name');
  if (out.method === 'bank' && !/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(out.iban)) throw httpError(400, 'Enter a valid IBAN');
  if (out.method !== 'bank' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw httpError(400, `Enter the email of your ${out.method === 'wise' ? 'Wise' : 'PayPal'} account`);
  return out;
}

function requestWithdrawal(seller, { amount, details }) {
  if (seller.status !== 'active') throw httpError(403, 'Your shop is not active');
  const bal = sellerBalance(seller.id);
  const a = money(amount);
  if (!(a >= MIN_WITHDRAWAL)) throw httpError(400, `The minimum withdrawal is ${MIN_WITHDRAWAL} ${config.currency.toUpperCase()}`);
  if (a > bal.available) throw httpError(409, 'That is more than your available earnings');
  if (db.payouts.find((p) => p.seller_id === seller.id && p.status === 'requested')) throw httpError(409, 'You already have a withdrawal waiting — Kinan will process it soon');
  const d = cleanDetails(details || seller.payout_details || {});
  db.sellers.update(seller.id, { payout_details: d });
  return db.payouts.insert({ seller_id: seller.id, amount: a, currency: config.currency, details: d, status: 'requested' });
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

module.exports = { sellerBalance, requestWithdrawal, listPayouts, decidePayout, requestReturn, decideReturn, buyerReturnView, adminReturns, RETURN_DAYS, REASON_LABEL };
