// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Product categories and international shipping prices.
 * Shipping is charged only for items that go through the China warehouse (AliExpress items ship
 * direct with the supplier's shipping). Price = zone rate for the first 0.5 kg + rate per extra 0.5 kg.
 * After the parcel is weighed at dispatch, the difference is settled with the customer's wallet.
 */
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');
const { countryCode } = require('../countries');

const money = (n) => Math.round(Number(n) * 100) / 100;

const CATEGORIES = [
  ['women', 'Women’s fashion', 'أزياء نسائية'], ['men', 'Men’s fashion', 'أزياء رجالية'], ['kids', 'Kids & baby', 'أطفال ورضّع'],
  ['shoes_bags', 'Shoes & bags', 'أحذية وحقائب'], ['beauty', 'Beauty & care', 'جمال وعناية'], ['home', 'Home & kitchen', 'المنزل والمطبخ'],
  ['electronics', 'Electronics', 'إلكترونيات'], ['phone', 'Phone accessories', 'إكسسوارات الهاتف'], ['sports', 'Sports & outdoors', 'رياضة وخارج المنزل'],
  ['toys', 'Toys & games', 'ألعاب'], ['car', 'Car accessories', 'إكسسوارات السيارات'], ['other', 'Other', 'أخرى']
];
const CATEGORY_IDS = new Set(CATEGORIES.map(([id]) => id));
const cleanCategory = (c) => (CATEGORY_IDS.has(c) ? c : 'other');

const ZONES = [
  ['gulf', 'Gulf', ['SA', 'AE', 'KW', 'QA', 'BH', 'OM']],
  ['levant', 'Levant, Iraq & Yemen', ['JO', 'IQ', 'LB', 'PS', 'SY', 'YE']],
  ['africa', 'North Africa', ['EG', 'LY', 'TN', 'DZ', 'MA', 'SD', 'MR']],
  ['europe', 'Europe & Turkey', ['TR', 'MT', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'SE', 'NO', 'DK', 'AT', 'CH', 'IE', 'PL', 'GR', 'CY']],
  ['other', 'Rest of the world', []]
];
const zoneOf = (code) => (ZONES.find(([, , cs]) => cs.includes(code)) || ZONES[ZONES.length - 1])[0];

const DEFAULTS = {
  mode: 'weight', // 'weight' | 'flat'
  flat: Number(config.shippingFlat || 8),
  default_item_kg: 0.5,
  rates: { gulf: { first: 8, extra: 3 }, levant: { first: 10, extra: 4 }, africa: { first: 11, extra: 4 }, europe: { first: 9, extra: 3.5 }, other: { first: 14, extra: 5 } },
  settle_tolerance: 0.5, // differences smaller than this are ignored
  days: { gulf: '7–12', levant: '9–15', africa: '10–18', europe: '8–14', other: '12–20' }
};
const SID = 'set_shipping';

function settings() {
  const s = db.settings.get(SID);
  return { ...DEFAULTS, ...(s || {}), rates: { ...DEFAULTS.rates, ...(s?.rates || {}) }, days: { ...DEFAULTS.days, ...(s?.days || {}) } };
}

function saveSettings(b = {}) {
  const cur = settings();
  const next = { mode: b.mode === 'flat' ? 'flat' : 'weight', flat: money(b.flat ?? cur.flat), default_item_kg: Number(b.default_item_kg ?? cur.default_item_kg), settle_tolerance: money(b.settle_tolerance ?? cur.settle_tolerance), rates: {}, days: {} };
  if (!(next.flat >= 0) || !(next.default_item_kg > 0 && next.default_item_kg < 50)) throw httpError(400, 'Invalid values');
  for (const [z] of ZONES) {
    const r = (b.rates || {})[z] || cur.rates[z];
    const first = money(r.first); const extra = money(r.extra);
    if (!(first >= 0 && extra >= 0)) throw httpError(400, `Invalid rate for ${z}`);
    next.rates[z] = { first, extra };
    next.days[z] = String((b.days || {})[z] ?? cur.days[z]).slice(0, 20);
  }
  return db.settings.get(SID) ? db.settings.update(SID, next) : db.settings.insert({ id: SID, ...next });
}

/** Price for a weight (kg) to a country. */
function priceFor(weightKg, code) {
  const s = settings();
  const zone = zoneOf(code);
  if (s.mode === 'flat') return { fee: money(s.flat), zone, chargeable_kg: null };
  const kg = Math.max(0.5, Math.ceil((Number(weightKg) || 0) / 0.5) * 0.5);
  const r = s.rates[zone];
  return { fee: money(r.first + ((kg - 0.5) / 0.5) * r.extra), zone, chargeable_kg: kg };
}

/** Quote for cart lines [{ listing_id, qty }] — only warehouse items count. */
function quote(items = [], country) {
  const code = countryCode(country) || null;
  const s = settings();
  let weight = 0; let warehouseItems = 0; let directItems = 0;
  for (const it of items) {
    const l = db.listings.get(it.listing_id); const q = Math.max(1, Math.floor(Number(it.qty) || 1));
    if (!l) continue;
    if (l.fulfillment === 'direct') { directItems += q; continue; }
    warehouseItems += q;
    weight += (Number(l.weight_kg) > 0 ? Number(l.weight_kg) : s.default_item_kg) * q;
  }
  const zone = zoneOf(code);
  if (!warehouseItems) return { fee: 0, weight_kg: 0, zone, country_code: code, direct_items: directItems, days: null, note: 'Shipping is included for items that ship directly from the supplier' };
  const p = priceFor(weight, code);
  return { fee: p.fee, weight_kg: Math.round(weight * 100) / 100, chargeable_kg: p.chargeable_kg, zone, country_code: code, direct_items: directItems, days: s.days[zone], mode: s.mode };
}

/**
 * After dispatch: compare the real weight with what the customer paid for.
 * Overpaid → credit the wallet now. Underpaid → record `shipping_due` the customer can pay from the order page.
 */
function settleAfterWeighing(order, actualWeightG) {
  const s = settings();
  if (s.mode !== 'weight' || !actualWeightG || !(order.shipping_fee >= 0) || order.shipping_settled) return null;
  const actual = priceFor(actualWeightG / 1000, order.shipping_address?.country_code).fee;
  const diff = money(actual - order.shipping_fee);
  const shop = require('./shop');
  const rec = { actual_weight_kg: Math.round(actualWeightG) / 1000, actual_fee: actual, diff, at: Date.now() };
  if (Math.abs(diff) < s.settle_tolerance) { db.orders.update(order.id, { shipping_settled: { ...rec, result: 'within_tolerance' } }); return rec; }
  if (diff < 0) {
    shop.walletEntry(order.buyer_id, -diff, `Shipping refund — your parcel weighed less (order ${order.id.slice(-8).toUpperCase()})`, { order_id: order.id, kind: 'shipping_refund' });
    db.orders.update(order.id, { shipping_settled: { ...rec, result: 'credited' } });
  } else {
    db.orders.update(order.id, { shipping_due: diff, shipping_settled: { ...rec, result: 'due' } });
  }
  return rec;
}

/** Customer pays an extra-shipping amount from their wallet. */
function payShippingDue(order, buyer) {
  if (!order.shipping_due) throw httpError(409, 'Nothing to pay');
  const shop = require('./shop');
  if (shop.walletOf(buyer.id).balance < order.shipping_due) throw httpError(409, 'Your wallet balance is not enough — top it up or contact Kinan');
  shop.walletEntry(buyer.id, -order.shipping_due, `Extra shipping for order ${order.id.slice(-8).toUpperCase()}`, { order_id: order.id, kind: 'shipping_due' });
  return db.orders.update(order.id, { shipping_due: 0, shipping_due_paid: money((order.shipping_due_paid || 0) + order.shipping_due) });
}

module.exports = { CATEGORIES, cleanCategory, ZONES, zoneOf, settings, saveSettings, priceFor, quote, settleAfterWeighing, payShippingDue };
