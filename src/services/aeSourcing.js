'use strict';
/**
 * AliExpress catalog builder — the same rules as the CJ one (sourcing.js):
 *  (delivery: at most `max_days`, 21 days by default, to any one checked market)
 *  1. searches AliExpress (dropshipping search) with the same department keywords, most-ordered first
 *  2. keeps only products that reach the customer in at most `max_days` days — the fastest delivery option
 *     of each "ships from" option, for the UK and for Germany (EU)
 *  3. the AI reviews each one (photos + text, quality ≥ min_quality), sorts it into a department, and keeps only clean
 *     photos of the product, best first
 *  4. adds it to Kinan's own shop, live, and reports on Telegram
 */
const db = require('../db');
const { config } = require('../config');

const now = () => Date.now();
const list = (v) => (Array.isArray(v) ? v : []);
const money = (v) => Math.round(Number(v) * 100) / 100;
const SID = 'ae_sourcing';
// destinations checked at import (any one within the limit is enough); the eligibility queue checks every market afterwards
const DELIVERY_MARKETS = ['GB', 'US', 'DE', 'FR', 'ES', 'IT', 'PL', 'MT', 'CA', 'AU', 'NZ'];
const DAILY_TARGET = 1000;
// Owner's rule (23 Nov 2026): at least 99 orders ("99+")
const MIN_SUPPLIER_ORDERS = 99;

function state() { return db.settings.get(SID) || {}; }
function save(patch) { const s = db.settings.get(SID); return s ? db.settings.update(SID, typeof patch === 'function' ? patch : { ...patch }) : db.settings.insert({ id: SID, ...(typeof patch === 'function' ? patch({}) : patch) }); }
function prefs() {
  const p = state().prefs || {};
  return {
    enabled: p.enabled !== false,
    per_run: Math.min(150, Math.max(1, Math.floor(Number(p.per_run) === 50 ? 150 : Number(p.per_run) || 150))),
    per_day: Math.min(DAILY_TARGET, Math.max(0, Math.floor(Number(p.per_day ?? DAILY_TARGET) || 0))),
    max_days: require('./sourcing').deliveryLimit(p.max_days, 3, p.delivery_limit_3w),
    min_orders: p.demand_rule_99 ? Math.max(MIN_SUPPLIER_ORDERS, Math.floor(Number(p.min_orders) || 0)) : MIN_SUPPLIER_ORDERS,
    markup_pct: Math.min(400, Math.max(10, Number(p.markup_pct) || require('./sourcing').prefs().markup_pct)),
    min_cost: Math.max(0, Number(p.min_cost ?? 1)), max_cost: Math.min(300, Math.max(2, Number(p.max_cost) || 40))
  };
}
function savePrefs(b = {}) {
  const cur = state().prefs || {};
  const next = { ...cur, max_days: prefs().max_days, min_orders: prefs().min_orders, delivery_limit_3w: true, demand_rule_99: true };
  for (const k of ['per_run', 'per_day', 'max_days', 'min_orders', 'markup_pct', 'min_cost', 'max_cost']) if (b[k] !== undefined && b[k] !== '') next[k] = Number(b[k]);
  if (b.enabled !== undefined) next.enabled = Boolean(b.enabled);
  save({ prefs: next }); return prefs();
}

/** Every object in a nested AliExpress response that has one of `keys` (their lists come wrapped in many shapes). */
function findAll(v, keys, out = []) {
  if (Array.isArray(v)) { for (const x of v) findAll(x, keys, out); return out; }
  if (v && typeof v === 'object') { if (keys.some((k) => v[k] !== undefined)) out.push(v); else for (const x of Object.values(v)) findAll(x, keys, out); }
  return out;
}
const num = (...v) => { for (const x of v) { const n = Number(String(x ?? '').replace(/[^\d.]/g, '')); if (x !== undefined && x !== null && x !== '' && Number.isFinite(n)) return n; } return null; };

// A supplier's displayed "1,000+" is only evidence of at least 1,000.
// Treat missing, abbreviated and non-numeric counts as unverified.
function supplierOrders(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)\+?$/.test(text)) continue;
    const count = Number(text.replace(/[, +]/g, ''));
    if (Number.isSafeInteger(count)) return count;
  }
  return 0;
}

const logged = {};
function logShape(name, j) { if (logged[name]) return; logged[name] = true; console.log(`[ae-sourcing] ${name} response:`, JSON.stringify(j).slice(0, 1200)); }

/** Dropshipping search, most-ordered first. */
const wait = (ms) => new Promise((r) => setTimeout(r, process.env.NODE_TEST_CONTEXT ? 0 : ms));
let lastSearch = 0;
async function search(kw, country) {
  const ae = require('../aliexpress/client'); const tok = await require('./aliexpress').token();
  // AliExpress refuses searches sent too close together (NGSELECTION_SEARCH_ERROR): at most one every 3 seconds, one retry after 8
  const gap = 3000 - (now() - lastSearch); if (gap > 0) await wait(gap);
  lastSearch = now();
  const ask = () => ae.call('aliexpress.ds.text.search', { keyWord: kw, local: 'en_US', countryCode: country, currency: String(config.currency).toUpperCase(), pageSize: 30, pageIndex: 1, sortBy: 'orders,desc' }, tok);
  const j = await ask(); // the client already retries once after a "too frequent" or search error
  logShape('search', j);
  return findAll(j, ['itemId', 'item_id', 'product_id', 'productId']).map((x) => ({
    id: String(x.itemId || x.item_id || x.product_id || x.productId),
    title: String(x.title || x.subject || x.product_title || ''),
    orders: supplierOrders(x.orders, x.lastest_volume, x.volume, x.sales),
    price: num(x.targetSalePrice, x.salePrice, x.target_sale_price, x.sale_price, x.app_sale_price),
    rating: num(x.evaluateRate, x.evaluate_rate, x.score)
  })).filter((x) => /^\d{9,20}$/.test(x.id));
}

/** AliExpress's ready-made product feeds (bestsellers, fast delivery, local warehouses…), refreshed daily. */
async function feeds() {
  const c = state().feeds;
  if (c && now() - c.at < (c.list.length ? 24 : 3) * 3600e3) return c.list; // no feeds yet (app in Test): ask again in 3 hours
  const ae = require('../aliexpress/client'); const tok = await require('./aliexpress').token();
  const j = await ae.call('aliexpress.ds.feedname.get', {}, tok);
  logShape('feednames', j);
  const all = findAll(j, ['promo_name']).map((x) => ({ name: String(x.promo_name), count: num(x.product_num) || 0, desc: String(x.promo_desc || '') }));
  // fast and local ones first: UK / Europe / fast delivery / Choice
  const rank = (f) => (/(\buk\b|gb|united kingdom|britain)/i.test(f.name + f.desc) ? 4 : 0) + (/fast|express|local|warehouse|overseas|3 ?days|5 ?days|7 ?days/i.test(f.name + f.desc) ? 3 : 0) + (/choice|plaza|europe|\beu\b/i.test(f.name + f.desc) ? 2 : 0) + (/best ?sell|top|hot/i.test(f.name + f.desc) ? 1 : 0);
  const pick = all.filter((f) => rank(f) > 0 && f.count > 0).sort((a, b) => rank(b) - rank(a) || b.count - a.count).slice(0, 12);
  console.log('[ae-sourcing] feeds:', JSON.stringify(pick.map((f) => `${f.name} (${f.count})`)));
  save({ feeds: { at: now(), list: pick } });
  return pick;
}
async function feedItems(name, page) {
  const ae = require('../aliexpress/client'); const tok = await require('./aliexpress').token();
  const j = await ae.call('aliexpress.ds.recommend.feed.get', { feed_name: name, country: 'GB', target_currency: String(config.currency).toUpperCase(), target_language: 'EN', page_size: 50, page_no: page, sort: 'volumeDesc' }, tok);
  logShape('feed', j);
  return findAll(j, ['product_id']).map((x) => ({ id: String(x.product_id), title: String(x.product_title || ''), orders: supplierOrders(x.lastest_volume, x.volume), price: num(x.target_sale_price, x.sale_price), rating: num(x.evaluate_rate) })).filter((x) => /^\d{9,20}$/.test(x.id));
}

/** The fastest delivery of one option (sku) to a country: { days, fee, from, method } or null. */
async function freight(productId, skuId, country) {
  const ae = require('../aliexpress/client'); const tok = await require('./aliexpress').token();
  const j = await ae.call('aliexpress.ds.freight.query', { queryDeliveryReq: { quantity: 1, shipToCountry: country, productId, selectedSkuId: skuId, language: 'en_US', currency: String(config.currency).toUpperCase(), locale: 'en_US' } }, tok);
  logShape('freight', j);
  // look for the delivery options themselves (the envelope also has a "code", so that key must not be used to find them)
  const opts = findAll(j, ['max_delivery_days', 'maxDeliveryDays', 'min_delivery_days', 'delivery_date_desc']).map((o) => ({
    days: num(o.max_delivery_days, o.maxDeliveryDays, o.guaranteed_delivery_days), min: num(o.min_delivery_days, o.minDeliveryDays),
    // "shipping_fee_cent" is sent in currency units ("1.99"), despite its name; free shipping → 0
    fee: o.free_shipping === true ? 0 : (num(o.shipping_fee_format, o.shipping_fee, o.shippingFee) ?? (String(o.shipping_fee_cent ?? '').includes('.') ? num(o.shipping_fee_cent) : (num(o.shipping_fee_cent) ?? 0) / 100) ?? 0),
    from: String(o.ship_from_country || o.shipFromCountry || '').toUpperCase() || null, method: String(o.code || o.company || '')
  })).filter((o) => o.days);
  opts.sort((a, b) => a.days - b.days || a.fee - b.fee);
  return opts[0] || null;
}

let running = false;
let activeRun = null; let stopAsked = false;

/** One run: add up to `count` AliExpress products to Kinan's shop. */
async function run({ count } = {}, by = 'auto') {
  if (running) return { skipped: 'running' };
  const aes = require('./aliexpress'); const src = require('./sourcing');
  if (!aes.status().connected) return { skipped: 'AliExpress account not connected' };
  const p = prefs();
  const today = new Date().toISOString().slice(0, 10);
  const s0 = state(); const doneToday = s0.day === today ? s0.day_added || 0 : 0;
  const target = Math.min(150, Math.max(0, Math.floor(Number(count) || p.per_run)), Math.max(0, p.per_day - doneToday));
  if (!target) return { skipped: 'daily limit reached' };
  running = true; stopAsked = false;
  const kinan = require('./buyforme').systemSeller();
  const have = new Set(db.listings.all((l) => l.ae_product_id).map((l) => String(l.ae_product_id)));
  // products refused under different rules (delivery days, price range) get a second look when the rules change
  const rules = `v4-any-market|${DELIVERY_MARKETS.join(",")}|${p.max_days}|${p.min_cost}|${p.max_cost}|${p.min_orders}`;
  const tried = new Set(s0.rules === rules ? list(s0.tried) : []);
  if (s0.rules !== rules) save({ rules, tried: [] });
  const st = { started_at: now(), by, target, added: 0, checked: 0, skipped: 0, reasons: {}, by_dept: {}, last: [], running: true };
  activeRun = st;
  const added = [];
  let cur = {}; // what is known about the product being checked, for the log
  const skip = (why, id) => { st.skipped++; st.reasons[why] = (st.reasons[why] || 0) + 1; if (id) tried.add(id); console.log(`[ae-sourcing] ✗ ${id || cur.id} ${why}${cur.cost != null ? ` · cost ${cur.cost}` : ''}${cur.days ? ` · ${cur.days} days` : ''}`); };
  const q = src.queue(src.prefs());
  const start = Number(s0.cursor) || 0; let fails = 0; let aiFails = 0;
  // where candidates come from: AliExpress's fast/local feeds first (a few pages each run), then the department keywords
  async function* candidates() {
    let fl = []; try { fl = await feeds(); } catch (e) { console.warn('[ae-sourcing] feeds:', e.message); }
    const pages = state().feed_pages || {};
    const general = { kw: '', dept: Object.keys(src.DEPARTMENTS)[0], group: Object.keys(src.DEPARTMENTS[Object.keys(src.DEPARTMENTS)[0]].groups)[0] };
    for (const f of fl) {
      for (let k = 0; k < 2; k++) {
        const pg = (pages[f.name] || 0) + 1;
        let items = [];
        try { items = await feedItems(f.name, pg); } catch (e) { console.warn('[ae-sourcing] feed', f.name, e.message); break; }
        for (const c of items.filter((x) => !have.has(x.id) && !tried.has(x.id) && x.orders >= p.min_orders)) yield { c, item: { ...general, kw: f.name } };
        pages[f.name] = items.length ? pg : 0;
        save({ feed_pages: pages });
        if (!items.length) break;
      }
    }
    // Keyword search can be refused for the whole app (NGSELECTION_SEARCH_ERROR on every word, seen for days):
    // after two refusals in a row it pauses for 12 hours and the feeds alone are used, instead of spending
    // ~20 s and 4 API calls on every keyword of every run.
    const off = Number(state().search_off_until) || 0;
    if (off > now()) { st.search_paused_until = off; return; }
    for (let qi = 0; qi < q.length; qi++) {
      const item = q[(start + qi) % q.length];
      let found;
      try { found = await search(item.kw, 'GB'); fails = 0; if (state().search_error) save({ search_error: null, search_off_until: 0 }); } catch (e) {
        // one keyword AliExpress cannot search: skip it; two app-wide refusals in a row: pause keyword search
        fails++; console.warn('[ae-sourcing] search', item.kw, e.message);
        if (fails >= 2 && /SEARCH_ERROR/i.test(e.message)) {
          save({ search_off_until: now() + 12 * 3600e3, search_error: String(e.message).slice(0, 120), cursor: (start + qi + 1) % q.length });
          st.search_paused_until = now() + 12 * 3600e3;
          console.warn('[ae-sourcing] keyword search refused by AliExpress — paused 12 h, feeds only');
          return;
        }
        if (fails >= 5) { st.error = `AliExpress search: ${e.message}`; return; }
        save({ cursor: (start + qi + 1) % q.length });
        continue;
      }
      for (const c of found.filter((x) => !have.has(x.id) && !tried.has(x.id) && x.orders >= p.min_orders).slice(0, 4)) yield { c, item };
      save({ cursor: (start + qi + 1) % q.length });
    }
  }
  try {
    for await (const { c, item } of candidates()) {
        if (st.added >= target || stopAsked || new Date().toISOString().slice(0, 10) !== today) break;
        st.checked++; cur = { id: c.id }; st.current = c.title || c.id;
        let prod;
        try { prod = await aes.fetchProduct(c.id, 'GB'); } catch (e) { skip('product details not available', c.id); continue; }
        const inStock = prod.skus.filter((s) => s.stock >= 5);
        if (!inStock.length) { skip('out of stock', c.id); continue; }
        const cost = Math.min(...inStock.map((s) => s.cost_sale)); cur.cost = cost;
        if (cost < p.min_cost || cost > p.max_cost) { skip('price outside range', c.id); continue; }
        if (prod.images.length < 3) { skip('too few photos', c.id); continue; }
        let verified = null;
        let failedMarket = 'GB';
        let gb = null;
        try {
          // Each destination is checked on its own (no all-markets rule): an option is kept when it reaches at least one
          // market within the limit. Every answer is stored per country (services/eligibility.js), so the product can
          // appear in the markets it reaches as soon as it is approved, and nowhere else.
          // only options inside the price range, cheapest first: verifying a pricier option (the old first-4-in-stock
          // rule) spent 11 delivery checks and an import on a product that was then dropped at import time
          for (const sku of inStock.filter((s) => s.cost_sale >= p.min_cost && s.cost_sale <= p.max_cost).sort((a, b) => a.cost_sale - b.cost_sale).slice(0, 4)) {
            if (!sku.ae_sku_id) continue;
            const quotes = {}; const results = {};
            for (const country of DELIVERY_MARKETS) {
              const quote = await freight(c.id, sku.ae_sku_id, require('../countries').supplierCode('aliexpress', country));
              results[country] = quote || null;
              if (country === 'GB' && quote && (!gb || quote.days < gb.days)) gb = quote;
              // per-destination qualification (Admin + daily report): how many reach each market within the limit
              st.markets = st.markets || {}; const mk = st.markets[country] || (st.markets[country] = { checked: 0, passed: 0, failed: 0 });
              mk.checked++;
              if (!quote || quote.days > p.max_days) { mk.failed++; failedMarket = country; continue; }
              mk.passed++;
              quotes[country] = quote;
            }
            if (Object.keys(quotes).length) {
              verified = { skuId: sku.ae_sku_id, quotes, results };
              gb = quotes.GB || Object.values(quotes)[0];
              break;
            }
          }
        } catch (e) {
          skip('delivery check failed', null);
          console.warn('[ae-sourcing] freight', c.id, e.message);
          continue;
        }
        cur.days = gb?.days || null;
        if (gb) { const b = gb.days <= 10 ? '≤10' : gb.days <= 14 ? '11-14' : gb.days <= 20 ? '15-20' : gb.days <= 30 ? '21-30' : '30+'; st.days = st.days || {}; st.days[b] = (st.days[b] || 0) + 1; } else { st.days = st.days || {}; st.days.none = (st.days.none || 0) + 1; }
        if (!verified) { skip(`no delivery in ${p.max_days} days to any checked market`, c.id); continue; }
        const eu = verified.quotes.DE || null;
        // add (not visible until the AI keeps it)
        let l;
        try { l = await aes.publish(kinan, { link: c.id }); } catch (e) { skip(`import failed: ${e.message.slice(0, 60)}`, c.id); continue; }
        const sku = l.skus.find((s) => s.ae_sku_id === verified.skuId && s.stock >= 5);
        if (!sku || sku.cost_sale < p.min_cost || sku.cost_sale > p.max_cost) {
          db.listings.remove(l.id);
          skip('verified option changed during import', null);
          continue;
        }
        db.listings.update(l.id, { status: 'pending_review', ae_from: gb.from || null, skus: [{ ...sku, price: money(Math.max(0.5, sku.cost_sale * (1 + p.markup_pct / 100))) }] });
        const d = await src.curate(db.listings.get(l.id), item);
        if (!d || d.error) {
          db.listings.remove(l.id);
          const limited = d?.status === 429;
          skip(limited ? 'AI rate or quota limit' : d?.error ? 'AI not reachable' : 'AI is off', null);
          aiFails++;
          if (!d || limited || aiFails >= 3) {
            st.error = limited ? 'AI rate or quota limit reached — retrying on a later run' : 'AI unavailable — AliExpress products wait for review';
            stopAsked = true;
            break;
          }
          continue;
        }
        aiFails = 0;
        const minQ = src.prefs().min_quality;
        const reason = src.reviewRejection(l.id, d, minQ);
        require('./localProductReview').recordFull('aliexpress', c.id, l, d, reason);
        if (reason) { db.listings.remove(l.id); skip(reason, c.id); continue; }
        const D = src.DEPARTMENTS;
        const [dept, group] = /:/.test(d.section || '') && D[d.section.split(':')[0]]?.groups[d.section.split(':')[1]] ? d.section.split(':') : [D[d.department] ? d.department : item.dept, item.group];
        const sec = D[dept].groups[group] ? group : Object.keys(D[dept].groups)[0];
        db.listings.update(l.id, (x) => ({
          ...x, status: 'active', review: { state: 'approved', decided_at: now(), decided_by: 'ai' }, collections: [dept], collection_group: sec, category: D[dept].category, ae_auto: true, auto_added_at: now(),
          ...(list(d.keywords).length ? { keywords: list(d.keywords).slice(0, 12) } : {}),
          sourcing: { source: 'aliexpress', dept, group: sec, keyword: item.kw, orders: c.orders, rating: c.rating, from: gb.from, cost, at: now(), gb_days: verified.quotes.GB?.days || null, gb_min: verified.quotes.GB?.min || null, gb_fee: verified.quotes.GB?.fee ?? null, eu_days: eu?.days || null, eu_min: eu?.min || null, eu_fee: eu?.fee ?? null, delivery_by_country: Object.fromEntries(Object.entries(verified.quotes).map(([country, quote]) => [country, { min: quote.min, days: quote.days, fee: quote.fee }])),
            ai: 'ok', quality: Number(d.quality) || null, reason: String(d.reason || '').slice(0, 200), ebay_ok: false, ebay_title: String(d.ebay_title || '').slice(0, 80) }
        }));
        // the delivery answers become eligibility records for this option, one per checked country
        try {
          const E = require('./eligibility'); const kept = db.listings.get(l.id); const ks = kept.skus.find((x) => x.ae_sku_id === verified.skuId) || kept.skus[0];
          const life = E.config().ttl_days;
          for (const [country, q] of Object.entries(verified.results)) {
            const ok = q && Number(q.days) > 0;
            E.writeRecord(l.id, country, ks.mp_sku_id, 'ae_direct', { state: ok ? 'eligible' : 'unavailable', reason: ok ? 'verified' : 'no_route', supplier: 'aliexpress', origin: q?.from || null, method: q?.method || null, min_days: ok ? (Number(q.min) || Number(q.days)) : null, max_days: ok ? Number(q.days) : null, fee: q?.fee ?? null, currency: String(config.currency || 'usd').toUpperCase(), verified_at: now(), expires_at: now() + (ok ? life.eligible : life.unavailable) * 86400e3, attempts: 0, next_retry_at: now() + ((ok ? life.eligible : life.unavailable) - 1) * 86400e3, last_error: null });
          }
        } catch (e) { console.warn('[ae-sourcing] eligibility', e.message); }
        require('./translate').translateListing(l.id).catch(() => {});
        console.log(`[ae-sourcing] ✓ ${c.id} added · cost ${cost} · ${gb.days} days (${Object.keys(verified.quotes).join(', ')})`);
        have.add(c.id); st.added++; st.by_dept[dept] = (st.by_dept[dept] || 0) + 1;
        const fresh = db.listings.get(l.id);
        added.push({ id: l.id, title: d.ebay_title || fresh.title, dept, from: gb.from || 'AE', quality: Number(d.quality) || null, eu: eu?.days || null, gb: verified.quotes.GB?.days || null, cost, price: Math.min(...fresh.skus.map((s) => s.price)), kw: list(d.keywords).slice(0, 4), listed: null });
        st.last = [{ id: l.id, title: fresh.title }, ...st.last].slice(0, 12);
        const addedDay = new Date().toISOString().slice(0, 10);
        save((x) => ({ ...x, day: addedDay, day_added: (x.day === addedDay ? x.day_added || 0 : 0) + 1 }));
    }
  } finally {
    running = false; activeRun = null; st.running = false; st.finished_at = now();
    save((x) => ({ ...x, last: st, tried: [...tried].slice(-3000) }));
  }
  console.log(`[ae-sourcing] done: added ${st.added}, checked ${st.checked}, skipped ${st.skipped} ${JSON.stringify(st.reasons)} fastest UK delivery (days): ${JSON.stringify(st.days || {})} per market (checked/passed): ${Object.entries(st.markets || {}).map(([k, v]) => `${k} ${v.checked}/${v.passed}`).join(', ')}${st.error ? ` — ${st.error}` : ''}`);
  require('./importDigest').record('AliExpress', st, added.map((item) => ({ ...item, status: 'active' })));
  return st;
}

async function tick() { if (!prefs().enabled) return null; return run({}, 'auto').catch((e) => console.warn('[ae-sourcing]', e.message)); }
function status() { return { prefs: prefs(), running, current: activeRun, last: state().last || null, today: state().day === new Date().toISOString().slice(0, 10) ? state().day_added || 0 : 0 }; }
function stop() { stopAsked = true; return status(); }

module.exports = { prefs, savePrefs, run, tick, status, stop, search, freight, feeds, feedItems, findAll, _running: () => running };
