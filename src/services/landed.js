'use strict';
/**
 * Landed cost and Kinan's prices: every product that ships straight from a supplier (AliExpress, CJ, Banggood) is
 * priced so that Kinan keeps NET_MARGIN (20%) of what the customer pays, after every cost:
 *   • the supplier's price (cost_sale) and, for AliExpress, the supplier's shipping (AliExpress charges it apart;
 *     CJ / Banggood shipping is charged to the customer at checkout at its real price)
 *   • card + currency-conversion fees (PAYMENT_FEE_PCT of the price + PAYMENT_FEE_FIXED per order)
 *   • to the EU from outside the EU (since 1 July 2026): €3 customs duty per item line + the country's VAT on it, and
 *     AliExpress's import handling fee per parcel — charged to the customer at checkout, at cost, as "import duty"
 *
 *   price = (supplier price + supplier shipping + fixed fee share) ÷ (1 − margin − card fee %)
 *
 * Settings (Render → Environment): KINAN_NET_MARGIN_PCT (20), PAYMENT_FEE_PCT (4 = card ~2.5% + conversion ~1.5%),
 * PAYMENT_FEE_FIXED (0.35), EU_DUTY_EUR (3), EU_IMPORT_HANDLING (2.55, per AliExpress parcel), AE_DEFAULT_SHIP (2.5).
 */
const db = require('../db');

const money = (v) => Math.round(Number(v) * 100) / 100;
const list = (v) => (Array.isArray(v) ? v : []);
const env = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== '' && process.env[k] != null ? v : d; };
const MARGIN = () => Math.min(60, Math.max(0, env('KINAN_NET_MARGIN_PCT', 20))) / 100;
const FEE_PCT = () => Math.min(15, Math.max(0, env('PAYMENT_FEE_PCT', 4))) / 100;
const FEE_FIXED = () => Math.max(0, env('PAYMENT_FEE_FIXED', 0.35));
const DUTY_EUR = () => Math.max(0, env('EU_DUTY_EUR', 3));
const HANDLING = () => Math.max(0, env('EU_IMPORT_HANDLING', 2.55));
const AE_SHIP = () => Math.max(0, env('AE_DEFAULT_SHIP', 2.5));

// EU VAT (standard rates) — VAT is due on the €3 duty too
const VAT = { AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25, EE: 24, FI: 25.5, FR: 20, DE: 19, GR: 24, HU: 27, IE: 23, IT: 22, LV: 21, LT: 21, LU: 17, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21, SK: 23, SI: 22, ES: 21, SE: 25 };
const isEU = (cc) => Object.prototype.hasOwnProperty.call(VAT, String(cc || '').toUpperCase());

/** Euro → sale currency (USD) with today's rate (fallback 1.08). */
function eurToSale(eur) {
  try { const r = require('./fx').chargeRate('EUR'); if (r > 0) return eur / r; } catch { /* no rate yet */ }
  return eur * 1.08;
}

const supplierOf = (l) => (['cj', 'banggood'].includes(l.source) ? l.source : 'aliexpress');
/** Where the parcel leaves from (2-letter country). */
function originOf(l) {
  if (l.source === 'cj') return String(l.cj_from || 'CN').toUpperCase();
  if (l.source === 'banggood') return String(l.bg_warehouse || 'CN').toUpperCase().slice(0, 2);
  return String(l.ae_from || l.sourcing?.from || 'CN').toUpperCase() || 'CN';
}
const isDirect = (l) => l && l.fulfillment === 'direct';

/** AliExpress shipping Kinan pays for one unit (charged by AliExpress apart from the price); the dearer of UK / EU when the country is not known. */
function aeShip(l, cc) {
  if (!isDirect(l) || supplierOf(l) !== 'aliexpress') return 0;
  const so = l.sourcing || {};
  const gb = Number.isFinite(Number(so.gb_fee)) && so.gb_fee !== null ? Number(so.gb_fee) : null;
  const eu = Number.isFinite(Number(so.eu_fee)) && so.eu_fee !== null ? Number(so.eu_fee) : null;
  if (cc === 'GB' && gb !== null) return gb;
  if (cc && isEU(cc) && eu !== null) return eu;
  const known = [gb, eu].filter((x) => x !== null);
  return known.length ? Math.max(...known) : AE_SHIP();
}

/** What one unit costs Kinan before card fees (supplier price + AliExpress shipping). */
function unitCost(l, s, cc = null) { return money((Number(s.cost_sale) || 0) + aeShip(l, cc)); }

/** The lowest price that keeps the net margin after every cost (one unit on its own order). */
function minPrice(l, s, cc = null) {
  const cost = unitCost(l, s, cc);
  if (!(cost > 0)) return 0;
  return money((cost + FEE_FIXED()) / Math.max(0.2, 1 - MARGIN() - FEE_PCT()));
}
/** Kinan's shop price: the margin price, ending in .99 (never under it). */
function priceFor(l, s, cc = null) {
  const p = minPrice(l, s, cc);
  if (!p) return Number(s.price) || 0;
  let c = Math.ceil(p) - 0.01; if (c + 1e-9 < p) c += 1;
  return money(c);
}

/** Net Kinan keeps on one line (price × qty) for a destination, after supplier, shipping and card fees. */
function netOf(l, s, price, qty = 1, cc = null) {
  return money(price * qty * (1 - FEE_PCT()) - unitCost(l, s, cc) * qty);
}

/**
 * EU import charges for a cart going to `cc`: €3 duty + VAT on it for every product line that ships from outside the
 * EU, and AliExpress's handling fee once per AliExpress parcel. Charged at cost (plus the card fee on it).
 */
function importCharges(items, cc) {
  cc = String(cc || '').toUpperCase();
  if (!isEU(cc)) return { fee: 0, lines: 0 };
  const lines = new Set(); const aeParcels = new Set();
  for (const it of items) {
    const l = db.listings.get(it.listing_id);
    if (!isDirect(l) || isEU(originOf(l))) continue;
    lines.add(`${l.id}`);
    if (supplierOf(l) === 'aliexpress') aeParcels.add(l.seller_id); // one AliExpress order per shop
  }
  if (!lines.size) return { fee: 0, lines: 0 };
  const duty = eurToSale(DUTY_EUR() * (1 + VAT[cc] / 100)) * lines.size;
  const handling = HANDLING() * aeParcels.size;
  return { fee: money((duty + handling) / (1 - FEE_PCT())), lines: lines.size, duty: money(duty), handling: money(handling), vat_pct: VAT[cc] };
}

/**
 * Before taking a customer's money: lines whose price does not cover their real cost to this country.
 * Kinan's own products are repriced on the spot; sellers' products are refused (the seller sets the price).
 */
function guard(lines, cc) {
  const kinan = require('./buyforme').systemSeller().id;
  const out = [];
  for (const ln of lines) {
    if (!ln.direct) continue;
    const l = db.listings.get(ln.listing_id); if (!l) continue;
    const s = list(l.skus).find((x) => x.mp_sku_id === ln.mp_sku_id); if (!s || !(Number(s.cost_sale) > 0)) continue;
    const cost = ln.seller_cost != null && l.from_kinan ? null : unitCost(l, s, cc); // a Kinan-catalogue copy: the seller pays the Kinan price
    if (cost === null) continue;
    const need = (cost + FEE_FIXED()) / (1 - FEE_PCT());
    if (ln.price + 1e-9 >= need) continue;
    out.push({ line: ln, listing: l, sku: s, need: money(need), own: l.seller_id === kinan });
  }
  return out;
}

/** Reprice Kinan's own supplier products (all, or the given ids) to the margin price. Returns how many changed. */
function repriceKinan({ ids = null, dry = false } = {}) {
  const kinan = require('./buyforme').systemSeller().id;
  let changed = 0; let up = 0; let down = 0; const samples = [];
  for (const l of db.listings.all((x) => x.seller_id === kinan && isDirect(x) && (!ids || ids.includes(x.id)))) {
    let touched = false;
    const skus = list(l.skus).map((s) => {
      if (!(Number(s.cost_sale) > 0)) return s;
      const p = priceFor(l, s);
      if (Math.abs(p - (Number(s.price) || 0)) < 0.01) return s;
      touched = true; if (p > s.price) up++; else down++;
      if (samples.length < 8) samples.push({ id: l.id, title: String(l.title).slice(0, 50), was: s.price, now: p, cost: s.cost_sale, ship: aeShip(l) });
      return { ...s, price: p };
    });
    if (touched) { changed++; if (!dry) db.listings.update(l.id, { skus, priced_at: Date.now(), price_rule: `net ${Math.round(MARGIN() * 100)}%` }); }
  }
  return { changed, sku_up: up, sku_down: down, samples, rule: rules() };
}

function rules() {
  return { net_margin_pct: Math.round(MARGIN() * 100), card_fee_pct: Math.round(FEE_PCT() * 1000) / 10, card_fee_fixed: FEE_FIXED(), eu_duty_eur: DUTY_EUR(), eu_handling_per_ae_parcel: HANDLING(), ae_default_ship: AE_SHIP() };
}

module.exports = { minPrice, priceFor, unitCost, aeShip, netOf, importCharges, guard, repriceKinan, rules, isEU, originOf, VAT };
