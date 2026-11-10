// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Exchange rates, refreshed every day from a free public source (open.er-api.com, no key).
 * - CNY: used for buying costs. A safety margin (FX_CNY_BUFFER_PCT, default 2%) makes costs a little
 *   higher than the market rate so a weaker sale currency never eats the margin.
 * - Display currencies: customers see approximate prices in their own currency; they are always charged
 *   in the sale currency (USD by default).
 */
const db = require('../db');
const { config } = require('../config');

const SID = 'set_fx';
const DISPLAY = ['USD', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'IQD', 'EGP', 'MAD', 'DZD', 'TND', 'LYD', 'LBP', 'SYP', 'YER', 'SDG', 'TRY', 'EUR', 'GBP'];
const ENV_RATE = Number(process.env.CNY_PER_SALE_UNIT) || 0; // a fixed rate set by hand wins over the automatic one
const BUFFER = Math.min(10, Math.max(0, Number(process.env.FX_CNY_BUFFER_PCT ?? 2))) / 100;
const MAX_AGE = 20 * 3600e3;

function saved() { return db.settings.get(SID) || null; }

/** Apply the saved rates to the running config (config.cnyRate is read everywhere costs are computed). */
function apply() {
  const s = saved();
  if (ENV_RATE) { config.cnyRate = ENV_RATE; return; }
  if (s && s.rates && s.rates.CNY > 0) config.cnyRate = Math.round(s.rates.CNY * (1 - BUFFER) * 10000) / 10000;
}

async function refresh({ force = false } = {}) {
  const s = saved();
  const base = config.currency.toUpperCase();
  if (!force && s && s.base === base && Date.now() - s.updated_at < MAX_AGE) { apply(); return s; }
  const r = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (!r.ok || j.result !== 'success' || !j.rates || !(j.rates.CNY > 0)) throw new Error(`exchange rates unavailable (${r.status})`);
  const rates = {};
  for (const c of ['CNY', ...DISPLAY]) if (j.rates[c] > 0) rates[c] = j.rates[c];
  const doc = { base, rates, updated_at: Date.now(), source: 'open.er-api.com' };
  if (s) db.settings.update(SID, doc); else db.settings.insert({ id: SID, ...doc });
  apply();
  console.log(`[fx] rates updated: 1 ${base} = ${rates.CNY} CNY (cost rate ${config.cnyRate})`);
  return doc;
}

/** What the shop shows customers: currencies they can pick and their rate against the sale currency. */
function publicRates() {
  const s = saved();
  const base = config.currency.toUpperCase();
  const rates = { [base]: 1 };
  if (s && s.base === base) for (const c of DISPLAY) if (s.rates[c] > 0) rates[c] = s.rates[c];
  return { base, rates, updated_at: s ? s.updated_at : null };
}

function status() {
  const s = saved();
  return { cny_market: s?.rates?.CNY || null, cny_used: config.cnyRate, buffer_pct: BUFFER * 100, fixed_by_env: Boolean(ENV_RATE), updated_at: s?.updated_at || null };
}

module.exports = { refresh, apply, publicRates, status, DISPLAY };
