// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Kinan Shop extras: public store profiles, the buyer wallet, and custom item requests.
 * Linked to the Seller Center (profile fields) and the Admin dashboard (wallet adjustments, requests).
 */
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');

const money = (n) => Math.round(Number(n) * 100) / 100;
const str = (v, max) => String(v ?? '').trim().slice(0, max);

// ---------------- Store profiles ----------------

const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO = 300 * 1024; // characters of the data URL

/** Validate the profile fields a seller may edit. Returns a patch. */
function profilePatch(b) {
  const patch = {};
  if (b.description !== undefined) patch.description = str(b.description, 600);
  if (b.return_policy !== undefined) patch.return_policy = str(b.return_policy, 1500);
  if (b.logo !== undefined) {
    if (b.logo === null || b.logo === '') patch.logo = null;
    else {
      const l = String(b.logo);
      if (!LOGO_RE.test(l)) throw httpError(400, 'Logo must be a PNG, JPEG or WebP image');
      if (l.length > MAX_LOGO) throw httpError(400, 'Logo is too large — use an image under 200 KB');
      patch.logo = l;
    }
  }
  return patch;
}

const DEFAULT_RETURNS = 'Returns are accepted only for items that arrive damaged or different from the listing. Contact Kinan support within 7 days of delivery with photos.';

function publicShop(s, { full = false } = {}) {
  const products = db.listings.all((l) => l.seller_id === s.id && l.status === 'active').length;
  return {
    id: s.id, name: s.shop_name, logo: s.logo || null, description: s.description || '', products,
    since: s.created_at, ...(full ? { return_policy: s.return_policy || DEFAULT_RETURNS } : {})
  };
}

function listShops() {
  return db.sellers.all((s) => s.status === 'active').map((s) => publicShop(s)).filter((s) => s.products > 0)
    .sort((a, b) => b.products - a.products);
}

function getShop(id) {
  const s = db.sellers.get(id);
  if (!s || s.status !== 'active') throw httpError(404, 'Shop not found');
  return publicShop(s, { full: true });
}

// ---------------- Wallet ----------------
// Ledger of signed amounts per buyer: credits (refunds, shipping overpay) and debits (payments, shipping underpay).

function walletOf(userId) {
  const entries = db.wallet.all((w) => w.user_id === userId).sort((a, b) => b.created_at - a.created_at);
  return { currency: config.currency, balance: money(entries.reduce((a, w) => a + w.amount, 0)), entries: entries.slice(0, 100) };
}

function walletEntry(userId, amount, reason, extra = {}) {
  const a = money(amount);
  if (!a) throw httpError(400, 'Amount must not be zero');
  return db.wallet.insert({ user_id: userId, amount: a, currency: config.currency, reason: str(reason, 200) || (a > 0 ? 'Credit' : 'Debit'), ...extra });
}

/** Admin adjustment, e.g. shipping difference after weighing. Debits may not push the balance below zero. */
function adminAdjust(userId, { amount, reason }, admin) {
  const u = db.users.get(userId);
  if (!u || u.role !== 'buyer') throw httpError(404, 'Customer not found');
  const a = money(amount);
  if (!a || Math.abs(a) > 100000) throw httpError(400, 'Enter an amount (use a minus sign to deduct)');
  if (!str(reason, 200)) throw httpError(400, 'Enter a reason — the customer sees it');
  if (a < 0 && walletOf(userId).balance + a < 0) throw httpError(409, 'Balance is too low for this deduction');
  walletEntry(userId, a, reason, { by: admin.id, kind: 'adjustment' });
  return walletOf(userId);
}

// ---------------- Custom item requests ----------------

const REQ_STATUS = ['new', 'quoted', 'listed', 'declined'];

function createRequest(buyer, b) {
  const link = str(b.link, 500);
  const note = str(b.note, 1000);
  if (!link && !note) throw httpError(400, 'Paste a Taobao link or describe the item');
  if (link && !/^(https?:\/\/)?([\w-]+\.)*(taobao|tmall|tb)\.(com|cn)\b|^\d{6,15}$/i.test(link)) throw httpError(400, 'That does not look like a Taobao or Tmall link');
  const qty = Math.floor(Number(b.qty) || 1);
  if (!(qty >= 1 && qty <= 999)) throw httpError(400, 'Invalid quantity');
  const open = db.requests.all((r) => r.buyer_id === buyer.id && r.status === 'new').length;
  if (open >= 10) throw httpError(429, 'You have 10 open requests — please wait for answers first');
  return db.requests.insert({ buyer_id: buyer.id, link, note, qty, status: 'new', reply: '', quote: null, listing_id: null });
}

const buyerRequestView = ({ id, link, note, qty, status, reply, quote, listing_id, created_at, updated_at }) => ({ id, link, note, qty, status, reply, quote, listing_id, created_at, updated_at, currency: config.currency });

function adminRequests() {
  return db.requests.all().sort((a, b) => b.created_at - a.created_at).map((r) => ({ ...r, buyer: db.users.get(r.buyer_id)?.email || '—' }));
}

function answerRequest(id, b) {
  const r = db.requests.get(id);
  if (!r) throw httpError(404, 'Request not found');
  const patch = {};
  if (b.status !== undefined) { if (!REQ_STATUS.includes(b.status)) throw httpError(400, 'Invalid status'); patch.status = b.status; }
  if (b.reply !== undefined) patch.reply = str(b.reply, 1000);
  if (b.quote !== undefined) { const q = b.quote === null || b.quote === '' ? null : money(b.quote); if (q !== null && !(q > 0)) throw httpError(400, 'Invalid price'); patch.quote = q; }
  if (b.listing_id !== undefined) {
    if (b.listing_id) { const l = db.listings.get(String(b.listing_id)); if (!l || l.status !== 'active') throw httpError(400, 'That product is not live in the shop'); patch.listing_id = l.id; }
    else patch.listing_id = null;
  }
  return db.requests.update(id, patch);
}

module.exports = { profilePatch, publicShop, listShops, getShop, walletOf, walletEntry, adminAdjust, createRequest, buyerRequestView, adminRequests, answerRequest, DEFAULT_RETURNS };
