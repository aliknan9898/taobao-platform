// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Activity log: every action customers and sellers take in KINAN (sign-ins, account changes, cart, orders,
 * payments, returns, reviews, messages, products, payouts…), with date and time, who did it, what it was about,
 * and whether it worked. Shown in Admin → Activity log together with the staff audit trail (src/audit.js).
 *
 * Only actions are recorded (POST/PUT/PATCH/DELETE on the routes listed below), never page views or searches.
 * Request bodies are never stored: no passwords, card data, addresses or message text. Only the action, the record it
 * concerns (order / product id) and, for sign-in attempts, the e-mail typed. Kept ACTIVITY_KEEP_DAYS (180) days.
 */
const db = require('./db');

// "METHOD /route/pattern" → [category, label]. Routes not listed are not recorded.
const ACTIONS = {
  // account
  'POST /api/auth/register': ['account', 'Created an account'],
  'POST /api/auth/login': ['account', 'Signed in'],
  'POST /api/auth/logout': ['account', 'Signed out'],
  'POST /api/auth/apple': ['account', 'Signed in with Apple'],
  'POST /api/auth/google/native': ['account', 'Signed in with Google'],
  'POST /api/auth/phone/verify': ['account', 'Signed in with phone'],
  'POST /api/auth/forgot': ['account', 'Asked for a password reset'],
  'POST /api/auth/reset': ['account', 'Reset the password'],
  'POST /api/buyer/password': ['account', 'Changed the password'],
  'PATCH /api/buyer/profile': ['account', 'Updated the profile'],
  'PUT /api/buyer/addresses': ['account', 'Updated addresses'],
  'POST /api/buyer/account/delete': ['account', 'Deleted the account'],
  // shopping
  'PUT /api/buyer/cart': ['shopping', 'Updated the cart'],
  'POST /api/buyer/wishlist/:id': ['shopping', 'Added to wishlist'],
  'DELETE /api/buyer/wishlist/:id': ['shopping', 'Removed from wishlist'],
  'POST /api/buyer/coupon': ['shopping', 'Applied a discount code'],
  'POST /api/catalog/:id/questions': ['shopping', 'Asked a product question'],
  'POST /api/buyer/requests': ['shopping', 'Asked for an item'],
  'POST /api/buyer/requests/:id/accept': ['shopping', 'Accepted an item offer'],
  // orders
  'POST /api/buyer/checkout': ['orders', 'Placed an order'],
  'POST /api/ly/checkout': ['orders', 'Placed an order (Libya)'],
  'POST /api/buyer/orders/:id/cancel': ['orders', 'Cancelled an order'],
  'POST /api/buyer/orders/:id/qc': ['orders', 'Answered a quality check'],
  'POST /api/buyer/ship-stored': ['orders', 'Asked to ship stored items'],
  'POST /api/seller/orders/:id/pay': ['orders', 'Paid a supplier order'],
  'POST /api/seller/orders/:id/sync': ['orders', 'Refreshed an order'],
  'POST /api/seller/orders/:id/hide': ['orders', 'Removed a cancelled order from the list'],
  'POST /api/seller/orders/hide-cancelled': ['orders', 'Removed all cancelled orders from the list'],
  // payments
  'POST /api/buyer/orders/:id/card-payment': ['payments', 'Started a card payment'],
  'POST /api/buyer/orders/:id/confirm-card': ['payments', 'Confirmed a card payment'],
  'POST /api/buyer/orders/:id/pay-wallet': ['payments', 'Paid from the wallet'],
  'POST /api/buyer/orders/:id/apply-wallet': ['payments', 'Used wallet balance'],
  'POST /api/buyer/orders/:id/remove-wallet': ['payments', 'Removed wallet balance'],
  'POST /api/buyer/orders/:id/pay-shipping-due': ['payments', 'Paid shipping due'],
  'POST /api/buyer/orders/:id/demo-pay': ['payments', 'Paid (demo)'],
  'POST /api/buyer/cards/setup': ['payments', 'Saved a card'],
  'DELETE /api/buyer/cards/:id': ['payments', 'Removed a saved card'],
  'POST /api/buyer/giftcards': ['payments', 'Bought a gift card'],
  'POST /api/buyer/giftcards/:id/confirm': ['payments', 'Paid for a gift card'],
  'POST /api/buyer/giftcards/redeem': ['payments', 'Redeemed a gift card'],
  'POST /api/buyer/points/redeem': ['payments', 'Redeemed points'],
  // returns & reviews
  'POST /api/buyer/orders/:id/returns': ['returns', 'Asked for a return'],
  'POST /api/buyer/orders/:id/reviews': ['returns', 'Wrote a review'],
  // messages
  'POST /api/buyer/orders/:id/messages': ['messages', 'Sent a message about an order'],
  'POST /api/seller/orders/:id/messages': ['messages', 'Sent a message to the customer'],
  // seller products
  'POST /api/seller/products': ['products', 'Added a product'],
  'PATCH /api/seller/products/:id': ['products', 'Edited a product'],
  'PUT /api/seller/products/:id/manual': ['products', 'Edited a product'],
  'POST /api/seller/products/:id/resync': ['products', 'Refreshed a product from the supplier'],
  'POST /api/seller/products/aliexpress': ['products', 'Added a product from AliExpress'],
  'POST /api/seller/products/banggood': ['products', 'Added a product from Banggood'],
  'POST /api/seller/products/cj': ['products', 'Added a product from CJ'],
  'POST /api/seller/products/manual': ['products', 'Added a product by hand'],
  'POST /api/seller/products/bulk': ['products', 'Uploaded products in bulk'],
  'POST /api/seller/products/remove': ['products', 'Removed products'],
  'POST /api/seller/kinan-catalog/:id': ['products', 'Added a Kinan catalogue product'],
  // seller shop and money
  'PATCH /api/seller/me': ['shop', 'Updated the shop profile'],
  'POST /api/seller/terms': ['shop', 'Accepted the seller terms'],
  'POST /api/seller/verification': ['shop', 'Sent verification documents'],
  'POST /api/seller/stripe/onboard': ['shop', 'Started payout setup with Stripe'],
  'POST /api/seller/payout-methods': ['payments', 'Added a payout method'],
  'DELETE /api/seller/payout-methods/:id': ['payments', 'Removed a payout method'],
  'POST /api/seller/payout-methods/:id/confirm': ['payments', 'Confirmed a payout method'],
  'POST /api/seller/payout-methods/:id/default': ['payments', 'Changed the default payout method'],
  'POST /api/seller/payouts': ['payments', 'Asked for a withdrawal'],
  // selling channels
  'PUT /api/seller/ebay': ['channels', 'Changed eBay settings'],
  'POST /api/seller/ebay/connect': ['channels', 'Connected eBay'],
  'POST /api/seller/ebay/disconnect': ['channels', 'Disconnected eBay'],
  'POST /api/seller/ebay/list': ['channels', 'Listed products on eBay'],
  'POST /api/seller/ebay/end/:id': ['channels', 'Ended an eBay listing'],
  'POST /api/seller/ebay/orders/:id/pay': ['channels', 'Paid an eBay order']
};
const CATEGORIES = ['account', 'shopping', 'orders', 'payments', 'returns', 'messages', 'products', 'shop', 'channels', 'staff'];
const AUTH_EMAIL = /^POST \/api\/auth\/(login|register|forgot)$/; // a sign-in attempt names the account it was for

const wants = (method, pattern) => Boolean(ACTIONS[`${method} ${pattern}`]);

/** Record one action. `user` is who was signed in (or who signed in / signed up); never throws. */
function record({ req, method, pattern, path, user, status, params, out, error }) {
  const key = `${method} ${pattern}`; const a = ACTIONS[key];
  if (!a) return null;
  const actorUser = user || out?.user || null;
  if (actorUser && !['buyer', 'seller'].includes(actorUser.role)) return null; // staff actions are in the audit trail
  const body = req._json && typeof req._json === 'object' && !Array.isArray(req._json) ? req._json : null;
  const typed = AUTH_EMAIL.test(key) && typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 120) : null;
  if (!actorUser && !typed) return null; // nothing to tie it to
  const ref = params?.id || out?.id || out?.order?.id || null;
  return db.activity.insert({
    at: Date.now(), category: a[0], action: a[1], method, path, status, ok: status < 400,
    actor: actorUser ? { id: actorUser.id, email: actorUser.email || null, role: actorUser.role, name: actorUser.name || null } : { id: null, email: typed, role: 'guest' },
    ...(ref ? { ref: String(ref).slice(0, 80) } : {}),
    ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64),
    ...(error ? { error: String(error).slice(0, 200) } : {})
  });
}

/**
 * The log, newest first: customer and seller actions plus the staff audit trail.
 * Filters: who (buyer|seller|staff), category, q (e-mail, name, order/product id, action text), days, failed, before (cursor).
 */
function list({ who = '', category = '', q = '', days = 0, failed = false, before = 0, limit = 200, staff: withStaff = false } = {}) {
  const since = Number(days) > 0 ? Date.now() - Number(days) * 86400e3 : 0;
  const until = Number(before) > 0 ? Number(before) : Infinity;
  const needle = String(q || '').trim().toLowerCase();
  const staff = !withStaff ? [] : db.audit.peek().map((x) => ({ id: x.id, at: x.at, category: 'staff', action: `${x.method} ${x.path}`, method: x.method, path: x.path, status: x.status, ok: (x.status || 200) < 400, actor: x.actor || { role: 'staff' }, ref: x.params?.id || null, ip: x.ip, error: x.error, reason: x.reason }));
  const rows = [...db.activity.peek(), ...staff].filter((x) => {
    if (x.at < since || x.at >= until) return false;
    const role = x.category === 'staff' ? 'staff' : x.actor?.role === 'seller' ? 'seller' : 'buyer';
    if (who && who !== role) return false;
    if (category && x.category !== category) return false;
    if (failed && x.ok) return false;
    if (needle && ![x.actor?.email, x.actor?.name, x.ref, x.action, x.actor?.id].some((v) => String(v || '').toLowerCase().includes(needle))) return false;
    return true;
  }).sort((a, b) => b.at - a.at);
  const n = Math.min(500, Math.max(1, Number(limit) || 200));
  const counts = {}; for (const x of rows) counts[x.category] = (counts[x.category] || 0) + 1;
  return { total: rows.length, counts, items: rows.slice(0, n), more: rows.length > n ? rows[n - 1].at : null };
}

function prune(now = Date.now()) {
  const keep = (Number(process.env.ACTIVITY_KEEP_DAYS) > 0 ? Number(process.env.ACTIVITY_KEEP_DAYS) : 180) * 86400e3;
  let n = 0; for (const a of db.activity.all((x) => now - x.at > keep)) { db.activity.remove(a.id); n++; }
  return n;
}

module.exports = { ACTIONS, CATEGORIES, wants, record, list, prune };
