// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Growth: discount codes, referrals, saved items (with price-drop / back-in-stock emails),
 * reviews from customers who received the item, and reminders for carts left behind.
 * Discounts are paid by Kinan: sellers are always paid their full item price.
 */
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');
const mailer = require('../mailer');

const money = (n) => Math.round(Number(n) * 100) / 100;
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const DAY = 86400e3;
const base = () => config.publicBaseUrl;
const fire = (p) => { Promise.resolve(p).catch(() => {}); };
const fmt = (n) => { try { return Number(n).toLocaleString('en-US', { style: 'currency', currency: config.currency.toUpperCase() }); } catch { return `${n}`; } };

// ---------------- Discount codes ----------------
const normCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);

function saveCoupon(b, existingId = null) {
  const code = normCode(b.code);
  if (code.length < 3) throw httpError(400, 'The code needs at least 3 letters or numbers');
  const kind = b.kind === 'fixed' ? 'fixed' : 'percent';
  const value = money(b.value);
  if (!(value > 0) || (kind === 'percent' && value > 90)) throw httpError(400, kind === 'percent' ? 'Percent must be between 1 and 90' : 'Enter the discount amount');
  const doc = {
    code, kind, value, min_subtotal: money(b.min_subtotal || 0), max_discount: b.max_discount ? money(b.max_discount) : null,
    max_uses: b.max_uses ? Math.max(1, Math.floor(b.max_uses)) : null, first_order_only: Boolean(b.first_order_only),
    expires_at: b.expires_at ? new Date(b.expires_at).getTime() || null : null, active: b.active !== false, note: str(b.note, 120)
  };
  const clash = db.coupons.find((c) => c.code === code && c.id !== existingId);
  if (clash) throw httpError(409, 'That code already exists');
  return existingId ? db.coupons.update(existingId, doc) : db.coupons.insert({ ...doc, uses: 0, used_by: [] });
}

/** Works out the discount for a code, or throws a message the customer understands. */
function couponFor(code, buyer, subtotal) {
  const c = db.coupons.find((x) => x.code === normCode(code));
  if (!c || !c.active) throw httpError(400, 'This code is not valid');
  if (c.owner_id && c.owner_id !== buyer.id) throw httpError(400, 'This code is not valid'); // a personal code (Kinan points)
  if (c.expires_at && Date.now() > c.expires_at) throw httpError(400, 'This code has expired');
  if (c.max_uses && c.uses >= c.max_uses) throw httpError(400, 'This code has been fully used');
  if ((c.used_by || []).includes(buyer.id)) throw httpError(400, 'You already used this code');
  if (c.first_order_only && db.orders.find((o) => o.buyer_id === buyer.id && o.paid_at && !['cancelled', 'refunded'].includes(o.status))) throw httpError(400, 'This code is for your first order');
  if (subtotal < c.min_subtotal) throw httpError(400, `Spend at least ${fmt(c.min_subtotal)} to use this code`);
  let d = c.kind === 'percent' ? subtotal * c.value / 100 : c.value;
  if (c.max_discount) d = Math.min(d, c.max_discount);
  return { code: c.code, discount: money(Math.min(d, subtotal)), coupon_id: c.id, label: c.kind === 'percent' ? `${c.value}% off` : `${fmt(c.value)} off` };
}

/** Called when an order is paid: the code counts as used. */
function redeem(order) {
  if (!order.coupon_id) return;
  db.coupons.update(order.coupon_id, (c) => ({ ...c, uses: (c.uses || 0) + 1, used_by: [...new Set([...(c.used_by || []), order.buyer_id])] }));
}

/** A first-order welcome code, created once so new customers always have one to use. */
function ensureWelcome() {
  if (db.coupons.find((c) => c.code === 'WELCOME10')) return;
  db.coupons.insert({ code: 'WELCOME10', kind: 'percent', value: 10, min_subtotal: 0, max_discount: 10, max_uses: null, first_order_only: true, expires_at: null, active: true, note: 'Welcome discount (created automatically)', uses: 0, used_by: [] });
}

// ---------------- Referrals ----------------
const REF_REWARD = Number(process.env.REFERRAL_REWARD ?? 5);

function refCode(user) {
  if (user.ref_code) return user.ref_code;
  let code;
  do { code = crypto.randomBytes(4).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase(); } while (code.length < 5 || db.users.find((u) => u.ref_code === code));
  db.users.update(user.id, { ref_code: code });
  return code;
}

/** New account: remember who invited them (from the ?ref= link, kept in a cookie). */
function attachReferrer(newUser, code) {
  const c = normCode(code);
  if (!c || newUser.referred_by) return;
  const ref = db.users.find((u) => u.ref_code === c && u.id !== newUser.id);
  if (ref) db.users.update(newUser.id, { referred_by: ref.id });
}

/** When an invited customer's first order is delivered, the person who invited them gets wallet credit. */
function payReferrals() {
  const shop = require('./shop'); let n = 0;
  for (const u of db.users.all((x) => x.referred_by && !x.ref_rewarded)) {
    const delivered = db.orders.find((o) => o.buyer_id === u.id && o.status === 'delivered');
    if (!delivered) continue;
    const ref = db.users.get(u.referred_by);
    db.users.update(u.id, { ref_rewarded: Date.now() });
    if (!ref || !(REF_REWARD > 0)) continue;
    shop.walletEntry(ref.id, REF_REWARD, `Thank you for inviting a friend (${(u.name || u.email || '').split('@')[0]})`, { kind: 'adjustment', referral_of: u.id });
    fire(mailer.send({ to: ref.email, key: `ref:${u.id}`, kind: 'growth', subject: `You earned ${fmt(REF_REWARD)} on Kinan`, title: 'Your friend received their first order',
      lines: [`We added ${fmt(REF_REWARD)} to your Kinan wallet. Use it on your next order.`], button: { text: 'Open your wallet', url: `${base()}/#/wallet` } }));
    n++;
  }
  return n;
}

function referralInfo(user) {
  const code = refCode(user);
  const invited = db.users.all((u) => u.referred_by === user.id);
  return { code, link: `${base()}/?ref=${code}`, reward: REF_REWARD, currency: config.currency, invited: invited.length, rewarded: invited.filter((u) => u.ref_rewarded).length, earned: money(invited.filter((u) => u.ref_rewarded).length * REF_REWARD) };
}

// ---------------- Saved items ----------------
const priceOf = (l) => Math.min(...l.skus.map((s) => s.price));
const inStock = (l) => l.status === 'active' && l.skus.some((s) => s.stock > 0);

function wishlist(user) {
  const catalog = require('./catalog');
  return db.wishlist.all((w) => w.user_id === user.id).sort((a, b) => b.created_at - a.created_at).map((w) => {
    const l = db.listings.get(w.listing_id); const s = l && db.sellers.get(l.seller_id);
    if (!l || !s || !['active', 'paused', 'unavailable'].includes(l.status)) return null;
    return { listing_id: l.id, title: l.title, title_ar: l.title_ar || '', image: [...(l.own_images || []).map((u, i) => catalog.photoUrl(l, i, u)), ...(l.images || [])][0] || null, price: priceOf(l), price_when_saved: w.price_at_add, in_stock: inStock(l), currency: l.currency, saved_at: w.created_at };
  }).filter(Boolean);
}

function save(user, listingId) {
  const l = db.listings.get(listingId);
  if (!l || l.status !== 'active') throw httpError(404, 'Product not available');
  const ex = db.wishlist.find((w) => w.user_id === user.id && w.listing_id === l.id);
  if (ex) return { saved: true };
  if (db.wishlist.all((w) => w.user_id === user.id).length >= 200) throw httpError(400, 'You can save up to 200 items');
  db.wishlist.insert({ user_id: user.id, listing_id: l.id, price_at_add: priceOf(l), last_price: priceOf(l), last_in_stock: inStock(l) });
  return { saved: true };
}
function unsave(user, listingId) { for (const w of db.wishlist.all((x) => x.user_id === user.id && x.listing_id === listingId)) db.wishlist.remove(w.id); return { saved: false }; }
function isSaved(user, listingId) { return Boolean(user && db.wishlist.find((w) => w.user_id === user.id && w.listing_id === listingId)); }

/** Email when a saved item gets cheaper (3%+) or comes back in stock. */
function wishlistAlerts() {
  let n = 0;
  for (const w of db.wishlist.all()) {
    const l = db.listings.get(w.listing_id); const u = db.users.get(w.user_id);
    if (!l || !u) continue;
    const p = priceOf(l); const st = inStock(l);
    let why = null;
    if (st && w.last_in_stock === false) why = 'back';
    else if (st && p <= w.last_price * 0.97) why = 'drop';
    if (why) {
      fire(mailer.send({ to: u.email, key: `wish:${w.id}:${why}:${p}`, kind: 'growth', subject: why === 'back' ? `Back in stock: ${l.title.slice(0, 60)}` : `Price drop: ${l.title.slice(0, 60)}`,
        title: why === 'back' ? 'An item you saved is back in stock' : 'An item you saved is now cheaper',
        lines: [l.title, why === 'drop' ? `Now ${fmt(p)} (was ${fmt(w.last_price)}).` : `Price: ${fmt(p)}.`], button: { text: 'View the item', url: `${base()}/p/${l.id}` } }));
      n++;
    }
    if (p !== w.last_price || st !== w.last_in_stock) db.wishlist.update(w.id, { last_price: p, last_in_stock: st });
  }
  return n;
}

// ---------------- Reviews ----------------
const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

function addReview(user, orderId, b) {
  const o = db.orders.get(orderId);
  if (!o || o.buyer_id !== user.id) throw httpError(404, 'Order not found');
  if (o.status !== 'delivered') throw httpError(409, 'You can review items after they are delivered');
  const line = o.lines.find((l) => l.listing_id === String(b.listing_id));
  if (!line) throw httpError(400, 'That item is not in this order');
  if (db.reviews.find((r) => r.order_id === o.id && r.listing_id === line.listing_id)) throw httpError(409, 'You already reviewed this item');
  const rating = Math.floor(Number(b.rating));
  if (!(rating >= 1 && rating <= 5)) throw httpError(400, 'Choose 1 to 5 stars');
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 3).map(String);
  for (const p of photos) { if (!IMG.test(p)) throw httpError(400, 'Photos must be JPEG, PNG or WebP'); if (p.length > 400 * 1024) throw httpError(400, 'A photo is too large'); }
  resetRatings();
  const r = db.reviews.insert({ listing_id: line.listing_id, seller_id: line.seller_id, order_id: o.id, user_id: user.id, name: (user.name || user.email.split('@')[0]).split(' ')[0].slice(0, 30), rating, text: str(b.text, 1500), photos, status: 'published' });
  let points = 0; try { points = require('./points').forReview(r); } catch { /* points are a bonus */ }
  return { ...r, points };
}

function publicReview(r) { return { id: r.id, name: r.name, rating: r.rating, text: r.text, photos: (r.photos || []).map((_, i) => `/img/r/${r.id}/${i}`), at: r.created_at, verified: true }; }
function reviewsFor(listingId) {
  const list = db.reviews.all((r) => r.listing_id === listingId && r.status === 'published').sort((a, b) => b.created_at - a.created_at);
  return { average: list.length ? Math.round((list.reduce((a, r) => a + r.rating, 0) / list.length) * 10) / 10 : null, count: list.length, reviews: list.slice(0, 50).map(publicReview) };
}
let rcache = null; let rcacheAt = 0;
/** Average stars for one product (cached for a minute; reset when a review is added or hidden). */
function ratingFor(listingId) {
  if (!rcache || Date.now() - rcacheAt > 60e3) { rcache = ratingMap(); rcacheAt = Date.now(); }
  const a = rcache.get(listingId);
  return a ? { rating: Math.round((a.s / a.n) * 10) / 10, reviews: a.n } : { rating: null, reviews: 0 };
}
function resetRatings() { rcache = null; }
/** Rating summary per product, for product cards (one pass over all reviews). */
function ratingMap() {
  const m = new Map();
  for (const r of db.reviews.all((x) => x.status === 'published')) { const a = m.get(r.listing_id) || { s: 0, n: 0 }; a.s += r.rating; a.n++; m.set(r.listing_id, a); }
  return m;
}
function reviewPhoto(id, n) {
  const r = db.reviews.get(id);
  if (!r || r.status !== 'published') return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec((r.photos || [])[Number(n) || 0] || '');
  return m ? { type: m[1], body: Buffer.from(m[2], 'base64') } : null;
}

// ---------------- Carts left behind ----------------
function saveCart(user, items) {
  const clean = (Array.isArray(items) ? items : []).slice(0, 100).map((x) => ({ listing_id: str(x.listing_id, 40), mp_sku_id: str(x.mp_sku_id, 60), qty: Math.max(1, Math.min(999, Math.floor(Number(x.qty) || 1))), title: str(x.title, 120) })).filter((x) => x.listing_id);
  const id = `crt_${user.id}`;
  const ex = db.carts.get(id);
  const doc = { user_id: user.id, items: clean, changed_at: Date.now(), reminded_at: null, reminded_step: 0 };
  if (ex) db.carts.update(id, doc); else db.carts.insert({ id, ...doc });
  return { saved: clean.length };
}

/**
 * Abandoned cart, in two steps (if no order was placed since the cart last changed):
 *  1. after 1 hour: email + phone notification "you left something"
 *  2. after 24 hours: email + notification with a personal 5% code for 72 hours (CART_COUPON_PCT, 0 = no code)
 */
const HOUR = 3600e3;
function cartReminders(now = Date.now()) {
  const push = require('../push');
  const pct = Math.max(0, Math.min(30, Number(process.env.CART_COUPON_PCT ?? 5)));
  let n = 0;
  for (const c of db.carts.all((x) => x.items.length && now - x.changed_at > HOUR && now - x.changed_at < 7 * DAY && (x.reminded_step || 0) < 2 && !x.reminded_at)) {
    const u = db.users.get(c.user_id);
    if (!u || db.orders.find((o) => o.buyer_id === u.id && o.created_at > c.changed_at)) { db.carts.update(c.id, { reminded_step: 2 }); continue; }
    const step = (c.reminded_step || 0) + 1;
    if (step === 2 && now - c.changed_at < DAY) continue; // second reminder waits a day
    const names = c.items.map((x) => x.title).filter(Boolean).slice(0, 3).join(', ');
    let code = null;
    if (step === 2 && pct > 0) {
      do { code = `CART-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; } while (db.coupons.find((x) => x.code === code));
      db.coupons.insert({ code, kind: 'percent', value: pct, min_subtotal: 0, max_discount: 30, max_uses: 1, first_order_only: false, expires_at: now + 3 * DAY, active: true, owner_id: u.id, note: `Cart reminder for ${(u.email || '').split('@')[0]}`, uses: 0, used_by: [] });
    }
    fire(mailer.send({
      to: u.email, key: `cart:${c.id}:${c.changed_at}:${step}`, kind: 'growth',
      subject: step === 1 ? 'You left something in your Kinan cart' : code ? `${pct}% off your cart — 72 hours only` : 'Your Kinan cart is waiting',
      title: step === 1 ? 'Still thinking about it?' : code ? `Here is ${pct}% off to finish your order` : 'Your cart is waiting',
      lines: [`${c.items.length} item(s) are waiting in your cart: ${names}.`, ...(code ? [`Use code ${code} at checkout — ${pct}% off, valid for 72 hours.`] : ['Prices and stock can change, so complete your order soon.'])],
      button: { text: 'Go to your cart', url: `${base()}/#/cart` }
    }));
    try {
      push.toUser(u.id, step === 1
        ? { title: 'Still in your cart 🛒', body: names || 'Your items are waiting', url: '/#/cart', tag: `cart-${c.id}`, ar: { title: 'ما زالت في سلتك 🛒', body: names || 'منتجاتك بانتظارك' } }
        : { title: code ? `${pct}% off your cart 🎁` : 'Your cart is waiting', body: code ? `Code ${code} — 72 hours` : names, url: '/#/cart', tag: `cart-${c.id}`, ar: { title: code ? `خصم ${pct}% على سلتك 🎁` : 'سلتك بانتظارك', body: code ? `الكود ${code} — لمدة 72 ساعة` : names } });
    } catch { /* push is optional */ }
    db.carts.update(c.id, { reminded_step: step, reminded_last: now, ...(code ? { reminder_code: code } : {}) });
    n++;
  }
  return n;
}

module.exports = {
  saveCoupon, couponFor, redeem, ensureWelcome, normCode,
  refCode, attachReferrer, payReferrals, referralInfo, REF_REWARD,
  wishlist, save, unsave, isSaved, wishlistAlerts,
  addReview, reviewsFor, ratingMap, ratingFor, resetRatings, reviewPhoto, publicReview,
  saveCart, cartReminders
};
