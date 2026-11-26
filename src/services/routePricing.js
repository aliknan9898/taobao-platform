'use strict';

const db = require('../db');
const { httpError } = require('../auth');
const { config } = require('../config');
const { isMarket } = require('../countries');
const ID = 'route_pricing';
const money = (value) => Math.round(value * 100) / 100;
const up99 = (value) => (Math.ceil((value * 100 - 99 - 1e-8) / 100) * 100 + 99) / 100;
const owns = (listing) => listing.seller_id === 'sel_kinan' && listing.fulfillment === 'direct' && !listing.from_kinan;
const load = () => db.settings.peek((entry) => entry.id === ID)[0] || { revision: 0, operating_pct: 0, corporation_reserve_pct: 0, routes: [] };

function number(value, name, max = 1000000) {
  if (value === '' || value == null || !['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > max) {
    throw httpError(400, 'Enter a valid ' + name);
  }
  return Number(value);
}

function calculate(input, rules) {
  const cost = number(input.cost, 'product cost');
  const shipping = number(input.shipping, 'shipping cost');
  const duty = number(input.duty, 'customs duty');
  const importTax = number(input.import_tax, 'import tax');
  const handling = number(input.handling, 'handling cost');
  const salesTaxPct = number(input.sales_tax_pct, 'sales tax rate', 100);
  const landed = money(cost + shipping + duty + importTax + handling);
  const operating = money(landed * rules.operating_pct / 100);
  const target = (landed + operating) * 0.15;
  const grossProfit = target / (1 - rules.corporation_reserve_pct / 100);
  const beforeTax = landed + operating + grossProfit;
  const out = beforeTax * (1 + salesTaxPct / 100);
  return { currency: config.currency, cost, shipping, duty, import_tax: importTax, handling, landed,
    operating, corporation_reserve: money(grossProfit - target), target_profit: money(target),
    sales_tax: money(beforeTax * salesTaxPct / 100), unrounded: money(out), price: up99(out) };
}

function save(body, user) {
  const current = load();
  if (body.revision !== current.revision) throw httpError(409, 'Pricing changed. Reload before saving.');
  const next = { ...current, revision: current.revision + 1, updated_at: Date.now(), updated_by: user.id,
    operating_pct: number(body.operating_pct, 'operating percentage', 100),
    corporation_reserve_pct: number(body.corporation_reserve_pct, 'corporation reserve percentage', 60) };
  if (body.route) {
    const r = body.route;
    const listing = db.listings.get(String(r.listing_id || ''));
    const sku = listing?.skus?.find((s) => s.mp_sku_id === r.sku_id);
    if (!listing || !owns(listing) || !sku || !isMarket(r.destination) || r.destination === 'LY') throw httpError(400, 'Select a KINAN direct product, variant and international market.');
    const origin = require('./landed').originOf(listing, sku);
    if (r.origin !== origin) throw httpError(400, 'The dispatch country must match the selected variant.');
    const same = (x) => x.listing_id === listing.id && x.sku_id === sku.mp_sku_id && x.destination === r.destination;
    next.routes = current.routes.filter((x) => !same(x));
    if (!r.remove) {
      const hs_code = String(r.hs_code || '').trim();
      const made_in = String(r.made_in || '').trim().toUpperCase();
      const evidence = String(r.evidence || '').trim();
      if (!/^\d{6,10}$/.test(hs_code) || !/^[A-Z]{2}$/.test(made_in) || !evidence || evidence.length > 500) throw httpError(400, 'Enter the HS code, customs origin and rate evidence.');
      const charges = calculate({ ...r, cost: sku.cost_sale }, next);
      if (!(charges.cost > 0)) throw httpError(400, 'Supplier cost is unavailable.');
      next.routes.push({ listing_id: listing.id, sku_id: sku.mp_sku_id, origin, destination: r.destination,
        hs_code, made_in, evidence, shipping: charges.shipping, duty: charges.duty, import_tax: charges.import_tax,
        handling: charges.handling, sales_tax_pct: Number(r.sales_tax_pct), expires_at: Date.now() + number(r.valid_days, 'validity in days', 90) * 86400e3 });
    }
  }
  if (current.revision) db.settings.update(ID, next); else db.settings.insert({ ...next, id: ID });
  return next;
}

function select(listing, sku, country, qty = 1) {
  const eligibility = require('./eligibility');
  const eligible = eligibility.enforced(country) ? (s) => eligibility.variantState(listing, s, country).state === 'eligible' : null;
  return country && owns(listing) ? require('./shipsFrom').pick(listing, sku, country, qty, eligible) : sku;
}

function routeFor(listing, sku, country, settings = load()) {
  if (!country || !owns(listing)) return null;
  return settings.routes.find((r) => r.listing_id === listing.id && r.sku_id === sku.mp_sku_id && r.destination === country) || null;
}

function priceFor(listing, sku, country, settings = load()) {
  const route = routeFor(listing, sku, country, settings);
  if (!route || route.expires_at <= Date.now() || route.origin !== require('./landed').originOf(listing, sku) || !(Number(sku.cost_sale) > 0)) return null;
  return calculate({ ...route, cost: sku.cost_sale }, settings);
}

module.exports = { calculate, load, save, select, routeFor, priceFor };
