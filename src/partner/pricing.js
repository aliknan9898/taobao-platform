// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* B2B wholesale pricing for partner stores. Money is integer minor units throughout.
 *
 * KINAN contribution = B2B revenue excl. VAT − KINAN variable costs − KINAN payment fees.
 * Margin = contribution ÷ B2B revenue excl. VAT.
 * Floor for target margin m and fee rate r on net revenue:  floor = F / (1 − m − r)
 * If the fee is charged on the VAT-inclusive amount with one VAT rate t: floor = F / (1 − m − r × (1 + t)).
 * The floor is always rounded UP to the minor unit.
 *
 * In the catalogue the wholesale unit price is indicative (goods cost only); the binding check runs per basket
 * on the quote in Batch 2, including shipping, duties and handling that KINAN bears. */
'use strict';

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
/** Owner-configurable target (default 30%) and fee settings. */
function settings() {
  return {
    target: Math.min(0.9, Math.max(0, num(process.env.PARTNER_TARGET_MARGIN, 0.30))),
    feeRate: Math.min(0.2, Math.max(0, num(process.env.PARTNER_FEE_RATE, 0))),
    feeOnGross: process.env.PARTNER_FEE_ON_GROSS === '1',
    vatRate: Math.min(0.5, Math.max(0, num(process.env.PARTNER_FEE_VAT_RATE, 0)))
  };
}

/** Minimum net revenue (minor units) that reaches the target contribution for costs F (minor units). */
function floorMinor(F, s = settings()) {
  const c = Math.max(0, Math.round(Number(F) || 0));
  const fee = s.feeOnGross ? s.feeRate * (1 + s.vatRate) : s.feeRate;
  const denom = 1 - s.target - fee;
  if (!(denom > 0)) throw new Error('pricing: target margin plus fees must stay below 100%');
  // Integer arithmetic guard against float error on exact values (e.g. 1625 / 0.7)
  const x = c / denom;
  const r = Math.round(x);
  return Math.abs(x - r) < 1e-9 ? r : Math.ceil(x);
}

/** Contribution and margin for a net revenue and the KINAN costs behind it. */
function contribution(revenueMinor, costMinor, s = settings()) {
  const fee = Math.round(revenueMinor * (s.feeOnGross ? s.feeRate * (1 + s.vatRate) : s.feeRate));
  const c = revenueMinor - costMinor - fee;
  return { contribution_minor: c, margin: revenueMinor > 0 ? c / revenueMinor : 0, fee_minor: fee };
}

/** Indicative wholesale unit price for a store: the floor, plus the store price list's markup (never below the floor). */
function wholesaleUnit(costMinor, priceList = {}, s = settings()) {
  const floor = floorMinor(costMinor, s);
  const markup = Math.max(0, num(priceList.markup_pct, 0)) / 100;
  return Math.max(floor, Math.ceil(floor * (1 + markup)));
}

module.exports = { settings, floorMinor, contribution, wholesaleUnit };
