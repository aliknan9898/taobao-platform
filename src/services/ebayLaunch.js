'use strict';
/**
 * eBay launch: check everything on Kinan's eBay account first, then pick the best products, price each one against what
 * other sellers on eBay ask for the same thing (never below the profit floor), list them, and report on Telegram.
 *  - review(): connection, seller registration, selling limits, business policies (payment, returns, free tracked delivery),
 *    exchange rate, AI, products ready for eBay
 *  - competitors(l): eBay search (Browse API) for the same product: how many sellers and at what prices (incl. postage)
 *  - launch({ n }): review → picks → competitor prices → list → report
 */
const db = require('../db');
const ebay = require('../ebay/client');
const E = require('./ebay');

const now = () => Date.now();
const list = (v) => (Array.isArray(v) ? v : []);
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const STATE = 'ebay_launch';
const saveState = (patch) => (db.settings.get(STATE) ? db.settings.update(STATE, patch) : db.settings.insert({ id: STATE, ...patch }));

// ---------------- 1. review the eBay account and Kinan's settings ----------------

async function review() {
  const facts = {}; const blockers = []; const warnings = [];
  const p = E.prefs(); const m = E.market(); const mk = p.marketplace;
  facts.site = mk; facts.currency = m.currency; facts.env = ebay.env();
  if (!ebay.configured()) blockers.push('eBay keys are missing');
  if (!ebay.connected()) { blockers.push('Kinan is not signed in to eBay (press Connect eBay in the admin)'); return { ok: false, blockers, warnings, facts }; }
  facts.account = ebay.status().account;
  if (ebay.env() !== 'production') warnings.push('Connected to the eBay test site (sandbox), not the real eBay');
  // seller registration and selling limits
  try {
    const pr = await ebay.api('GET', '/sell/account/v1/privilege');
    facts.registered = pr.sellerRegistrationCompleted !== false;
    if (pr.sellingLimit) facts.limit = { amount: Number(pr.sellingLimit.amount?.value) || null, currency: pr.sellingLimit.amount?.currency || m.currency, quantity: Number(pr.sellingLimit.quantity) || null };
    if (!facts.registered) blockers.push('eBay says the seller registration is not complete (finish it in eBay Seller Hub)');
  } catch (e) { warnings.push(`Selling limits could not be read: ${e.message}`); }
  // listings already on eBay (they use up the monthly limit)
  try { const inv = await ebay.api('GET', '/sell/inventory/v1/inventory_item', undefined, { query: { limit: '1' } }); facts.inventory_items = Number(inv.total) || 0; } catch (e) { warnings.push(`eBay inventory could not be read: ${e.message}`); }
  facts.live_on_kinan = db.listings.all((l) => l.ebay?.listing_id && (l.ebay.account || 'kinan') === 'kinan').length;
  // business policies
  try {
    const opted = await ebay.api('GET', '/sell/account/v1/program/get_opted_in_programs');
    facts.business_policies = list(opted.programs).some((x) => x.programType === 'SELLING_POLICY_MANAGEMENT');
  } catch (e) { warnings.push(`Programs could not be read: ${e.message}`); }
  try {
    const pol = await E.policies();
    const [ret, ful] = await Promise.all([
      ebay.api('GET', `/sell/account/v1/return_policy/${pol.return}`).catch(() => null),
      ebay.api('GET', `/sell/account/v1/fulfillment_policy/${pol.ship_home}`).catch(() => null)
    ]);
    const svc = ful?.shippingOptions?.[0]?.shippingServices?.[0];
    facts.policies = {
      returns: ret ? (ret.returnsAccepted ? `${ret.returnPeriod?.value} ${String(ret.returnPeriod?.unit || '').toLowerCase()}s, return postage paid by ${String(ret.returnShippingCostPayer || '').toLowerCase()}` : 'no returns') : '?',
      delivery: ful ? `${svc?.freeShipping ? 'free' : 'paid'} ${svc?.shippingServiceCode || '?'}, dispatch within ${ful.handlingTime?.value} day(s)` : '?'
    };
    if (ret && !ret.returnsAccepted) warnings.push('The return policy does not accept returns (UK buyers have 14 days by law)');
    if (ret && Number(ret.returnPeriod?.value) < 14) warnings.push('Returns are shorter than the 14 days UK law gives buyers');
  } catch (e) { blockers.push(`Business policies: ${e.message}`); }
  // money
  try { facts.rate = r2(E.rate(m.currency) * 10000) / 10000; } catch (e) { blockers.push(e.message); }
  facts.vat_pct = E.VAT_PCT(); facts.fee_pct = E.FEE_PCT(); facts.min_margin_pct = E.MIN_MARGIN();
  // products
  const ready = E.candidates({});
  facts.ready = ready.length;
  facts.ready_by_warehouse = ready.reduce((a, l) => ({ ...a, [l.cj_from || 'CN']: (a[l.cj_from || 'CN'] || 0) + 1 }), {});
  if (!ready.length) blockers.push('No Kinan products are ready for eBay (CJ products in a European/UK warehouse, in stock, with photos)');
  facts.ai = require('./ai').enabled();
  if (!facts.ai) warnings.push('The AI assistant is off: picks use the sourcing check instead');
  try { const st = await E.syncStore(); facts.store = st.has ? `eBay Store with ${st.categories} categories` : 'no eBay Store (optional)'; } catch (e) { facts.store = `not checked (${e.message})`; }
  return { ok: !blockers.length, blockers, warnings, facts };
}

// ---------------- 2. competitors on eBay ----------------

const STOP = new Set(['for', 'with', 'and', 'the', 'set', 'pcs', 'pack', 'new', 'of', 'in', 'to', 'a', 'uk', 'gift', 'gifts']);
function query(title, words) {
  return String(title).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w)).slice(0, words).join(' ');
}
const pct = (arr, q) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); const i = (a.length - 1) * q; const lo = Math.floor(i); return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo); };

/** Prices other sellers ask on this eBay site for the same kind of product (new, Buy It Now, price + postage). */
async function competitors(l, title) {
  const mk = E.prefs().marketplace; const m = E.market();
  const run = async (q) => {
    const j = await ebay.api('GET', '/buy/browse/v1/item_summary/search', undefined, { user: false, marketplace: mk, query: { q, filter: `buyingOptions:{FIXED_PRICE},conditions:{NEW},deliveryCountry:${m.country}`, limit: '50' } });
    return { q, total: Number(j.total) || 0, items: list(j.itemSummaries).filter((x) => x.price?.currency === m.currency).map((x) => ({ price: Number(x.price.value) + (Number(x.shippingOptions?.[0]?.shippingCost?.value) || 0), from: x.itemLocation?.country || '', seller: x.seller?.username || '', fb: Number(x.seller?.feedbackScore) || 0 })) };
  };
  let r = await run(query(title, 7));
  if (r.items.length < 6) { const r2x = await run(query(title, 4)); if (r2x.items.length > r.items.length) r = r2x; }
  return r;
}

/** Work out the competitive price of a product and store it (l.ebay_comp); { ok:false } when it cannot be sold at a profit. */
async function pricePlan(l, title) {
  const m = E.market();
  const s = [...list(l.skus)].filter((k) => k.cj_vid && k.stock > 0).sort((a, b) => a.price - b.price)[0];
  if (!s) return { ok: false, why: 'out of stock' };
  const fee = Number(await E.shipFee(l, s)) || Number(l.sourcing?.gb_fee) || 0;
  const base = Number(E.ebayPrice(s.price, fee));
  const cost = (Number(s.cost_sale) || 0) + fee;
  const costLocal = cost * E.rate(m.currency);
  const floor = E.floorFor(costLocal);
  const c = await competitors(l, title);
  // like-for-like only: drop prices far from ours (accessories, bundles, wrong item)
  const near = c.items.map((x) => x.price).filter((v) => v >= base * 0.3 && v <= base * 3.5);
  const plan = { marketplace: E.prefs().marketplace, at: now(), query: c.q, results: c.total, compared: near.length, base: r2(base), floor: Number.isFinite(floor) ? r2(floor) : null, cost: r2(costLocal), currency: m.currency };
  if (near.length >= 5) {
    const p25 = pct(near, 0.25); const med = pct(near, 0.5); const p75 = pct(near, 0.75);
    Object.assign(plan, { low: r2(Math.min(...near)), p25: r2(p25), median: r2(med), p75: r2(p75) });
    // just under the middle of the market; never under the profit floor
    let target = Math.min(med * 0.97, pct(near, 0.4));
    if (floor > p75) return { ok: false, why: `others sell it for about ${m.currency} ${r2(med)}; with VAT, eBay fees and cost we would need at least ${r2(floor)}`, plan };
    target = Math.max(target, floor);
    plan.target = r2(target);
    plan.factor = Math.round((target / base) * 1000) / 1000;
  } else {
    plan.target = r2(Math.max(base, floor)); plan.factor = r2(plan.target / base);
    plan.note = 'few comparable listings on eBay — priced on cost and markup';
  }
  db.listings.update(l.id, { ebay_comp: plan });
  const price = Number(E.priceFor(db.listings.get(l.id), s, fee));
  const profit = r2(E.netOf(price) - costLocal);
  return { ok: profit > 0, why: profit > 0 ? null : 'no profit at a competitive price', plan: { ...plan, price, profit, margin_pct: Math.round(profit / price * 100) } };
}

// ---------------- 3. launch ----------------

let running = false;
async function launch({ n = 10 } = {}) {
  if (running) return { skipped: 'running' };
  running = true;
  const push = require('../push');
  const out = { at: now(), n, picked: [], skipped: [], listed: [], failed: [] };
  try {
    const rv = await review();
    out.review = rv;
    if (!rv.ok) { saveState({ last: out }); await push.telegram(reviewText(rv, true)); return out; }
    // fit the monthly selling limit: units per listing so that n listings stay inside it
    if (rv.facts.limit?.quantity) {
      const per = Math.max(1, Math.min(E.prefs().max_qty, Math.floor(rv.facts.limit.quantity / Math.max(1, n + (rv.facts.inventory_items || 0)))));
      if (per < E.prefs().max_qty) { E.savePrefs({ max_qty: per }); out.max_qty = per; }
    }
    await push.telegram(reviewText(rv, false));
    const picks = await E.bestPicks({ collection: null, n: Math.min(20, n * 2), list: false });
    for (const pk of picks.picks) {
      if (out.picked.length >= n) break;
      const l = db.listings.get(pk.id);
      try {
        const r = await pricePlan(l, pk.title);
        if (!r.ok) { out.skipped.push({ id: l.id, title: pk.title, why: r.why }); continue; }
        out.picked.push({ id: l.id, title: pk.title, score: pk.score, reason: pk.reason, ...r.plan });
      } catch (e) { out.skipped.push({ id: l.id, title: pk.title, why: e.message }); }
    }
    if (out.picked.length) {
      const job = await E.listMany({ ids: out.picked.map((x) => x.id), limit: out.picked.length }, 'launch');
      for (const x of out.picked) {
        const l = db.listings.get(x.id);
        if (l.ebay?.listing_id) out.listed.push({ ...x, ebay_id: l.ebay.listing_id }); else out.failed.push({ ...x, error: l.ebay?.error || job.stopped || 'not listed' });
      }
    }
    saveState({ last: out });
    for (const t of launchText(out)) await push.telegram(t);
    console.log(`[ebay] launch: ${out.listed.length} listed, ${out.failed.length} failed, ${out.skipped.length} skipped (price/profit)`);
    return out;
  } catch (e) {
    out.error = e.message; saveState({ last: out });
    console.warn('[ebay] launch:', e.message);
    await push.telegram(`⚠️ eBay launch stopped: ${e.message}`);
    return out;
  } finally { running = false; }
}

function reviewText(rv, stopped) {
  const f = rv.facts;
  return [
    `🔎 eBay check before listing — ${stopped ? '⛔ NOT listing' : '✅ all good, listing now'}`,
    `Account: ${f.account || '?'} (${f.env}) · site ${f.site} · ${f.currency}`,
    f.limit ? `Monthly selling limit: ${f.limit.quantity ?? '?'} items / ${f.limit.currency} ${f.limit.amount ?? '?'}` : '',
    f.inventory_items != null ? `Already on eBay: ${f.inventory_items} item(s)` : '',
    f.policies ? `Returns: ${f.policies.returns}\nDelivery: ${f.policies.delivery}` : '',
    f.business_policies != null ? `Business policies: ${f.business_policies ? 'on' : 'off'}` : '',
    f.rate ? `Rate: 1 USD = ${f.rate} ${f.currency} · VAT ${f.vat_pct}% (eBay collects) · fees ${f.fee_pct}% · min profit ${f.min_margin_pct}%` : '',
    f.ready != null ? `Products ready for eBay: ${f.ready} (${Object.entries(f.ready_by_warehouse || {}).map(([k, v]) => `${k} ${v}`).join(', ')})` : '',
    f.store ? `Store: ${f.store}` : '', `AI: ${f.ai ? 'on' : 'off'}`,
    ...(rv.blockers.length ? ['', '⛔ Must fix:', ...rv.blockers.map((x) => `• ${x}`)] : []),
    ...(rv.warnings.length ? ['', '⚠️ Notes:', ...rv.warnings.map((x) => `• ${x}`)] : [])
  ].filter(Boolean).join('\n');
}

function launchText(out) {
  const { config } = require('../config');
  const head = [`🏷 eBay launch — ${out.listed.length} listed${out.failed.length ? ` · ${out.failed.length} failed` : ''}${out.skipped.length ? ` · ${out.skipped.length} skipped (could not beat the market at a profit)` : ''}`,
    out.max_qty ? `Units per listing set to ${out.max_qty} (monthly selling limit)` : ''].filter(Boolean).join('\n');
  const msgs = [head]; let cur = '';
  const add = (block) => { if ((cur + block).length > 3200) { msgs.push(cur); cur = ''; } cur += `${block}\n\n`; };
  out.listed.forEach((x, i) => add([
    `${i + 1}. ${x.title}`,
    `   Price ${x.currency} ${x.price} · market ${x.median ? `median ${x.median} (low ${x.low}, ${x.compared} similar)` : x.note || '—'}`,
    `   Profit ≈ ${x.currency} ${x.profit} (${x.margin_pct}%) after VAT, eBay fees, product and delivery`,
    `   https://www.ebay.co.uk/itm/${x.ebay_id}`, `   Kinan: ${config.publicBaseUrl}/#/p/${x.id}`].join('\n')));
  if (out.failed.length) add(['❌ Not listed:', ...out.failed.map((x) => `• ${x.title.slice(0, 60)} — ${String(x.error).slice(0, 160)}`)].join('\n'));
  if (out.skipped.length) add(['↷ Skipped:', ...out.skipped.slice(0, 10).map((x) => `• ${x.title.slice(0, 60)} — ${String(x.why).slice(0, 160)}`)].join('\n'));
  if (cur) msgs.push(cur);
  return msgs;
}

module.exports = { review, competitors, pricePlan, launch, reviewText, launchText, query, _running: () => running };
