'use strict';
/**
 * AliExpress catalog builder — the same rules as the CJ one (sourcing.js):
 *  (delivery: at most `max_days`, 14 by default)
 *  1. searches AliExpress (dropshipping search) with the same department keywords, most-ordered first
 *  2. keeps only products that reach the customer in at most `max_days` (10) days — the fastest delivery option
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

function state() { return db.settings.get(SID) || {}; }
function save(patch) { const s = db.settings.get(SID); return s ? db.settings.update(SID, typeof patch === 'function' ? patch : { ...patch }) : db.settings.insert({ id: SID, ...(typeof patch === 'function' ? patch({}) : patch) }); }
function prefs() {
  const p = state().prefs || {};
  return {
    enabled: p.enabled !== false,
    per_run: Math.min(50, Math.max(1, Math.floor(Number(p.per_run) || 12))),
    per_day: Math.min(500, Math.max(0, Math.floor(Number(p.per_day ?? 60)))),
    max_days: Math.min(30, Math.max(3, Math.floor(Number(p.max_days) || 14))),
    min_orders: Math.max(0, Math.floor(Number(p.min_orders ?? 200))),
    markup_pct: Math.min(400, Math.max(10, Number(p.markup_pct) || require('./sourcing').prefs().markup_pct)),
    min_cost: Math.max(0, Number(p.min_cost ?? 2)), max_cost: Math.min(300, Math.max(2, Number(p.max_cost) || 40))
  };
}
function savePrefs(b = {}) {
  const cur = state().prefs || {}; const next = { ...cur };
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
  let j;
  try { j = await ask(); } catch (e) { if (!/SEARCH_ERROR|frequen|limit/i.test(e.message)) throw e; await wait(10000); lastSearch = now(); j = await ask(); }
  logShape('search', j);
  return findAll(j, ['itemId', 'item_id', 'product_id', 'productId']).map((x) => ({
    id: String(x.itemId || x.item_id || x.product_id || x.productId),
    title: String(x.title || x.subject || x.product_title || ''),
    orders: num(x.orders, x.lastest_volume, x.volume, x.sales) || 0,
    price: num(x.targetSalePrice, x.salePrice, x.target_sale_price, x.sale_price, x.app_sale_price),
    rating: num(x.evaluateRate, x.evaluate_rate, x.score)
  })).filter((x) => /^\d{9,20}$/.test(x.id));
}

/** The fastest delivery of one option (sku) to a country: { days, fee, from, method } or null. */
async function freight(productId, skuId, country) {
  const ae = require('../aliexpress/client'); const tok = await require('./aliexpress').token();
  const j = await ae.call('aliexpress.ds.freight.query', { queryDeliveryReq: { quantity: 1, shipToCountry: country, productId, selectedSkuId: skuId, language: 'en_US', currency: String(config.currency).toUpperCase(), locale: 'en_US' } }, tok);
  logShape('freight', j);
  const opts = findAll(j, ['max_delivery_days', 'maxDeliveryDays', 'delivery_date_desc', 'code']).map((o) => ({
    days: num(o.max_delivery_days, o.maxDeliveryDays, o.guaranteed_delivery_days),
    // "shipping_fee_cent" is sent in currency units ("1.99"), despite its name; free shipping → 0
    fee: o.free_shipping === true ? 0 : (num(o.shipping_fee_format, o.shipping_fee, o.shippingFee) ?? (String(o.shipping_fee_cent ?? '').includes('.') ? num(o.shipping_fee_cent) : (num(o.shipping_fee_cent) ?? 0) / 100) ?? 0),
    from: String(o.ship_from_country || o.shipFromCountry || '').toUpperCase() || null, method: String(o.code || o.company || '')
  })).filter((o) => o.days);
  opts.sort((a, b) => a.days - b.days || a.fee - b.fee);
  return opts[0] || null;
}

let running = false; let stopAsked = false;

/** One run: add up to `count` AliExpress products to Kinan's shop. */
async function run({ count } = {}, by = 'auto') {
  if (running) return { skipped: 'running' };
  const aes = require('./aliexpress'); const src = require('./sourcing');
  if (!aes.status().connected) return { skipped: 'AliExpress account not connected' };
  const p = prefs();
  const today = new Date().toISOString().slice(0, 10);
  const s0 = state(); const doneToday = s0.day === today ? s0.day_added || 0 : 0;
  const target = Math.min(Number(count) || p.per_run, Math.max(0, p.per_day - doneToday));
  if (!target) return { skipped: 'daily limit reached' };
  running = true; stopAsked = false;
  const kinan = require('./buyforme').systemSeller();
  const have = new Set(db.listings.all((l) => l.ae_product_id).map((l) => String(l.ae_product_id)));
  // products refused under different rules (delivery days, price range) get a second look when the rules change
  const rules = `${p.max_days}|${p.min_cost}|${p.max_cost}|${p.min_orders}`;
  const tried = new Set(s0.rules === rules ? list(s0.tried) : []);
  if (s0.rules !== rules) save({ rules, tried: [] });
  const st = { started_at: now(), by, added: 0, checked: 0, skipped: 0, reasons: {}, by_dept: {}, running: true };
  const added = [];
  const skip = (why, id) => { st.skipped++; st.reasons[why] = (st.reasons[why] || 0) + 1; if (id) tried.add(id); };
  const q = src.queue(src.prefs());
  const start = Number(s0.cursor) || 0; let fails = 0;
  try {
    for (let qi = 0; qi < q.length && st.added < target && !stopAsked; qi++) {
      const item = q[(start + qi) % q.length];
      save({ cursor: (start + qi + 1) % q.length });
      let found;
      try { found = await search(item.kw, 'GB'); fails = 0; } catch (e) {
        // one keyword AliExpress cannot search: skip it; several in a row: stop until the next run
        fails++; console.warn('[ae-sourcing] search', item.kw, e.message);
        if (fails >= 5) { st.error = `AliExpress search: ${e.message}`; break; }
        continue;
      }
      for (const c of found.filter((x) => !have.has(x.id) && !tried.has(x.id) && x.orders >= p.min_orders).slice(0, 4)) {
        if (st.added >= target || stopAsked) break;
        st.checked++;
        let prod;
        try { prod = await aes.fetchProduct(c.id, 'GB'); } catch (e) { skip('product details not available', c.id); continue; }
        const inStock = prod.skus.filter((s) => s.stock >= 5);
        if (!inStock.length) { skip('out of stock', c.id); continue; }
        const cost = Math.min(...inStock.map((s) => s.cost_sale));
        if (cost < p.min_cost || cost > p.max_cost) { skip('price outside range', c.id); continue; }
        if (prod.images.length < 3) { skip('too few photos', c.id); continue; }
        // fastest delivery among up to 4 options (the "ships from" choice is an option on AliExpress)
        let gb = null; let eu = null;
        try {
          for (const s of inStock.slice(0, 4)) {
            const f = await freight(c.id, s.ae_sku_id, 'GB'); if (f && (!gb || f.days < gb.days)) gb = { ...f, sku: s.mp_sku_id };
            if (gb && gb.days <= p.max_days) break;
          }
          const eus = inStock.find((s) => s.mp_sku_id === gb?.sku) || inStock[0];
          eu = await freight(c.id, eus.ae_sku_id, 'DE');
        } catch (e) { skip('delivery check failed', c.id); console.warn('[ae-sourcing] freight', c.id, e.message); continue; }
        if (!gb || gb.days > p.max_days) { skip(`no UK delivery in ${p.max_days} days`, c.id); continue; }
        // add (not visible until the AI keeps it)
        let l;
        try { l = await aes.publish(kinan, { link: c.id }); } catch (e) { skip(`import failed: ${e.message.slice(0, 60)}`, c.id); continue; }
        db.listings.update(l.id, (x) => ({ ...x, status: 'pending_review', ae_from: gb.from || null, skus: x.skus.map((s) => ({ ...s, price: money(Math.max(0.5, s.cost_sale * (1 + p.markup_pct / 100))) })) }));
        const d = await src.curate(db.listings.get(l.id), item);
        if (!d || d.error) { db.listings.remove(l.id); skip(d?.error ? 'AI not reachable' : 'AI is off', null); if (!d) { st.error = 'The AI is off — AliExpress products wait for the AI review'; stopAsked = true; } continue; }
        const minQ = src.prefs().min_quality;
        if (!d.keep || !d.photos_ok || (Number(d.quality) || 0) < minQ) { db.listings.remove(l.id); skip(!d.photos_ok ? 'AI: photos not good enough' : !d.keep ? 'AI: not a good product' : 'AI: quality too low', c.id); continue; }
        if (src.applyPhotos(l.id, d) < 2) { db.listings.remove(l.id); skip('AI: fewer than 2 clean photos', c.id); continue; }
        const D = src.DEPARTMENTS;
        const [dept, group] = /:/.test(d.section || '') && D[d.section.split(':')[0]]?.groups[d.section.split(':')[1]] ? d.section.split(':') : [D[d.department] ? d.department : item.dept, item.group];
        const sec = D[dept].groups[group] ? group : Object.keys(D[dept].groups)[0];
        db.listings.update(l.id, (x) => ({
          ...x, status: 'active', review: { state: 'approved', decided_at: now(), decided_by: 'ai' }, collections: [dept], collection_group: sec, category: D[dept].category, ae_auto: true, auto_added_at: now(),
          ...(list(d.keywords).length ? { keywords: list(d.keywords).slice(0, 12) } : {}),
          sourcing: { source: 'aliexpress', dept, group: sec, keyword: item.kw, orders: c.orders, rating: c.rating, from: gb.from, cost, at: now(), gb_days: gb.days, gb_fee: gb.fee, eu_days: eu?.days || null, eu_fee: eu?.fee ?? null,
            ai: 'ok', quality: Number(d.quality) || null, reason: String(d.reason || '').slice(0, 200), ebay_ok: false, ebay_title: String(d.ebay_title || '').slice(0, 80) }
        }));
        require('./translate').translateListing(l.id).catch(() => {});
        have.add(c.id); st.added++; st.by_dept[dept] = (st.by_dept[dept] || 0) + 1;
        const fresh = db.listings.get(l.id);
        added.push({ id: l.id, title: d.ebay_title || fresh.title, dept, from: gb.from || 'AE', quality: Number(d.quality) || null, eu: eu?.days || null, gb: gb.days, cost, price: Math.min(...fresh.skus.map((s) => s.price)), kw: list(d.keywords).slice(0, 4), listed: null });
        save((x) => ({ ...x, day: today, day_added: (x.day === today ? x.day_added || 0 : 0) + 1 }));
      }
    }
  } finally {
    running = false; st.running = false; st.finished_at = now();
    save((x) => ({ ...x, last: st, tried: [...tried].slice(-3000) }));
  }
  console.log(`[ae-sourcing] done: added ${st.added}, checked ${st.checked}, skipped ${st.skipped} ${JSON.stringify(st.reasons)}${st.error ? ` — ${st.error}` : ''}`);
  if (st.added || st.error) src.telegramReport(st, added, 'Kinan × AliExpress catalog builder');
  return st;
}

async function tick() { if (!prefs().enabled) return null; return run({}, 'auto').catch((e) => console.warn('[ae-sourcing]', e.message)); }
function status() { return { prefs: prefs(), running, last: state().last || null, today: state().day === new Date().toISOString().slice(0, 10) ? state().day_added || 0 : 0 }; }
function stop() { stopAsked = true; return status(); }

module.exports = { prefs, savePrefs, run, tick, status, stop, search, freight, findAll, _running: () => running };
