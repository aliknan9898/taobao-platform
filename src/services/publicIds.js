// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Public variant ids. Inside Kinan a variant id can name its supplier (cj_…, AE…, bg_…); customers must never see
 * which supplier a product comes from. Buyer-facing views show `v_<hash>` instead, and every route that takes a
 * variant id from a customer turns it back into the real one. Old ids (carts saved before this change, other
 * internal callers) are still accepted.
 */
const crypto = require('crypto');
const db = require('../db');

const KEY_ID = 'set_pubid';
let key = null;
function secret() {
  if (key) return key;
  const s = db.settings.get(KEY_ID);
  if (s && s.key) key = s.key;
  else { key = crypto.randomBytes(32).toString('hex'); db.settings.insert({ id: KEY_ID, key }); }
  return key;
}

/** The id customers see for variant `skuId` of listing `listingId`. Stable for the life of the key. */
function skuPub(listingId, skuId) {
  if (skuId === undefined || skuId === null || skuId === '') return skuId;
  return `v_${crypto.createHmac('sha256', secret()).update(`${listingId}|${skuId}`).digest('base64url').slice(0, 16)}`;
}

/** The real variant id of listing `l` for an id a customer sent (public or old); unknown ids are returned unchanged. */
function skuIn(l, id) {
  const v = String(id ?? '');
  if (!l || !Array.isArray(l.skus)) return v;
  if (l.skus.some((s) => s.mp_sku_id === v)) return v;
  if (!v.startsWith('v_')) return v;
  const hit = l.skus.find((s) => skuPub(l.id, s.mp_sku_id) === v);
  return hit ? hit.mp_sku_id : v;
}

/** Cart-shaped items ({ listing_id, mp_sku_id, … }) with real variant ids. */
function itemsIn(items) {
  return (Array.isArray(items) ? items : []).map((it) => {
    if (!it || typeof it !== 'object' || it.mp_sku_id === undefined) return it;
    return { ...it, mp_sku_id: skuIn(db.listings.get(it.listing_id), it.mp_sku_id) };
  });
}

/** The same items with public variant ids (for answers to customers). */
function itemsOut(items) {
  return (Array.isArray(items) ? items : []).map((it) => (it && it.mp_sku_id !== undefined ? { ...it, mp_sku_id: skuPub(it.listing_id, it.mp_sku_id) } : it));
}

/** Neutral parcel states for supplier-direct deliveries (the stored codes start with AE_ for every supplier). */
const DIRECT_STATE = { AE_TO_BUY: 'ordering', AE_PLACED: 'ordering', AE_PAID: 'preparing', AE_SHIPPED: 'shipped', AE_DELIVERED: 'delivered', AE_CANCELLED: 'review' };
const directState = (code) => DIRECT_STATE[code] || 'ordering';

module.exports = { skuPub, skuIn, itemsIn, itemsOut, directState, _resetKey() { key = null; } };
