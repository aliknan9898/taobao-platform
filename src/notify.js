// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/** Who gets which email. Every send has a key, so retries and re-syncs never email twice. */
const db = require('./db');
const { config } = require('./config');
const mailer = require('./mailer');

const base = () => config.publicBaseUrl;
const ref = (o) => o.id.slice(-8).toUpperCase();
const emailOf = (userId) => db.users.get(userId)?.email;
const sellerEmail = (sellerId) => emailOf(db.sellers.get(sellerId)?.user_id);
const fire = (p) => { Promise.resolve(p).catch(() => {}); };
const money = (n, cur) => { try { return Number(n).toLocaleString('en-US', { style: 'currency', currency: String(cur || config.currency).toUpperCase() }); } catch { return `${n} ${cur}`; } };

function orderPaid(o) {
  fire(mailer.send({ to: emailOf(o.buyer_id), key: `paid:${o.id}`, kind: 'order', subject: `Order ${ref(o)} confirmed`, title: 'Thank you — your order is confirmed',
    lines: [`We received your payment of ${money(o.total, o.currency)}.`, `${o.lines.reduce((a, l) => a + l.qty, 0)} item(s): ${o.lines.map((l) => l.title).slice(0, 4).join(', ')}${o.lines.length > 4 ? '…' : ''}.`, 'We will email you again when it ships, with a tracking number.'],
    button: { text: 'View your order', url: `${base()}/#/orders/${o.id}` } }));
  for (const sellerId of new Set(o.lines.map((l) => l.seller_id))) {
    const lines = o.lines.filter((l) => l.seller_id === sellerId);
    fire(mailer.send({ to: sellerEmail(sellerId), key: `sale:${o.id}:${sellerId}`, kind: 'sale', subject: `New order ${ref(o)} — ${lines.reduce((a, l) => a + l.qty, 0)} item(s)`, title: 'You have a new order',
      lines: [...lines.map((l) => `${l.qty} × ${l.title}`), `Sale value: ${money(lines.reduce((a, l) => a + l.price * l.qty, 0), o.currency)}.`],
      button: { text: 'Open Seller Center', url: `${base()}/seller#/orders` } }));
  }
}

function orderShipped(o, tracking = []) {
  const t = tracking.filter((x) => x && x.number);
  fire(mailer.send({ to: emailOf(o.buyer_id), key: `shipped:${o.id}:${t.map((x) => x.number).join(',')}`, kind: 'order', subject: `Order ${ref(o)} is on its way`, title: 'Your order has shipped',
    lines: [...t.map((x) => `Tracking: ${x.carrier ? `${x.carrier} ` : ''}${x.number} — ${require('./services/couriers').trackingUrl(x.carrier, x.number)}`), 'You can follow every step in your Kinan orders.'],
    button: { text: 'Track your order', url: `${base()}/#/orders/${o.id}` } }));
}

function orderDelivered(o) {
  fire(mailer.send({ to: emailOf(o.buyer_id), key: `delivered:${o.id}`, kind: 'order', subject: `Order ${ref(o)} delivered`, title: 'Your order was delivered',
    lines: ['We hope you love it. If something is wrong, you can request a return from your order page.'], button: { text: 'View order', url: `${base()}/#/orders/${o.id}` } }));
}

function sellerApproved(s) {
  fire(mailer.send({ to: emailOf(s.user_id), key: `seller-approved:${s.id}`, kind: 'seller', subject: 'Your Kinan shop is approved', title: `Welcome, ${s.shop_name}!`,
    lines: ['Your shop is approved. You can now add products — Kinan reviews each product before customers see it.'], button: { text: 'Add your first product', url: `${base()}/seller#/add` } }));
}

function listingDecision(l, approved, reason) {
  fire(mailer.send({ to: sellerEmail(l.seller_id), key: `listing:${l.id}:${l.review?.submitted_at || l.updated_at}:${approved ? 'ok' : 'no'}`, kind: 'seller',
    subject: approved ? `Approved: ${l.title}` : `Changes needed: ${l.title}`, title: approved ? 'Your product is live' : 'Your product needs changes',
    lines: approved ? [`“${l.title}” is now visible to customers in Kinan Shop.`] : [`“${l.title}” was not approved.`, `Kinan’s note: ${reason}`],
    button: { text: approved ? 'See your products' : 'Edit product', url: `${base()}/seller#/products` } }));
}

function requestAnswered(r) {
  fire(mailer.send({ to: emailOf(r.buyer_id), key: `request:${r.id}:${r.status}:${r.quote}:${r.reply}`, kind: 'request', subject: 'Kinan replied to your item request', title: 'We have an answer about your item',
    lines: [r.quote ? `Price: ${money(r.quote, config.currency)} per item (shipping not included).` : '', r.reply ? `Kinan: ${r.reply}` : ''].filter(Boolean),
    button: { text: r.listing_id ? 'View the product' : 'See your request', url: r.listing_id ? `${base()}/#/p/${r.listing_id}` : `${base()}/#/request` } }));
}

function passwordReset(user, url) {
  return mailer.send({ to: user.email, kind: 'reset', subject: 'Reset your Kinan password', title: 'Reset your password',
    lines: ['Someone asked to reset the password for this Kinan account. If it was you, use the button below — the link works for 1 hour.', 'If it wasn’t you, ignore this email; your password stays the same.'],
    button: { text: 'Choose a new password', url } });
}

function priceAlert(l, skus, paused) {
  const opts = skus.map((s) => `${s.props || 'Standard'}: your price ${money(s.price, config.currency)}, now costs ${money(s.cost, config.currency)}`);
  fire(mailer.send({ to: sellerEmail(l.seller_id), key: `price:${l.id}:${skus.map((s) => s.cost).join(',')}`, kind: 'seller', subject: `Price check: ${l.title}`, title: paused ? 'We paused a product that would sell at a loss' : 'A product now costs more than its price',
    lines: [`The supplier price of “${l.title}” went up:`, ...opts, paused ? 'It is paused so nobody can buy it at a loss. Raise the price, then put it live again.' : 'Raise the price in Seller Center so you don’t lose money on new orders.'],
    button: { text: 'Update the price', url: `${base()}/seller#/products` } }));
}

function payoutUpdate(p) {
  fire(mailer.send({ to: sellerEmail(p.seller_id), key: `payout:${p.id}:${p.status}`, kind: 'payout', subject: `Withdrawal ${p.status === 'paid' ? 'sent' : 'update'} — ${money(p.amount, p.currency)}`,
    title: p.status === 'paid' ? 'Your withdrawal was sent' : 'Your withdrawal request was declined',
    lines: [p.status === 'paid' ? `${money(p.amount, p.currency)} was sent to your account${p.reference ? ` (reference ${p.reference})` : ''}.` : `Reason: ${p.note || '—'}. The amount is back in your available earnings.`],
    button: { text: 'Open earnings', url: `${base()}/seller#/earnings` } }));
}

function returnUpdate(r) {
  const o = db.orders.get(r.order_id);
  fire(mailer.send({ to: emailOf(r.buyer_id), key: `return:${r.id}:${r.status}`, kind: 'return', subject: `Return request for order ${o ? ref(o) : ''}: ${r.status}`,
    title: { approved: 'Your return was approved', refunded: 'Your refund was issued', rejected: 'Your return request was declined' }[r.status] || 'Return request update',
    lines: [r.admin_note ? `Kinan: ${r.admin_note}` : '', r.refund_amount ? `Refund: ${money(r.refund_amount, config.currency)} ${r.refund_to === 'wallet' ? 'to your Kinan wallet' : 'to your card'}.` : ''].filter(Boolean),
    button: { text: 'View order', url: `${base()}/#/orders/${r.order_id}` } }));
}

module.exports = { priceAlert, orderPaid, orderShipped, orderDelivered, sellerApproved, listingDecision, requestAnswered, passwordReset, payoutUpdate, returnUpdate };
