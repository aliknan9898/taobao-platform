'use strict';
/**
 * Sell Kinan's own products on eBay.
 *  - list(): Kinan listings (CJ, shipped from European/UK warehouses) → eBay inventory items, variation groups, offers, live listings
 *  - sync(): price and stock follow Kinan (hourly)
 *  - importOrders(): paid eBay orders become Kinan orders, so CJ ships them like any other order
 *  - pushTracking(): CJ tracking numbers go back to eBay, which tells the buyer
 * Only products of the Kinan shop itself are listed (there is no other seller to pay).
 */
const db = require('../db');
const { httpError } = require('../auth');
const { config } = require('../config');
const ebay = require('../ebay/client');

const now = () => Date.now();
const money = (v) => Math.round(Number(v) * 100) / 100;
const list = (v) => (Array.isArray(v) ? v : []);
const SID = 'ebay_state';
const KINAN = 'sel_kinan';

const MARKETS = {
  // Delivery services from eBay's ShippingServiceCodeType list: a tracked courier from a warehouse in the site's country,
  // and eBay's "tracked delivery from abroad" for items sent from another European warehouse (CJ always gives tracking)
  EBAY_GB: { currency: 'GBP', lang: 'en-GB', country: 'GB', domestic: 'UK_OtherCourier5Days', outside: 'UK_TrackedDeliveryFromAbroad' },
  EBAY_DE: { currency: 'EUR', lang: 'de-DE', country: 'DE', domestic: 'DE_Paket', outside: 'DE_TrackedDeliveryFromAbroad' },
  EBAY_FR: { currency: 'EUR', lang: 'fr-FR', country: 'FR', domestic: 'FR_TrackedDeliveryFromAbroad', outside: 'FR_TrackedDeliveryFromAbroad' },
  EBAY_IT: { currency: 'EUR', lang: 'it-IT', country: 'IT', domestic: 'IT_TrackedDeliveryFromAbroad', outside: 'IT_TrackedDeliveryFromAbroad' },
  EBAY_ES: { currency: 'EUR', lang: 'es-ES', country: 'ES', domestic: 'ES_TrackedDeliveryFromAbroad', outside: 'ES_TrackedDeliveryFromAbroad' }
};
const EUROPE = ['GB', 'DE', 'FR', 'ES', 'IT', 'PL', 'CZ', 'NL', 'BE', 'AT', 'HU', 'PT', 'IE', 'SE', 'DK'];
// eBay needs a place for each warehouse (city + postcode). CJ's exact addresses are not published: the main city of each country by default,
// EBAY_LOCATIONS='{"DE":{"city":"Kassel","postalCode":"34117"}}' overrides it.
const CITY = {
  GB: ['London', 'EC1A 1BB'], DE: ['Frankfurt am Main', '60311'], FR: ['Paris', '75001'], ES: ['Madrid', '28001'], IT: ['Milano', '20121'],
  PL: ['Warszawa', '00-001'], CZ: ['Praha', '11000'], NL: ['Amsterdam', '1012 JS'], BE: ['Bruxelles', '1000'], AT: ['Wien', '1010'],
  HU: ['Budapest', '1051'], PT: ['Lisboa', '1100-148'], IE: ['Dublin', 'D01 F5P2'], SE: ['Stockholm', '111 20'], DK: ['København', '1050'], CN: ['Shenzhen', '518000']
};

// ---------------- settings & state ----------------

function prefs() {
  const s = state();
  const p = s.prefs || {};
  const marketplace = MARKETS[p.marketplace] ? p.marketplace : (MARKETS[process.env.EBAY_MARKETPLACE] ? process.env.EBAY_MARKETPLACE : 'EBAY_GB');
  return {
    marketplace,
    markup_pct: Math.min(200, Math.max(0, Number(p.markup_pct ?? process.env.EBAY_MARKUP_PCT ?? 18))), // eBay fees are ~13% of the sale
    max_qty: Math.min(50, Math.max(1, Math.floor(Number(p.max_qty ?? 10)))),
    from: (Array.isArray(p.from) && p.from.length ? p.from : EUROPE).map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)),
    handling_days: Math.min(5, Math.max(1, Math.floor(Number(p.handling_days ?? 3)))),
    auto_sync: p.auto_sync !== false
  };
}
function state() { return db.settings.get(SID) || {}; }
function saveState(patch) { const s = db.settings.get(SID); return s ? db.settings.update(SID, typeof patch === 'function' ? patch : { ...patch }) : db.settings.insert({ id: SID, ...(typeof patch === 'function' ? patch({}) : patch) }); }
function savePrefs(b = {}) {
  const cur = state().prefs || {};
  const next = { ...cur };
  if (b.marketplace !== undefined) { if (!MARKETS[b.marketplace]) throw httpError(400, 'Unknown eBay site'); next.marketplace = b.marketplace; }
  if (b.markup_pct !== undefined) next.markup_pct = Number(b.markup_pct);
  if (b.max_qty !== undefined) next.max_qty = Number(b.max_qty);
  if (b.handling_days !== undefined) next.handling_days = Number(b.handling_days);
  if (b.from !== undefined) next.from = String(b.from).split(/[\s,]+/).filter(Boolean);
  if (b.auto_sync !== undefined) next.auto_sync = Boolean(b.auto_sync);
  saveState({ prefs: next });
  return prefs();
}
const market = () => MARKETS[prefs().marketplace];

// ---------------- pricing ----------------

function rate(cur) {
  const base = config.currency.toUpperCase();
  if (cur === base) return 1;
  const r = require('./fx').chargeRate(cur);
  if (!(r > 0)) throw httpError(503, `No ${base}→${cur} exchange rate yet`);
  return r;
}
/** Kinan price + delivery (eBay listings ship free) + eBay markup, in the site's currency, ending .99 */
function ebayPrice(kinanPrice, shipFee) {
  const p = prefs();
  const v = (Number(kinanPrice) + Number(shipFee || 0)) * (1 + p.markup_pct / 100) * rate(market().currency);
  return (Math.max(1, Math.ceil(v)) - 0.01).toFixed(2);
}
async function shipFee(l, sku) {
  try { const q = await require('./cj').quote([{ listing_id: l.id, mp_sku_id: sku.mp_sku_id, qty: 1 }], market().country); return Number(q?.fee) || 0; } catch { return 0; }
}

// ---------------- what may be listed ----------------

const skuKey = (l, s) => `K-${l.id.replace(/^lst_/, '')}-${String(s.cj_vid || s.mp_sku_id).replace(/[^A-Za-z0-9]/g, '').slice(-24)}`.slice(0, 50);
const groupKey = (l) => `KG-${l.id.replace(/^lst_/, '')}`.slice(0, 50);
const qtyOf = (l, s) => (l.status === 'active' ? Math.max(0, Math.min(prefs().max_qty, Math.floor(Number(s.stock) || 0))) : 0);

function eligible(l) {
  if (!l) return 'Not found';
  if (l.seller_id !== KINAN) return 'Only products of the Kinan shop itself can go on eBay';
  if (l.source !== 'cj' || l.fulfillment !== 'direct') return 'Only CJ products shipped straight to the customer can go on eBay';
  if (l.status !== 'active') return 'The product is not live on Kinan';
  if (!prefs().from.includes(String(l.cj_from || 'CN').toUpperCase())) return `Ships from ${l.cj_from || 'CN'} — not one of the eBay warehouses`;
  if (!list(l.skus).some((s) => s.stock > 0)) return 'Out of stock';
  if (!list(l.images).some((u) => /^https:/.test(u))) return 'No photos';
  if (l.sourcing && l.sourcing.ebay_ok === false) return 'The AI or the UK delivery check says it is not for eBay UK';
  return null;
}

/** Moving from the eBay test site (sandbox) to the real one: listings, policies and warehouses made on the test site do not
 *  exist on the real one, so forget them once (kept as ebay_sandbox for reference). */
function ensureEnv() {
  const e = ebay.env();
  if (!ebay.configured() || state().env === e) return;
  let moved = 0;
  for (const l of db.listings.all((x) => x.ebay && (x.ebay.env || 'sandbox') !== e)) { db.listings.update(l.id, { ebay: null, [`ebay_${l.ebay.env || 'sandbox'}`]: l.ebay }); moved++; }
  saveState((x) => ({ ...x, env: e, policies: null, locations: list(x.locations).filter((k) => k.startsWith(`${e}:`)), job: null }));
  console.log(`[ebay] now on the ${e} site: ${moved} listing(s) from the other site set aside`);
}

function candidates({ collection, ids } = {}) {
  ensureEnv();
  const want = ids && ids.length ? new Set(ids) : null;
  return db.listings.all((l) => (want ? want.has(l.id) : (!collection || list(l.collections).includes(collection))) && !l.ebay?.listing_id && !eligible(l));
}

// ---------------- setup: policies and warehouses on eBay ----------------

async function policies() {
  const mk = prefs().marketplace; const m = market();
  const get = (kind) => ebay.api('GET', `/sell/account/v1/${kind}_policy`, undefined, { query: { marketplace_id: mk } }).then((j) => list(j[`${kind}Policies`]));
  let fp; let pp; let rp;
  try { [fp, pp, rp] = await Promise.all([get('fulfillment'), get('payment'), get('return')]); }
  catch (e) {
    // The account has not switched on business policies yet: ask eBay to, then try again in a few minutes
    if (list(e.errors).some((x) => x.errorId === 20403 || /not eligible|opt/i.test(x.message || ''))) {
      await ebay.api('POST', '/sell/account/v1/program/opt_in', { programType: 'SELLING_POLICY_MANAGEMENT' }).catch(() => {});
      throw httpError(409, 'eBay is switching on business policies for your account — try again in 10 minutes');
    }
    throw e;
  }
  const cat = [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }];
  const pick = (arr, name) => arr.find((x) => x.name === name) || arr.find((x) => /kinan/i.test(x.name || ''));
  let payment = pick(pp, 'Kinan payment') || pp[0];
  if (!payment) payment = await ebay.api('POST', '/sell/account/v1/payment_policy', { name: 'Kinan payment', marketplaceId: mk, categoryTypes: cat });
  let ret = pick(rp, 'Kinan 30-day returns') || rp[0];
  if (!ret) ret = await ebay.api('POST', '/sell/account/v1/return_policy', { name: 'Kinan 30-day returns', marketplaceId: mk, categoryTypes: cat, returnsAccepted: true, returnPeriod: { value: 30, unit: 'DAY' }, refundMethod: 'MONEY_BACK', returnShippingCostPayer: 'BUYER' });
  // Two delivery policies: from a warehouse in the site's own country, and from elsewhere in Europe
  const ship = async (name, code) => {
    const body = {
      name, description: 'Free tracked delivery. Dispatched from our European warehouse within the handling time.', marketplaceId: mk, categoryTypes: cat,
      handlingTime: { value: prefs().handling_days, unit: 'DAY' }, localPickup: false, freightShipping: false,
      shippingOptions: [{ optionType: 'DOMESTIC', costType: 'FLAT_RATE', shippingServices: [{ shippingServiceCode: code, freeShipping: true, buyerResponsibleForShipping: false, shippingCost: { value: '0.00', currency: m.currency }, sortOrder: 1 }] }]
    };
    const have = fp.find((x) => x.name === name);
    if (have) {
      // Bring a policy Kinan made earlier up to date (service, handling time)
      const cur = have.shippingOptions?.[0]?.shippingServices?.[0]?.shippingServiceCode;
      if (cur !== code || have.handlingTime?.value !== prefs().handling_days) {
        await ebay.api('PUT', `/sell/account/v1/fulfillment_policy/${have.fulfillmentPolicyId}`, body).catch((e) => console.warn('[ebay] update delivery policy', name, e.message));
      }
      return have.fulfillmentPolicyId;
    }
    const made = await ebay.api('POST', '/sell/account/v1/fulfillment_policy', body).catch((e) => {
      console.warn('[ebay] delivery policy', name, code, e.message);
      if (fp[0]) return fp[0];
      throw httpError(400, `${e.message} — create a delivery (postage) policy with free delivery in eBay Seller Hub › Account › Business policies, then try again`);
    });
    return made.fulfillmentPolicyId;
  };
  const out = {
    marketplace: mk, env: ebay.env(),
    payment: payment.paymentPolicyId, return: ret.returnPolicyId,
    ship_home: await ship('Kinan free delivery', process.env.EBAY_SHIPPING_SERVICE || m.domestic),
    ship_outside: await ship('Kinan free delivery from Europe', process.env.EBAY_SHIPPING_SERVICE_OUTSIDE || m.outside),
    at: now()
  };
  saveState({ policies: out });
  return out;
}

async function location(cc) {
  const key = `kinan-${cc.toLowerCase()}`;
  const s = state();
  if (list(s.locations).includes(`${ebay.env()}:${key}`)) return key;
  let over = {}; try { over = JSON.parse(process.env.EBAY_LOCATIONS || '{}')[cc] || {}; } catch { over = {}; }
  const [city, postalCode] = CITY[cc] || [cc, ''];
  await ebay.api('POST', `/sell/inventory/v1/location/${key}`, {
    location: { address: { city: over.city || city, postalCode: over.postalCode || postalCode, country: cc } },
    locationTypes: ['WAREHOUSE'], name: `Kinan warehouse ${cc}`, merchantLocationStatus: 'ENABLED'
  }).catch((e) => { if (!/already exists|25803/i.test(`${e.message} ${list(e.errors).map((x) => x.errorId).join(' ')}`)) throw e; });
  saveState((x) => ({ ...x, locations: [...new Set([...list(x.locations), `${ebay.env()}:${key}`])] }));
  return key;
}

// ---------------- category and item specifics ----------------

const treeCache = {};
async function treeId(mk) {
  if (treeCache[mk]) return treeCache[mk];
  const j = await ebay.api('GET', '/commerce/taxonomy/v1/get_default_category_tree_id', undefined, { user: false, query: { marketplace_id: mk } });
  treeCache[mk] = j.categoryTreeId; return j.categoryTreeId;
}
async function category(l) {
  const tid = await treeId(prefs().marketplace);
  const q = String(l.title).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).slice(0, 8).join(' ');
  const j = await ebay.api('GET', `/commerce/taxonomy/v1/category_tree/${tid}/get_category_suggestions`, undefined, { user: false, query: { q } });
  const c = list(j.categorySuggestions)[0]?.category;
  if (!c) throw httpError(400, 'eBay found no category for this product');
  const a = await ebay.api('GET', `/commerce/taxonomy/v1/category_tree/${tid}/get_item_aspects_for_category`, undefined, { user: false, query: { category_id: c.categoryId } });
  const required = list(a.aspects).filter((x) => x.aspectConstraint?.aspectRequired).map((x) => ({
    name: x.localizedAspectName, mode: x.aspectConstraint?.aspectMode, values: list(x.aspectValues).map((v) => v.localizedValue).slice(0, 60),
    variation: Boolean(x.aspectConstraint?.aspectEnabledForVariations)
  }));
  return { id: c.categoryId, name: c.categoryName, required };
}

/** Item specifics eBay requires: Brand/MPN defaults, the options, then the AI (if switched on) or the closest listed value. */
async function aspects(l, cat) {
  const out = { Brand: ['Unbranded'], MPN: ['Does Not Apply'] };
  const missing = cat.required.filter((x) => !out[x.name]);
  if (!missing.length) return out;
  const text = `${l.title}\n${String(l.description || '').slice(0, 1500)}`;
  let ai = null;
  try {
    const props = Object.fromEntries(missing.map((x) => [x.name, { type: 'string', description: x.values.length && x.mode === 'SELECTION_ONLY' ? `One of: ${x.values.join(' | ')}` : (x.values.length ? `e.g. ${x.values.slice(0, 12).join(', ')}` : 'Short value') }]));
    ai = await require('./ai').structured({
      system: 'You fill eBay item specifics for a product. Use only facts from the product text; when unknown pick the most generic fitting value. Answer in English.',
      name: 'item_specifics', schema: { type: 'object', properties: props, required: Object.keys(props) }, text, maxTokens: 800, kind: 'ebay'
    });
  } catch { ai = null; }
  const low = text.toLowerCase();
  for (const x of missing) {
    let v = ai && String(ai[x.name] || '').trim();
    if (x.mode === 'SELECTION_ONLY' && x.values.length) v = x.values.find((o) => o.toLowerCase() === String(v || '').toLowerCase()) || x.values.find((o) => low.includes(o.toLowerCase())) || x.values[0];
    if (!v) v = x.values.find((o) => low.includes(o.toLowerCase())) || (/type/i.test(x.name) ? (cat.name || 'Other') : 'Does Not Apply');
    out[x.name] = [String(v).slice(0, 65)];
  }
  return out;
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function description(l) {
  const paras = String(l.description || l.title).split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0, 30);
  const from = l.cj_from && l.cj_from !== 'CN' ? `<p><b>Ships from a warehouse in ${esc(require('../countries').countryName?.(l.cj_from) || l.cj_from)}</b> — free tracked delivery.</p>` : '';
  const g = require('./gpsr').forListing(l);
  const safety = g ? `<p><b>Safety information</b></p><ul>${g.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><p><b>EU responsible person:</b> ${esc(g.responsible.name)}, ${esc(g.responsible.address)}, ${esc(g.responsible.email)}</p>${g.manufacturer ? `<p><b>Manufacturer:</b> ${esc(g.manufacturer.name)}${g.manufacturer.address ? `, ${esc(g.manufacturer.address)}` : ''}</p>` : ''}` : '';
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">${paras.map((p) => `<p>${esc(p)}</p>`).join('')}${from}${safety}<p>Sold by Kinan · kinan.shop</p></div>`;
}

// ---------------- eBay Store categories: the same departments and sections as the Kinan shop ----------------

const cut30 = (t) => String(t).replace(/\//g, '-').replace(/\s+/g, ' ').trim().slice(0, 30).trim();
/** Where a product goes in the eBay Store: "/Department/Section" (eBay store category path). */
function storePath(l) {
  if (l.sourcing) {
    const D = require('./sourcing').DEPARTMENTS[l.sourcing.dept];
    if (D) return [cut30(D.en), cut30(D.groups[l.collection_group || l.sourcing.group]?.en || Object.values(D.groups)[0].en)];
  }
  if (list(l.collections).includes('christmas')) {
    const g = require('./seasonal').CHRISTMAS.groups[l.collection_group];
    return ['Christmas Shop', cut30(g?.en || 'Gifts')];
  }
  const c = require('./shipping').CATEGORIES.find(([id]) => id === (l.category || 'other'));
  return [cut30(c ? c[1] : 'More'), 'All'];
}
const pathStr = (p) => `/${p.join('/')}`;

/** Make the store categories the products need (Trading API); remembers which exist. No eBay Store → nothing to do. */
async function syncStore() {
  if (!ebay.connected()) return { skipped: 'not connected' };
  const mk = prefs().marketplace;
  const want = new Map();
  for (const l of db.listings.all((x) => x.seller_id === KINAN && x.source === 'cj' && (x.ebay?.listing_id || !eligible(x)))) {
    const [top, sub] = storePath(l); if (!want.has(top)) want.set(top, new Set()); want.get(top).add(sub);
  }
  const read = async () => {
    const r = await ebay.trading('GetStore', '<CategoryStructureOnly>true</CategoryStructureOnly>', { marketplace: mk });
    const cats = ebay.kid(ebay.kid(r, 'Store'), 'CustomCategories');
    return new Map(ebay.kidsOf(cats, 'CustomCategory').map((c) => [ebay.kid(c, 'Name')?.text, { id: ebay.kid(c, 'CategoryID')?.text, kids: new Set(ebay.kidsOf(c, 'ChildCategory').map((k) => ebay.kid(k, 'Name')?.text)) }]));
  };
  let have;
  try { have = await read(); }
  catch (e) { saveState({ store: { has: false, at: now(), error: e.message } }); return { has: false, error: e.message }; }
  const x = ebay.xmlEsc; let added = 0;
  const newTops = [...want].filter(([top]) => !have.has(top) && top !== 'Other');
  if (newTops.length) {
    await ebay.trading('SetStoreCategories', `<Action>Add</Action><StoreCategories>${newTops.map(([top, subs]) => `<CustomCategory><Name>${x(top)}</Name>${[...subs].map((n) => `<ChildCategory><Name>${x(n)}</Name></ChildCategory>`).join('')}</CustomCategory>`).join('')}</StoreCategories>`, { marketplace: mk });
    added += newTops.reduce((a, [, subs]) => a + 1 + subs.size, 0);
  }
  for (const [top, subs] of want) {
    const h = have.get(top); if (!h) continue;
    const miss = [...subs].filter((n) => !h.kids.has(n));
    if (!miss.length) continue;
    await ebay.trading('SetStoreCategories', `<Action>Add</Action><DestinationParentCategoryID>${x(h.id)}</DestinationParentCategoryID><StoreCategories>${miss.map((n) => `<CustomCategory><Name>${x(n)}</Name></CustomCategory>`).join('')}</StoreCategories>`, { marketplace: mk });
    added += miss.length;
  }
  if (added) { await new Promise((r) => setTimeout(r, 1500)); have = await read().catch(() => have); }
  const paths = [...have].flatMap(([top, h]) => [pathStr([top]), ...[...h.kids].map((k) => pathStr([top, k]))]);
  saveState({ store: { has: true, at: now(), paths, tops: have.size, added } });
  if (added) console.log(`[ebay] store categories: ${added} added`);
  return { has: true, added, categories: paths.length };
}
function storeCategoryFor(l) {
  const st = state().store;
  if (!st?.has) return null;
  const p = pathStr(storePath(l));
  return list(st.paths).includes(p) ? [p] : null;
}

/** Put store categories on products already on eBay (background). */
let organizing = false;
async function organize() {
  if (organizing) throw httpError(409, 'Already organising the eBay store');
  organizing = true;
  let done = 0; let failed = 0;
  try {
    const s = await syncStore();
    if (!s.has) return { has: false, error: s.error || s.skipped };
    for (const l of db.listings.all((x) => x.ebay?.listing_id && !eligible(x))) {
      if (l.ebay.store_path === pathStr(storePath(l))) continue;
      try { await listOne(l.id); done++; } catch (e) { failed++; console.warn('[ebay] organise', l.id, e.message); }
    }
  } finally { organizing = false; }
  console.log(`[ebay] store organised: ${done} listing(s) moved into store categories${failed ? `, ${failed} failed` : ''}`);
  return { done, failed };
}

// ---------------- listing ----------------

async function offerFor(sku, body) {
  try { const j = await ebay.api('POST', '/sell/inventory/v1/offer', body, { lang: market().lang }); return j.offerId; }
  catch (e) {
    // eBay did not take the product-safety (GPSR) block: list without it (the safety details stay in the description)
    if (body.regulatory && /regulator|responsible ?person|manufacturer|productSafety/i.test(e.message)) { console.warn('[ebay] GPSR block refused:', e.message); const { regulatory, ...rest } = body; return offerFor(sku, rest); }
    // The offer already exists (listed before): update it
    const have = await ebay.api('GET', '/sell/inventory/v1/offer', undefined, { query: { sku, marketplace_id: body.marketplaceId } }).catch(() => ({}));
    const o = list(have.offers)[0];
    if (!o) throw e;
    await ebay.api('PUT', `/sell/inventory/v1/offer/${o.offerId}`, body, { lang: market().lang });
    return o.offerId;
  }
}

/** Put one Kinan product on eBay (or update it). */
async function listOne(listingId) {
  const l = db.listings.get(listingId);
  const why = eligible(l);
  if (why) throw httpError(400, why);
  const p = prefs(); const m = market(); const mk = p.marketplace;
  const pol = state().policies?.marketplace === mk && state().policies?.env === ebay.env() ? state().policies : await policies();
  const from = String(l.cj_from || 'CN').toUpperCase();
  const loc = await location(from);
  const cat = await category(l);
  const asp = await aspects(l, cat);
  const images = list(l.images).filter((u) => /^https:/.test(u)).slice(0, 12);
  const title = String(l.sourcing?.ebay_title || l.title).replace(/\s+/g, ' ').trim().slice(0, 80);
  const desc = description(l);
  const skus = list(l.skus).filter((s) => s.cj_vid);
  const multi = skus.length > 1 && skus.every((s) => list(s.opts).length);
  const lang = m.lang;
  const fee = await shipFee(l, skus.find((s) => s.stock > 0) || skus[0]);
  const storeCats = storeCategoryFor(l);
  const reg = require('./gpsr').ebayRegulatory(l);
  const listingPolicies = { paymentPolicyId: pol.payment, returnPolicyId: pol.return, fulfillmentPolicyId: from === m.country ? pol.ship_home : pol.ship_outside };
  const offers = {};
  const used = multi ? skus : [skus.find((s) => s.stock > 0) || skus[0]];
  for (const s of used) {
    const key = skuKey(l, s);
    const own = multi ? Object.fromEntries(list(s.opts).map((o) => [String(o.name).slice(0, 40), [String(o.value).slice(0, 65)]])) : {};
    const img = s.image && /^https:/.test(s.image) ? [s.image, ...images.filter((u) => u !== s.image)].slice(0, 12) : images;
    await ebay.api('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(key)}`, {
      availability: { shipToLocationAvailability: { quantity: qtyOf(l, s) } },
      condition: 'NEW',
      product: { title, description: desc, aspects: { ...asp, ...own }, imageUrls: img },
      ...(s.weight_g ? { packageWeightAndSize: { weight: { value: Math.max(0.01, s.weight_g / 1000), unit: 'KILOGRAM' } } } : {})
    }, { lang });
    offers[key] = await offerFor(key, {
      sku: key, marketplaceId: mk, format: 'FIXED_PRICE', availableQuantity: qtyOf(l, s), categoryId: cat.id, listingDescription: desc,
      listingPolicies, merchantLocationKey: loc, pricingSummary: { price: { value: ebayPrice(s.price, fee), currency: m.currency } },
      ...(storeCats ? { storeCategoryNames: storeCats } : {}),
      ...(reg ? { regulatory: reg } : {})
    });
  }
  let listing;
  if (multi) {
    const gk = groupKey(l);
    const names = [...new Set(skus.flatMap((s) => list(s.opts).map((o) => String(o.name).slice(0, 40))))];
    const specs = names.map((n) => ({ name: n, values: [...new Set(skus.map((s) => String(list(s.opts).find((o) => String(o.name).slice(0, 40) === n)?.value || '').slice(0, 65)).filter(Boolean))] }));
    await ebay.api('PUT', `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(gk)}`, {
      title, description: desc, imageUrls: images, aspects: asp, variantSKUs: Object.keys(offers),
      variesBy: { aspectsImageVariesBy: [], specifications: specs }
    }, { lang });
    listing = await ebay.api('POST', '/sell/inventory/v1/offer/publish_by_inventory_item_group', { inventoryItemGroupKey: gk, marketplaceId: mk });
  } else {
    listing = await ebay.api('POST', `/sell/inventory/v1/offer/${Object.values(offers)[0]}/publish`, {});
  }
  const info = { env: ebay.env(), store_path: storeCats ? storeCats[0] : null, listing_id: listing.listingId, marketplace: mk, offers, group: multi ? groupKey(l) : null, category: cat.id, ship_fee: fee, listed_at: now(), synced_at: now(), error: null };
  db.listings.update(l.id, { ebay: info });
  return info;
}

/** Background: list many products (a collection, or picked ones). Progress is kept in state().job */
let running = false;
async function listMany({ collection, ids, limit = 50 } = {}, by = 'admin') {
  if (running) throw httpError(409, 'eBay listing is already running');
  if (!ebay.connected()) throw httpError(409, 'eBay is not connected — press Connect eBay first');
  await syncStore().catch((e) => console.warn('[ebay] store', e.message));
  const todo = candidates({ collection, ids }).sort((a, b) => pathStr(storePath(a)).localeCompare(pathStr(storePath(b)))).slice(0, Math.min(400, Math.max(1, Number(limit) || 50)));
  running = true;
  const job = { started_at: now(), by, total: todo.length, done: 0, listed: 0, failed: 0, errors: [], running: true };
  let same = 0; let lastErr = '';
  saveState({ job });
  try {
    for (const l of todo) {
      try { await listOne(l.id); job.listed += 1; }
      catch (e) {
        job.failed += 1; console.warn('[ebay] list', l.id, e.message);
        job.errors = [...job.errors, { id: l.id, title: l.title.slice(0, 60), error: e.message }].slice(-30);
        db.listings.update(l.id, (x) => ({ ...x, ebay: { ...(x.ebay || {}), error: e.message, tried_at: now() } }));
        if (/not connected|keys are not set|business policies|delivery \(postage\) policy/i.test(e.message)) break; // nothing else will work
        // The same eBay error 5 times in a row is a setup problem, not the products: stop instead of failing all of them
        same = e.message === lastErr ? same + 1 : 1; lastErr = e.message;
        if (same >= 5) { job.stopped = `Stopped: the same eBay error 5 times — ${e.message}`; break; }
      }
      job.done += 1; saveState({ job });
    }
  } finally { running = false; job.running = false; job.finished_at = now(); saveState({ job }); }
  console.log(`[ebay] listed ${job.listed}/${job.total}${job.failed ? `, ${job.failed} failed` : ''}`);
  return job;
}

// ---------------- AI: the best few products of a collection, reviewed and titled for eBay UK ----------------

const SHORTLIST = {
  type: 'object',
  properties: { picks: { type: 'array', items: { type: 'integer' }, description: 'Numbers from the list, best first.' } },
  required: ['picks']
};
const REVIEW = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'false if it should NOT go on eBay UK: brand/character/logo or copied design, unsafe or regulated (weapons, medical claims, mains plugs that are not UK, loose button batteries for children), adult, poor or misleading photos, watermarks/Chinese text on the main photo, or low value that will get bad reviews.' },
    score: { type: 'integer', description: '1–10: how well this will sell on eBay UK this Christmas (demand, gift appeal, photo quality, value for the price, low return risk).' },
    reason: { type: 'string', description: 'One short sentence: why.' },
    ebay_title: { type: 'string', description: 'eBay UK title, max 80 characters, British English. Lead with the words UK shoppers search most (use the Google searches given when they fit), then the key features (size, material, quantity, colour). Title Case. No brand names, no ALL CAPS, no symbols or emojis, no "free shipping", no "2024/2025", no words that are not true of the product.' }
  },
  required: ['ok', 'score', 'reason', 'ebay_title']
};

/** Pick the best `n` products of a collection for eBay UK (AI review of details and photos), give each an eBay title with the
 *  best search words, and list them. */
async function bestPicks({ collection = 'christmas', n = 5, list: doList = true } = {}) {
  if (!ebay.connected()) throw httpError(409, 'eBay is not connected — press Connect eBay first');
  const ai = require('./ai');
  if (!ai.enabled()) throw httpError(503, 'The AI assistant is not switched on');
  n = Math.min(20, Math.max(1, Math.floor(Number(n) || 5)));
  const home = market().country;
  const info = (l) => {
    const s = [...list(l.skus)].filter((k) => k.stock > 0).sort((a, b) => a.price - b.price)[0] || {};
    const margin = s.cost_sale ? Math.round((1 - s.cost_sale / s.price) * 100) : null;
    return { s, margin, photos: list(l.images).filter((u) => /^https:/.test(u)).length, stock: list(l.skus).reduce((a, k) => a + (Number(k.stock) || 0), 0) };
  };
  // Rule-based first cut: ships from the eBay site's own country, enough photos, stock, margin, the sourcing AI's quality mark
  const pool = candidates({ collection }).map((l) => {
    const x = info(l);
    const from = String(l.cj_from || 'CN').toUpperCase();
    const sc = (from === home ? 3 : 1) + Math.min(x.photos, 6) / 3 + Math.min(x.stock, 50) / 50 + (x.margin != null ? Math.min(x.margin, 60) / 30 : 0.5)
      + (Number(l.sourcing?.quality) || 5) / 3 + (Number(l.rating) || 0) / 5;
    return { l, x, from, sc };
  }).filter((c) => c.x.photos >= 2 && c.x.s.price > 0).sort((a, b) => b.sc - a.sc).slice(0, 40);
  if (!pool.length) throw httpError(404, `No ${collection} products are ready for eBay`);
  const sys = 'You are the senior eBay UK merchandiser of Kinan, an online shop. You choose products that sell well on eBay UK in the Christmas season and you are strict about quality, safety and eBay rules.';
  let order = pool.map((_, i) => i);
  try {
    const r = await ai.structured({
      system: sys, name: 'shortlist', schema: SHORTLIST, kind: 'ebay', maxTokens: 300, timeoutMs: 45000,
      text: `Shortlist the ${Math.min(pool.length, n * 3)} products most likely to sell on eBay UK for Christmas ${new Date().getFullYear()}. They must be varied: never two of the same kind of product (e.g. only one gift-box set, one string-lights item).\n` +
        pool.map((c, i) => `${i}. ${c.l.title.slice(0, 110)} · £${c.x.s.price} · ships from ${c.from} · ${c.x.photos} photos${c.x.margin != null ? ` · margin ${c.x.margin}%` : ''}`).join('\n')
    });
    const seen = new Set(); const p = (r.picks || []).map(Number).filter((i) => pool[i] && !seen.has(i) && seen.add(i));
    if (p.length >= n) order = [...p, ...order.filter((i) => !seen.has(i))];
  } catch (e) { console.warn('[ebay] best picks shortlist:', e.message); }
  const kw = require('./keywords');
  const reviewed = [];
  for (const i of order.slice(0, Math.min(pool.length, n * 3))) {
    const c = pool[i]; const l = c.l;
    if (kw.connected()) await kw.improve(l.id).catch((e) => console.warn('[ebay] best picks keywords:', e.message));
    const fresh = db.listings.get(l.id);
    const searches = list(fresh.kw_stats?.top).slice(0, 8).map((t) => `${t.text} (${t.volume}/month)`);
    try {
      const d = await ai.structured({
        system: sys, name: 'ebay_review', schema: REVIEW, kind: 'ebay', maxTokens: 500, timeoutMs: 60000, images: list(fresh.images).filter((u) => /^https:/.test(u)).slice(0, 4),
        text: `Product: ${fresh.title}\nPrice on eBay: about £${c.x.s.price} with free UK delivery\nShips from: ${c.from}\nOptions: ${[...new Set(list(fresh.skus).map((k) => k.props).filter(Boolean))].slice(0, 12).join(', ') || 'one'}\n` +
          `${searches.length ? `What UK shoppers search on Google: ${searches.join('; ')}\n` : ''}Search words: ${list(fresh.keywords).filter((k) => /^[\x20-\x7E]+$/.test(k)).slice(0, 15).join(', ')}\nDetails:\n${String(fresh.description || '').replace(/<[^>]+>/g, ' ').slice(0, 1500)}`
      });
      let title = String(d.ebay_title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (title === title.toLowerCase()) title = title.replace(/\b([a-z])/g, (c) => c.toUpperCase()); // eBay titles read better in Title Case
      reviewed.push({ id: l.id, ok: d.ok !== false && title.length >= 20, score: Number(d.score) || 0, reason: String(d.reason || '').slice(0, 200), title, was: fresh.title });
    } catch (e) { console.warn('[ebay] best picks review:', l.id, e.message); }
  }
  // Varied picks: skip one that is the same kind of product as a better one already chosen (e.g. two gift-box sets)
  const kw2 = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !/^(christmas|xmas|festive|holiday|gift|gifts|decoration|decorations|set|pcs|with|for)$/.test(w)).map((w) => w.replace(/(es|s)$/, '')));
  const alike = (a, b) => { const A = kw2(a); const B = kw2(b); const both = [...A].filter((w) => B.has(w)).length; return both >= 2 && both / Math.min(A.size || 1, B.size || 1) >= 0.34; };
  const chosen = [];
  for (const x of reviewed.filter((r) => r.ok).sort((a, b) => b.score - a.score)) { if (chosen.length >= n) break; if (!chosen.some((c) => alike(c.was, x.was) || alike(c.title, x.title))) chosen.push(x); }
  for (const x of chosen) { const l = db.listings.get(x.id); db.listings.update(x.id, { sourcing: { ...(l.sourcing || {}), ebay_title: x.title, ebay_pick: { at: now(), score: x.score, reason: x.reason } } }); }
  for (const x of reviewed) console.log(`[ebay] best picks: ${x.ok && chosen.includes(x) ? 'PICK' : x.ok ? 'next' : 'NO  '} ${x.score}/10 ${x.id} "${x.title}" — ${x.reason}`);
  saveState({ best_picks: { at: now(), collection, picks: chosen, rejected: reviewed.filter((x) => !chosen.includes(x)).slice(0, 20) } });
  if (doList && chosen.length) await listMany({ ids: chosen.map((x) => x.id), limit: chosen.length }, 'ai');
  return { picks: chosen, reviewed: reviewed.length };
}

/** At start-up: EBAY_AUTOPICK=christmas:5 runs bestPicks once for that value (lets the owner ask for it without the admin). */
async function autopick() {
  const v = String(process.env.EBAY_AUTOPICK || '').trim();
  if (!v || state().autopick_done === v || !ebay.connected()) return;
  saveState({ autopick_done: v });
  const [collection, n] = v.split(':');
  try { const r = await bestPicks({ collection: collection || 'christmas', n: Number(n) || 5 }); console.log(`[ebay] autopick ${v}: ${r.picks.length} picked from ${r.reviewed} reviewed`); }
  catch (e) { console.warn('[ebay] autopick:', e.message); }
}

/** Take a product off eBay. */
async function endOne(listingId) {
  const l = db.listings.get(listingId);
  if (!l?.ebay?.listing_id) throw httpError(404, 'This product is not on eBay');
  if (l.ebay.group) await ebay.api('POST', '/sell/inventory/v1/offer/withdraw_by_inventory_item_group', { inventoryItemGroupKey: l.ebay.group, marketplaceId: l.ebay.marketplace });
  else for (const id of Object.values(l.ebay.offers || {})) await ebay.api('POST', `/sell/inventory/v1/offer/${id}/withdraw`, {});
  db.listings.update(l.id, { ebay: { ...l.ebay, listing_id: null, ended_at: now() } });
  return { ended: true };
}

// ---------------- price & stock ----------------

async function sync() {
  if (!ebay.connected()) return { skipped: 'not connected' };
  const live = db.listings.all((l) => l.ebay?.listing_id);
  const reqs = [];
  for (const l of live) {
    for (const [key, offerId] of Object.entries(l.ebay.offers || {})) {
      const s = list(l.skus).find((x) => skuKey(l, x) === key);
      const q = s && (prefs().from.includes(String(l.cj_from || 'CN').toUpperCase())) ? qtyOf(l, s) : 0;
      let price; try { price = s ? ebayPrice(s.price, l.ebay.ship_fee) : null; } catch { price = null; }
      reqs.push({ sku: key, shipToLocationAvailability: { quantity: q }, offers: [{ offerId, availableQuantity: q, ...(price ? { price: { value: price, currency: MARKETS[l.ebay.marketplace]?.currency || market().currency } } : {}) }] });
    }
  }
  let ok = 0; let failed = 0;
  for (let i = 0; i < reqs.length; i += 25) {
    try {
      const j = await ebay.api('POST', '/sell/inventory/v1/bulk_update_price_quantity', { requests: reqs.slice(i, i + 25) });
      for (const r of list(j.responses)) (r.statusCode >= 200 && r.statusCode < 300 ? ok++ : failed++);
    } catch (e) { failed += Math.min(25, reqs.length - i); console.warn('[ebay] sync', e.message); }
  }
  saveState({ last_sync: { at: now(), items: reqs.length, ok, failed } });
  return { items: reqs.length, ok, failed };
}

// ---------------- orders ----------------

function buyer() {
  let u = db.users.find((x) => x.id === 'usr_ebay');
  if (!u) u = db.users.insert({ id: 'usr_ebay', email: null, name: 'eBay buyers', role: 'buyer', status: 'active', pass: null, system: true });
  return u;
}

function findSku(key) {
  const m = /^K-([0-9a-f]+)-/.exec(String(key || ''));
  if (!m) return null;
  const l = db.listings.get(`lst_${m[1]}`);
  const s = l && list(l.skus).find((x) => skuKey(l, x) === key);
  return s ? { l, s } : null;
}

function addressOf(o) {
  const t = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
  const a = t.contactAddress || {};
  return {
    name: String(t.fullName || o.buyer?.username || 'eBay buyer').slice(0, 200), phone: String(t.primaryPhone?.phoneNumber || '0000000000').slice(0, 30),
    country_code: String(a.countryCode || '').toUpperCase(), city: String(a.city || '').slice(0, 200), line1: String(a.addressLine1 || '').slice(0, 200),
    line2: String(a.addressLine2 || '').slice(0, 200), postal_code: String(a.postalCode || '').slice(0, 20), state: String(a.stateOrProvince || '').slice(0, 200)
  };
}

/** Paid eBay orders → Kinan orders (CJ then buys and ships them). Buyers hear from eBay, not from Kinan. */
async function importOrders() {
  if (!ebay.connected()) return { skipped: 'not connected' };
  const orders = require('./orders'); const { countryName } = require('../countries');
  const since = new Date(Math.max(state().orders_since || 0, now() - 30 * 86400e3)).toISOString();
  const j = await ebay.api('GET', '/sell/fulfillment/v1/order', undefined, { query: { filter: `creationdate:[${since}..],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`, limit: '100' } });
  let added = 0; const problems = [];
  for (const eo of list(j.orders)) {
    if (eo.orderPaymentStatus !== 'PAID' || eo.cancelStatus?.cancelState === 'CANCELED') continue;
    if (db.orders.find((x) => x.ebay?.order_id === eo.orderId)) continue;
    const lines = []; const unknown = [];
    for (const li of list(eo.lineItems)) {
      const hit = findSku(li.sku);
      if (!hit) { unknown.push(li.sku || li.title); continue; }
      const { l, s } = hit;
      lines.push({
        line_no: String(lines.length + 1), listing_id: l.id, seller_id: l.seller_id, mp_id: l.mp_id, mp_sku_id: s.mp_sku_id, title: l.title, props: s.props,
        direct: true, source: 'cj', source_link: l.source_link || '', cj_pid: l.cj_pid, cj_vid: s.cj_vid, cj_from: l.cj_from || 'CN', cost_sale: s.cost_sale ?? null,
        image: list(l.images)[0] || null, qty: Number(li.quantity) || 1, price: s.price, cost_cny: s.cost_cny, ebay_line_item: li.lineItemId
      });
    }
    if (!lines.length || unknown.length) { problems.push({ order: eo.orderId, error: `Unknown eBay SKU: ${unknown.join(', ')}` }); continue; }
    const address = addressOf(eo); address.country = countryName(address.country_code) || address.country_code;
    const subtotal = money(lines.reduce((a, x) => a + x.price * x.qty, 0));
    const cjShip = await require('./cj').quote(lines.map((x) => ({ listing_id: x.listing_id, mp_sku_id: x.mp_sku_id, qty: x.qty })), address.country_code).catch(() => null);
    const total = eo.pricingSummary?.total || {};
    const o = db.orders.insert({
      buyer_id: buyer().id, channel: 'ebay', lines, currency: config.currency, subtotal, shipping_fee: 0, packaging: 'standard', packaging_fee: 0, hold: false, total: subtotal,
      shipping_address: address, ...(cjShip ? { cj_shipping: { method: cjShip.method, methods: cjShip.methods || {}, origins: cjShip.origins || {}, fee: cjShip.fee, days: cjShip.days, estimated: Boolean(cjShip.estimated) } } : {}),
      ebay: { order_id: eo.orderId, buyer: eo.buyer?.username || '', total: total.value || null, currency: total.currency || null, created: eo.creationDate, tracking_sent: [] },
      payment: { provider: 'ebay', intent_id: eo.orderId }, status: 'pending_payment', sub_orders: [], timeline: [{ at: now(), event: 'created', note: `eBay order ${eo.orderId}` }]
    });
    try { await orders.markPaid(o.id, { provider: 'ebay', intent_id: eo.orderId }); added += 1; }
    catch (e) { problems.push({ order: eo.orderId, error: e.message }); }
  }
  saveState((x) => ({ ...x, orders_since: now() - 2 * 86400e3, last_orders: { at: now(), added, problems: problems.slice(-20) } }));
  if (added) console.log(`[ebay] imported ${added} order(s)`);
  if (problems.length) console.warn('[ebay] orders', JSON.stringify(problems.slice(0, 5)));
  return { added, problems };
}

const CARRIERS = [[/royal ?mail/i, 'Royal Mail'], [/dhl/i, 'DHL'], [/dpd/i, 'DPD'], [/gls/i, 'GLS'], [/ups/i, 'UPS'], [/fedex/i, 'FedEx'], [/evri|hermes/i, 'Evri'], [/yun/i, 'YunExpress'], [/yanwen/i, 'Yanwen'], [/4px/i, '4PX'], [/post ?nl|postnl/i, 'PostNL'], [/colissimo|la poste/i, 'Colissimo'], [/poste ?italiane/i, 'PosteItaliane'], [/correos/i, 'Correos'], [/inpost/i, 'InPost'], [/china ?post/i, 'ChinaPost']];
const carrierCode = (c) => (CARRIERS.find(([re]) => re.test(String(c || ''))) || [null, 'Other'])[1];

/** CJ tracking numbers → eBay (once per number). */
async function pushTracking() {
  if (!ebay.connected()) return { skipped: 'not connected' };
  let sent = 0;
  for (const o of db.orders.all((x) => x.ebay?.order_id && !['cancelled', 'refunded'].includes(x.status))) {
    const done = new Set(list(o.ebay.tracking_sent));
    for (const sub of list(o.sub_orders)) {
      for (const t of list(sub.logistics)) {
        if (!t.tracking || done.has(t.tracking)) continue;
        const nos = new Set(list(sub.line_nos).map(String));
        const items = o.lines.filter((x) => x.ebay_line_item && (!nos.size || nos.has(String(x.line_no)) || (x.cj_from || 'CN') === (sub.cj_from || x.cj_from || 'CN')));
        try {
          await ebay.api('POST', `/sell/fulfillment/v1/order/${encodeURIComponent(o.ebay.order_id)}/shipping_fulfillment`, {
            lineItems: items.map((x) => ({ lineItemId: x.ebay_line_item, quantity: x.qty })), shippedDate: new Date().toISOString(),
            shippingCarrierCode: carrierCode(t.carrier || t.method), trackingNumber: String(t.tracking).replace(/\s+/g, '')
          });
          done.add(t.tracking); sent += 1;
        } catch (e) { console.warn('[ebay] tracking', o.ebay.order_id, e.message); }
      }
    }
    if (done.size !== list(o.ebay.tracking_sent).length) db.orders.update(o.id, (x) => ({ ...x, ebay: { ...x.ebay, tracking_sent: [...done] } }));
  }
  return { sent };
}

// ---------------- jobs & admin ----------------

let ticks = 0;
async function tick() {
  if (!ebay.connected()) return;
  ensureEnv();
  ticks += 1;
  await importOrders().catch((e) => console.warn('[ebay] orders', e.message));
  await pushTracking().catch((e) => console.warn('[ebay] tracking', e.message));
  if (prefs().auto_sync && ticks % 4 === 1) await sync().catch((e) => console.warn('[ebay] sync', e.message)); // hourly (tick = 15 min)
}

// ---------------- admin eBay tab: products, prices, profit, orders ----------------

const FEE_PCT = () => Math.max(0, Number(process.env.EBAY_FEE_PCT ?? 12.8)); // eBay UK final value fee (most categories), % of the total
const FEE_FIXED = () => Math.max(0, Number(process.env.EBAY_FEE_FIXED ?? 0.3)); // per order, in the site's currency
const COUNTRY = { GB: 'United Kingdom', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', PL: 'Poland', CZ: 'Czechia', NL: 'Netherlands', BE: 'Belgium', AT: 'Austria', HU: 'Hungary', PT: 'Portugal', IE: 'Ireland', SE: 'Sweden', DK: 'Denmark', CN: 'China' };
const r2 = (v) => Math.round(Number(v) * 100) / 100;

/** One row per Kinan product that is (or could be) on eBay, with the money worked out in the eBay site's currency. */
function products({ filter = 'all' } = {}) {
  ensureEnv();
  const p = prefs(); const m = market(); const cur = m.currency;
  let fx = null; try { fx = rate(cur); } catch { fx = null; }
  const url = (id, mk) => `https://www.${ebay.env() === 'sandbox' ? 'sandbox.' : ''}ebay.${{ EBAY_GB: 'co.uk', EBAY_DE: 'de', EBAY_FR: 'fr', EBAY_IT: 'it', EBAY_ES: 'es' }[mk] || 'co.uk'}/itm/${id}`;
  const rows = db.listings.all((l) => l.seller_id === KINAN && l.source === 'cj' && l.fulfillment === 'direct' && (l.ebay || !eligible(l))).map((l) => {
    const e = l.ebay || {};
    const status = e.listing_id ? 'live' : e.error ? 'failed' : 'ready';
    const ship = Number(e.ship_fee) || 0;
    const variants = list(l.skus).filter((s) => s.cj_vid).map((s) => {
      let price = null; try { price = Number(ebayPrice(s.price, ship)); } catch { price = null; }
      const cost = fx ? (Number(s.cost_sale || 0) + ship) * fx : null; // CJ product + CJ delivery, in the site's currency
      const fees = price != null ? price * FEE_PCT() / 100 + FEE_FIXED() : null;
      const profit = price != null && cost != null ? price - fees - cost : null;
      return { props: s.props || '', stock: s.stock, qty: qtyOf(l, s), kinan_usd: s.price, cj_cost_usd: s.cost_sale, price: price != null ? r2(price) : null, fees: fees != null ? r2(fees) : null, cost: cost != null ? r2(cost) : null, profit: profit != null ? r2(profit) : null, margin_pct: profit != null && price ? Math.round(profit / price * 100) : null };
    });
    const main = [...variants].sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9))[0] || {};
    return {
      id: l.id, title: l.title, image: (l.images || [])[0] || null, kinan_status: l.status, status, error: e.error || null, section: storePath(l).join(' › '), department: storePath(l)[0],
      warehouse: l.cj_from || 'CN', warehouse_name: COUNTRY[l.cj_from] || l.cj_from || 'China', collection: (l.collections || [])[0] || '',
      ebay_id: e.listing_id || null, ebay_url: e.listing_id ? url(e.listing_id, e.marketplace || p.marketplace) : null, category: e.category || null,
      listed_at: e.listed_at || null, synced_at: e.synced_at || null, ship_usd: ship, variants: variants.length, qty: variants.reduce((a, v) => a + (v.qty || 0), 0),
      price: main.price ?? null, profit: main.profit ?? null, margin_pct: main.margin_pct ?? null, cost: main.cost ?? null, fees: main.fees ?? null, all: variants
    };
  }).filter((x) => filter === 'all' || x.status === filter);
  rows.sort((a, b) => a.section.localeCompare(b.section) || ({ live: 0, failed: 1, ready: 2 }[a.status] - { live: 0, failed: 1, ready: 2 }[b.status]) || (b.listed_at || 0) - (a.listed_at || 0));
  const orders = db.orders.all((o) => o.channel === 'ebay').sort((a, b) => b.created_at - a.created_at).slice(0, 200).map((o) => {
    const cost = list(o.sub_orders).reduce((a, s) => a + (Number(s.cj_amount) || 0), 0);
    const total = Number(o.ebay?.total) || 0; const c = o.ebay?.currency || cur;
    let fxo = null; try { fxo = rate(c); } catch { fxo = null; }
    const fees = total ? total * FEE_PCT() / 100 + FEE_FIXED() : 0;
    return {
      id: o.id, ebay_order: o.ebay?.order_id, buyer: o.ebay?.buyer || '', created: o.created_at, status: o.status, currency: c, total, fees: r2(fees),
      cj_cost: cost ? r2(cost * (fxo || 0)) : null, profit: cost && fxo ? r2(total - fees - cost * fxo) : null,
      items: o.lines.map((x) => `${x.qty}× ${x.title}${x.props ? ` (${x.props})` : ''}`).join(', '), country: o.shipping_address?.country_code || '',
      tracking: list(o.sub_orders).flatMap((s) => list(s.logistics).map((t) => t.tracking)).filter(Boolean), tracking_sent: list(o.ebay?.tracking_sent).length
    };
  });
  const live = rows.filter((x) => x.status === 'live');
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, x) => a + x, 0) / arr.length) : 0);
  return {
    currency: cur, fee_pct: FEE_PCT(), fee_fixed: FEE_FIXED(), markup_pct: p.markup_pct, rate: fx,
    summary: {
      live: live.length, ready: rows.filter((x) => x.status === 'ready').length, failed: rows.filter((x) => x.status === 'failed').length,
      avg_margin_pct: avg(live.map((x) => x.margin_pct).filter((x) => x != null)), avg_profit: live.length ? r2(live.reduce((a, x) => a + (x.profit || 0), 0) / live.length) : 0,
      orders: orders.length, sales: r2(orders.reduce((a, o) => a + o.total, 0)), profit: r2(orders.reduce((a, o) => a + (o.profit || 0), 0)),
      warehouses: Object.entries(live.reduce((a, x) => ({ ...a, [x.warehouse_name]: (a[x.warehouse_name] || 0) + 1 }), {})).map(([k, v]) => ({ name: k, n: v }))
    },
    rows, orders
  };
}

function csv() {
  const d = products();
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Kinan ID', 'Title', 'Status', 'Warehouse', `eBay price (${d.currency})`, `eBay fees (${d.currency})`, `Cost incl. delivery (${d.currency})`, `Profit (${d.currency})`, 'Margin %', 'Qty on eBay', 'eBay item', 'eBay link', 'Error'];
  return [head.map(q).join(','), ...d.rows.map((r) => [r.id, r.title, r.status, r.warehouse_name, r.price, r.fees, r.cost, r.profit, r.margin_pct, r.qty, r.ebay_id, r.ebay_url, r.error].map(q).join(','))].join('\n');
}

function status() {
  const s = state();
  if (s.job?.running && !running) { s.job.running = false; s.job.stopped = s.job.stopped || 'Interrupted by a server restart — press List again'; }
  const live = db.listings.all((l) => l.ebay?.listing_id);
  const failed = db.listings.all((l) => l.ebay?.error && !l.ebay?.listing_id && l.status === 'active').slice(0, 30).map((l) => ({ id: l.id, title: l.title.slice(0, 70), error: l.ebay.error }));
  return {
    ...ebay.status(), prefs: prefs(), markets: Object.keys(MARKETS),
    deletion_endpoint: `${config.publicBaseUrl}/webhooks/ebay/deletion`, accept_url: `${config.publicBaseUrl}/oauth/ebay/callback`,
    live: live.length, ready: candidates({}).length, ready_christmas: candidates({ collection: 'christmas' }).length,
    listings: live.slice(0, 200).map((l) => ({ id: l.id, title: l.title.slice(0, 70), ebay_id: l.ebay.listing_id, url: `https://www.${ebay.env() === 'sandbox' ? 'sandbox.' : ''}ebay.${{ EBAY_GB: 'co.uk', EBAY_DE: 'de', EBAY_FR: 'fr', EBAY_IT: 'it', EBAY_ES: 'es' }[l.ebay.marketplace] || 'co.uk'}/itm/${l.ebay.listing_id}` })),
    store: s.store ? { has: s.store.has, error: s.store.error || null, categories: list(s.store.paths).length, at: s.store.at } : null, organizing,
    failed, connect_error: ebay.connected() ? null : s.connect_error || null, job: s.job || null, last_sync: s.last_sync || null, last_orders: s.last_orders || null,
    orders: db.orders.all((o) => o.channel === 'ebay').length
  };
}

function noteError(msg) { saveState({ connect_error: { at: now(), message: String(msg).slice(0, 300) } }); }

module.exports = { ensureEnv, bestPicks, autopick, storePath, syncStore, organize, products, csv, noteError, MARKETS, prefs, savePrefs, status, eligible, candidates, ebayPrice, policies, listOne, listMany, endOne, sync, importOrders, pushTracking, tick, skuKey, findSku, carrierCode, _running: () => running };
