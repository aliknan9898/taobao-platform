'use strict';
/**
 * AliExpress "Ships From" is a warehouse, not something the customer should choose. Kinan hides it and picks, for
 * each order, the best warehouse for the customer's address:
 *   1. in the customer's own region (an EU warehouse for an EU address, a UK one for the UK): fastest, and no EU
 *      import duty for the customer;
 *   2. otherwise the cheapest one in stock.
 * Every warehouse copy of an option gets the same shop price (the dearest one's price), so Kinan's margin holds
 * whichever warehouse sends it, and the customer always pays the price they saw.
 */
const SHIP_RE = /^(ships?\s*from|ship\s*from|shipping\s*from|origin|发货地)$/i;
const COUNTRY = {
  china: 'CN', 'mainland china': 'CN', cn: 'CN', spain: 'ES', es: 'ES', germany: 'DE', de: 'DE', france: 'FR', fr: 'FR', italy: 'IT', it: 'IT', poland: 'PL', pl: 'PL',
  'czech republic': 'CZ', czechia: 'CZ', cz: 'CZ', belgium: 'BE', be: 'BE', netherlands: 'NL', nl: 'NL', portugal: 'PT', pt: 'PT', hungary: 'HU', hu: 'HU', austria: 'AT',
  'united kingdom': 'GB', uk: 'GB', gb: 'GB', 'great britain': 'GB', 'united states': 'US', usa: 'US', us: 'US', turkey: 'TR', 'türkiye': 'TR', tr: 'TR',
  'russian federation': 'RU', russia: 'RU', ru: 'RU', brazil: 'BR', br: 'BR', australia: 'AU', au: 'AU', 'saudi arabia': 'SA', 'united arab emirates': 'AE', uae: 'AE',
  israel: 'IL', chile: 'CL', ukraine: 'UA', vietnam: 'VN', 'south korea': 'KR', korea: 'KR', japan: 'JP', mexico: 'MX', latvia: 'LV', bulgaria: 'BG', ireland: 'IE',
  slovakia: 'SK', romania: 'RO', greece: 'GR', malta: 'MT', sweden: 'SE', denmark: 'DK', finland: 'FI', lithuania: 'LT', estonia: 'EE', croatia: 'HR', slovenia: 'SI'
};
const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
const list = (v) => (Array.isArray(v) ? v : []);
const ccOf = (v) => COUNTRY[String(v || '').trim().toLowerCase()] || null;

/** Split one option into its warehouse (2-letter country) and what the customer really chooses (colour, size…). */
function split(s) {
  const opts = list(s.opts);
  if (opts.length) {
    const i = opts.findIndex((o) => SHIP_RE.test(String(o.name || '').trim()));
    if (i >= 0) {
      const vis = opts.filter((_, k) => k !== i);
      return { from: ccOf(opts[i].value) || String(opts[i].value || '').toUpperCase().slice(0, 2), opts: vis, props: vis.map((o) => o.value).join(' / ') || 'Standard' };
    }
    return { from: null, opts, props: s.props };
  }
  // older products: "Black / China" — a last part that is a country is the warehouse
  const parts = String(s.props || '').split(/\s*\/\s*/).filter(Boolean);
  if (parts.length && ccOf(parts[parts.length - 1])) { const vis = parts.slice(0, -1); return { from: ccOf(parts[parts.length - 1]), opts: null, props: vis.join(' / ') || 'Standard' }; }
  return { from: null, opts: s.opts || null, props: s.props };
}

/** Is this an AliExpress product whose options include a warehouse choice? */
const applies = (l) => Boolean(l && l.fulfillment === 'direct' && !['cj', 'banggood'].includes(l.source) && list(l.skus).some((s) => split(s).from));

/** Options grouped by what the customer chooses: key → [warehouse copies]. */
function groups(l) {
  const m = new Map();
  for (const s of list(l.skus)) { const v = split(s); const k = v.props; if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
  return m;
}

/** One option per customer choice, as shown in the shop (warehouse hidden; stock of all its warehouses together). */
function visibleSkus(l) {
  if (!applies(l)) return list(l.skus);
  const out = [];
  for (const [, sibs] of groups(l)) {
    const inStock = sibs.filter((s) => s.stock > 0);
    const rep = (inStock.length ? inStock : sibs).slice().sort((a, b) => (Number(a.cost_sale) || 0) - (Number(b.cost_sale) || 0))[0];
    const v = split(rep);
    out.push({ ...rep, props: v.props, ...(v.opts ? { opts: v.opts } : {}), stock: sibs.reduce((a, s) => a + (Number(s.stock) || 0), 0), ...(!rep.image ? { image: sibs.find((s) => s.image)?.image } : {}) });
  }
  return out;
}

/** The warehouse copy to order for this customer: in their region if possible, else the cheapest in stock. */
function pick(l, sku, cc, qty = 1, ok = null) {
  if (!applies(l) || !sku) return sku;
  const key = split(sku).props;
  // ok(): optional filter (delivery eligibility for the customer's country) applied before choosing a warehouse
  const sibs = (groups(l).get(key) || [sku]).filter((s) => s.stock >= qty && (!ok || ok(s)));
  if (!sibs.length) return sku;
  cc = String(cc || '').toUpperCase();
  const local = (s) => { const f = split(s).from; return f === cc || (EU.has(cc) && EU.has(f)); };
  const cheap = (a, b) => (Number(a.cost_sale) || 0) - (Number(b.cost_sale) || 0);
  return sibs.filter(local).sort(cheap)[0] || sibs.slice().sort(cheap)[0];
}

/** Every warehouse copy of the same customer choice (just [sku] for other products). */
function siblings(l, sku) { return applies(l) && sku ? groups(l).get(split(sku).props) || [sku] : [sku]; }

/** Warehouse of one option (2-letter country) or null. */
const originOfSku = (s) => (s ? split(s).from : null);

module.exports = { split, applies, groups, visibleSkus, pick, siblings, originOfSku, ccOf, EU };
