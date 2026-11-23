// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Customer account self-service for Kinan Shop (web and apps): profile, password, and account deletion.
 *
 * Deletion (App Store guideline 5.1.1(v), GDPR erasure): personal data is removed or anonymised and the account can
 * never sign in again. Orders, invoices, payments and the money ledger are KEPT, because accounting and tax law
 * require them; they stay linked to the anonymised account id only.
 */
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const { httpError } = auth;

const LANGS = ['en', 'ar', 'fr', 'de', 'it', 'es'];
const OPEN = ['paid', 'procuring', 'awaiting_parcels', 'ready_to_ship', 'shipped', 'attention'];
const RECENT_SIGN_IN = 15 * 60e3;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function buyerRecord(user) {
  const u = db.users.get(user.id);
  if (!u || u.role !== 'buyer') throw httpError(403, 'Only Kinan Shop customer accounts can do this');
  return u;
}

/** Name and app language. Email changes are not offered here (they need a confirmation link). */
function updateProfile(user, b = {}) {
  const u = buyerRecord(user);
  const patch = {};
  if (b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw httpError(400, 'Enter your name');
    patch.name = name;
  }
  if (b.lang !== undefined) {
    if (!LANGS.includes(b.lang)) throw httpError(400, `Language must be one of ${LANGS.join(', ')}`);
    patch.lang = b.lang;
  }
  if (b.delivery_country !== undefined) {
    // the delivery country the customer confirmed in the shop (kept with their other preferences)
    const cc = String(b.delivery_country || '').toUpperCase();
    if (!require('../countries').isMarket(cc)) throw httpError(400, 'Choose one of Kinan\'s delivery countries');
    patch.delivery_country = cc;
  }
  if (!Object.keys(patch).length) throw httpError(400, 'Nothing to change');
  return auth.publicUser(db.users.update(u.id, patch));
}

/** Change the password; every other session of the account is signed out, this one stays. */
function changePassword(user, b = {}, currentToken) {
  const u = buyerRecord(user);
  if (auth.ownerEmail(u.email)) throw httpError(409, 'This account signs in with Google');
  if (!u.pass) throw httpError(409, 'This account has no password yet — use “Forgot password” to set one');
  if (!checkPassword(String(b.current || ''), u.pass)) throw httpError(401, 'Your current password is not correct');
  const next = String(b.password || '');
  if (next.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  db.users.update(u.id, { pass: auth.hashPassword(next) });
  const keep = currentToken ? sha(currentToken) : null;
  for (const s of db.sessions.all((x) => x.user_id === u.id && x.token_hash !== keep)) db.sessions.remove(s.id);
  return { ok: true };
}

function checkPassword(pw, stored) {
  const [, s, k] = String(stored).split('$');
  if (!s || !k) return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(k, 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

/**
 * What stops a deletion right now, if anything: orders on their way, open returns, money in the wallet.
 * The app shows this before asking for confirmation.
 */
function deletionCheck(user) {
  const u = buyerRecord(user);
  const open = db.orders.all((o) => o.buyer_id === u.id && OPEN.includes(o.status)).map((o) => o.id);
  const returns = db.returns.all((r) => r.buyer_id === u.id && ['requested', 'approved'].includes(r.status)).length;
  const balance = require('./shop').walletOf(u.id).balance;
  return { open_orders: open, open_returns: returns, wallet_balance: balance, needs_password: Boolean(u.pass), can_delete: !open.length && !returns };
}

/**
 * Delete the customer's account.
 * Body: { password } for accounts with a password (otherwise the session must be less than 15 minutes old: sign in again
 * first), confirm: "DELETE", and forfeit_wallet: true when the wallet still has money.
 */
async function deleteAccount(user, b = {}, currentToken) {
  const u = buyerRecord(user);
  if (auth.isOwner(u)) throw httpError(403, 'The owner account cannot be deleted from the app');
  if (b.confirm !== 'DELETE') throw httpError(400, 'Send confirm: "DELETE" to delete the account');
  if (u.pass) {
    if (!checkPassword(String(b.password || ''), u.pass)) throw Object.assign(httpError(401, 'Your password is not correct'), { code: 'bad_password' });
  } else {
    const s = currentToken && db.sessions.find((x) => x.token_hash === sha(currentToken));
    if (!s || Date.now() - (s.created_at || 0) > RECENT_SIGN_IN) throw Object.assign(httpError(401, 'Please sign in again, then delete the account'), { code: 'reauth' });
  }
  const chk = deletionCheck(u);
  if (chk.open_orders.length) throw Object.assign(httpError(409, `You have ${chk.open_orders.length} order(s) on the way. You can delete the account once they are delivered or cancelled.`), { code: 'open_orders' });
  if (chk.open_returns) throw Object.assign(httpError(409, 'You have an open return. You can delete the account once it is finished.'), { code: 'open_returns' });
  if (chk.wallet_balance > 0 && b.forfeit_wallet !== true) throw Object.assign(httpError(409, `Your wallet still has ${chk.wallet_balance} ${require('../config').config.currency.toUpperCase()}. Use it first, or confirm that you give it up.`), { code: 'wallet_balance' });

  // Unpaid orders are cancelled (their PaymentIntents too)
  const orders = require('./orders');
  for (const o of db.orders.all((x) => x.buyer_id === u.id && x.status === 'pending_payment')) {
    try { await orders.cancelOrder(o.id, u.id); } catch (e) { console.warn('[account] cancel', o.id, e.message); }
  }
  // Sign in with Apple: revoke the app's authorisation at Apple (best effort; Apple asks apps to do this on deletion)
  try { await require('../nativeAuth').appleRevoke(u); } catch (e) { console.warn('[account] apple revoke', e.message); }
  // Saved cards: the Stripe customer is deleted (best effort; Stripe keeps its own payment records)
  try { await require('../payments/stripe').deleteCustomer(u); } catch (e) { console.warn('[account] stripe customer', e.message); }

  for (const x of db.sessions.all((s) => s.user_id === u.id)) db.sessions.remove(x.id);
  for (const x of db.tokens.all((t) => t.user_id === u.id)) db.tokens.remove(x.id);
  for (const x of db.push_subs.all((s) => s.user_id === u.id)) db.push_subs.remove(x.id);
  for (const x of db.devices.all((s) => s.user_id === u.id)) db.devices.remove(x.id);
  for (const x of db.wishlist.all((w) => w.user_id === u.id)) db.wishlist.remove(x.id);
  if (db.carts.get(`crt_${u.id}`)) db.carts.remove(`crt_${u.id}`);
  for (const r of db.reviews.all((x) => x.user_id === u.id)) db.reviews.update(r.id, { name: 'Kinan customer' });

  db.users.update(u.id, (x) => ({
    id: x.id, role: x.role, created_at: x.created_at, status: 'deleted', deleted_at: Date.now(),
    email: `deleted+${x.id}@deleted.invalid`, name: '', lang: null
  }));
  console.log(`[account] customer ${u.id} deleted their account`);
  return { deleted: true };
}

/**
 * Retention for deleted accounts: once an order of a deleted account is older than ORDER_PII_RETENTION_DAYS (counted from
 * the day it was placed), the name, phone and street address on it are removed; the country stays for the accounts.
 * Off until the variable is set (the owner decides the period with the accountant). Runs daily.
 */
function redactDeletedOrders(now = Date.now()) {
  const days = Number(process.env.ORDER_PII_RETENTION_DAYS || 0);
  if (!(days > 0)) return 0;
  const gone = new Set(db.users.all((u) => u.status === 'deleted').map((u) => u.id));
  if (!gone.size) return 0;
  let n = 0;
  for (const o of db.orders.all((x) => gone.has(x.buyer_id) && !x.pii_redacted_at && now - (x.created_at || 0) > days * 86400e3)) {
    const a = o.shipping_address || {};
    db.orders.update(o.id, { shipping_address: { country_code: a.country_code || null, country: a.country || null, redacted: true }, pii_redacted_at: now });
    n++;
  }
  if (n) console.log(`[account] personal details removed from ${n} old order(s) of deleted accounts`);
  return n;
}

module.exports = { LANGS, updateProfile, changePassword, deletionCheck, deleteAccount, redactDeletedOrders };
