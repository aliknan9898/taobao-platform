'use strict';
/**
 * Winning products & keywords — free sources only, no API key:
 *  1. Google search suggestions (what UK shoppers really type, most-searched first) for every department keyword,
 *     scanned once a day; a phrase that appears more often / higher up than before is "rising", a new one is "new".
 *  2. Kinan's own shop: what customers search for (and find nothing for), product views and sales.
 *  3. eBay UK (free Browse API, when connected): how many sellers already sell the hottest phrases, and at what price.
 *  4. AliExpress orders and CJ seller counts already stored on each sourced product.
 * What it is used for: the hottest phrases go first in the CJ / AliExpress product search, Kinan products get the
 * matching real search phrases as keywords, and the admin sees the lists.
 */
const db = require('../db');

const list = (v) => (Array.isArray(v) ? v : []);
const now = () => Date.now();
const day = (t = now()) => new Date(t).toISOString().slice(0, 10);
const daysAgo = (n) => day(now() - n * 864e5);
const get = (id) => db.settings.get(id) || null;
const put = (id, doc) => (db.settings.get(id) ? db.settings.update(id, doc) : db.settings.insert({ id, ...doc }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GL = () => String(process.env.TRENDS_COUNTRY || 'gb').toLowerCase();
const SEEDS_PER_TICK = () => Math.max(5, Number(process.env.TRENDS_SEEDS_PER_TICK) || 40);

// phrases that are not products, or are other shops / big brands (no knock-offs)
const NOT_PRODUCT = /\b(near me|how|what|why|when|where|who|which|reddit|review|reviews|meaning|vs|youtube|tiktok|argos|amazon|ebay|tesco|asda|ikea|aldi|lidl|primark|john lewis|currys|temu|shein|wilko|the range|screwfix|b and q|b&q|sainsbury|walmart|costco|jobs|hire|rent|repair|recipe|login|download|free)\b/;
const BRANDS = /\b(nike|adidas|puma|dyson|lego|disney|marvel|pokemon|barbie|hello kitty|gucci|chanel|louis vuitton|rolex|stanley|yeti|ninja|shark|tefal|kenwood|smeg|apple watch ultra|airpods|beats|bose|jbl|sony|samsung galaxy|pandora|north face|crocs|ugg|lululemon|owala|hydro flask|sylvanian|squishmallow|labubu|jellycat)\b/;
const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 &'-]+/g, ' ').replace(/\s+/g, ' ').replace(/\b(uk|online|cheap|buy|sale|deals?)\b/g, ' ').replace(/\s+/g, ' ').trim();
const okPhrase = (p) => { const w = p.split(' '); return w.length >= 2 && w.length <= 6 && p.length <= 60 && !NOT_PRODUCT.test(p) && !BRANDS.test(p) && !/\b(19|20)\d\d\b/.test(p); };

/** Google's search suggestions for one query (most popular first). */
async function suggest(q) {
  const u = `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=${GL()}&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Kinan trends)' }, signal: AbortSignal.timeout(10000) });
  if (r.status === 429 || r.status === 403) { const e = new Error('Google suggestions are busy'); e.busy = true; throw e; }
  if (!r.ok) throw new Error(`Google suggestions HTTP ${r.status}`);
  const j = JSON.parse(await r.text());
  return list(j[1]).map(String);
}

/** All department seed keywords, departments in turns. */
function seeds() {
  const D = require('./sourcing').DEPARTMENTS;
  const per = Object.entries(D).map(([d, x]) => Object.entries(x.groups).flatMap(([g, G]) => list(G.keywords).map((kw) => ({ dept: d, group: g, kw }))));
  const out = []; const n = Math.max(...per.map((a) => a.length));
  for (let i = 0; i < n; i++) for (const a of per) if (a[i]) out.push(a[i]);
  return out;
}

const bankId = (dept) => `trends_bank_${dept}`;
const bank = (dept) => get(bankId(dept))?.phrases || {};

/** Look up one seed: its suggestions and those of "best …" and "… for", scored by how high they appear. */
async function scanSeed(s) {
  const found = {};
  for (const q of [s.kw, `best ${s.kw}`, `${s.kw} for`]) {
    const sug = await suggest(q);
    sug.forEach((raw, i) => { const p = clean(raw); if (okPhrase(p)) found[p] = (found[p] || 0) + (10 - Math.min(i, 9)); });
    await sleep(1200);
  }
  return found;
}

let running = false;
/** One step of today's scan (a batch of seeds); the whole list is covered about once a day. */
async function tick({ force = false } = {}) {
  if (running) return { skipped: 'running' };
  const st = get('trends_state') || {};
  if (!force && st.done_day === day()) return { skipped: 'done today' };
  running = true;
  const all = seeds(); let cursor = st.day === day() ? Number(st.cursor) || 0 : 0;
  const end = Math.min(all.length, cursor + SEEDS_PER_TICK());
  const touched = {}; let calls = 0; let error = null;
  try {
    for (; cursor < end; cursor++) {
      const s = all[cursor];
      let found;
      try { found = await scanSeed(s); calls += 3; } catch (e) { error = e.message; if (e.busy) break; continue; }
      const b = touched[s.dept] || (touched[s.dept] = bank(s.dept));
      for (const [p, sc] of Object.entries(found)) {
        const x = b[p] || (b[p] = { group: s.group, seed: s.kw, first: day(), days: {} });
        x.days[day()] = (x.days[day()] || 0) + sc; x.last = day();
      }
    }
    // save, forgetting phrases not seen for 21 days and history older than 14 days
    for (const [d, b] of Object.entries(touched)) {
      for (const [p, x] of Object.entries(b)) {
        if ((x.last || '') < daysAgo(21)) { delete b[p]; continue; }
        for (const k of Object.keys(x.days)) if (k < daysAgo(14)) delete x.days[k];
      }
      put(bankId(d), { phrases: b, at: now() });
    }
    const done = cursor >= all.length;
    const phrases = Object.values(touched).reduce((a, b) => a + Object.keys(b).length, 0);
    console.log(`[trends] scanned ${cursor}/${all.length} keywords · ${calls} Google calls · ${phrases} phrases in the touched departments${error ? ` · error: ${error}` : ''}`);
    put('trends_state', { day: day(), cursor, done_day: done ? day() : st.done_day || null, last_run: now(), last_calls: calls, error, seeds: all.length, scans: (st.scans || 0) + (done ? 1 : 0) });
    if (done) { try { await ebayCheck(); } catch (e) { console.warn('[trends] eBay check:', e.message); } console.log(`[trends] daily scan done: ${all.length} keywords`); }
    return { cursor, of: all.length, calls, error };
  } finally { running = false; }
}

/** Score of one phrase: today's (or latest) strength, and how it moved against the days before. */
function rate(x) {
  const ds = Object.keys(x.days).sort(); const lastD = ds[ds.length - 1];
  const cur = x.days[lastD] || 0; const before = ds.slice(0, -1).map((k) => x.days[k]);
  const avg = before.length ? before.reduce((a, v) => a + v, 0) / before.length : null;
  const growth = avg ? (cur - avg) / avg : null;
  const isNew = x.first >= daysAgo(3) && Object.keys(x.days).length <= 2 && (get('trends_state')?.scans || 0) > 1;
  return { score: cur, growth, isNew, hot: cur * (1 + Math.max(0, growth || 0)) * (isNew ? 1.5 : 1) };
}

/** The strongest phrases (all departments or one). */
function top({ dept = '', n = 30, rising = false } = {}) {
  const D = require('./sourcing').DEPARTMENTS;
  const out = [];
  for (const d of dept ? [dept] : Object.keys(D)) {
    for (const [p, x] of Object.entries(bank(d))) {
      if ((x.last || '') < daysAgo(3)) continue;
      const r = rate(x);
      if (rising && !(r.isNew || (r.growth || 0) > 0.15)) continue;
      out.push({ phrase: p, dept: d, group: x.group, seed: x.seed, ...r });
    }
  }
  return out.sort((a, b) => b.hot - a.hot).slice(0, n);
}

// ---------------- the shop's own searches ----------------
/** Remember what customers search for in the shop (per day), and whether they found anything. */
function logSearch(q, total) {
  const p = clean(q); if (p.length < 3 || p.length > 60 || !/[a-z]/.test(p)) return;
  const id = `trends_search_${day()}`;
  const d = get(id) || { q: {} };
  const x = d.q[p] || (d.q[p] = { n: 0, found: 0 });
  x.n++; x.found = Number(total) || 0;
  if (Object.keys(d.q).length > 800) return; // a bot or a flood: stop growing today's list
  put(id, { q: d.q });
}
function shopSearches(days = 7) {
  const agg = {};
  for (let i = 0; i < days; i++) for (const [p, x] of Object.entries(get(`trends_search_${daysAgo(i)}`)?.q || {})) {
    const a = agg[p] || (agg[p] = { phrase: p, searches: 0, found: x.found });
    a.searches += x.n; if (i === 0 || a.found == null) a.found = x.found;
  }
  return Object.values(agg).sort((a, b) => b.searches - a.searches);
}

// ---------------- winning products (Kinan's own numbers + supplier signals) ----------------
function winners(n = 15) {
  const since = daysAgo(7);
  const views = {}; for (const v of db.views.all((x) => x.day >= since)) views[v.listing_id] = (views[v.listing_id] || 0) + (v.n || 0);
  const sold = {};
  for (const o of db.orders.all((x) => (x.created_at || 0) >= now() - 14 * 864e5 && !['pending_payment', 'cancelled', 'refunded'].includes(x.status))) for (const l of list(o.lines)) sold[l.listing_id] = (sold[l.listing_id] || 0) + (Number(l.qty) || 1);
  const out = [];
  for (const l of db.listings.all((x) => x.status === 'active' && !x.from_kinan)) {
    const so = l.sourcing || {};
    const v = views[l.id] || 0; const s = sold[l.id] || 0; const ae = Number(so.orders) || 0; const cj = Number(so.listed) || 0;
    const score = s * 25 + v + Math.log10(1 + ae) * 4 + Math.log10(1 + cj) * 3 + (Number(so.quality) || 0) * 0.5;
    if (score <= 3) continue;
    out.push({ id: l.id, title: l.title, image: list(l.images)[0] || null, views: v, sold: s, ae_orders: ae || null, cj_sellers: cj || null, days: so.gb_days || so.eu_days || null, dept: list(l.collections)[0] || null, on_ebay: Boolean(l.ebay?.listing_id), score: Math.round(score * 10) / 10 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}

// ---------------- eBay UK: competition for the hottest phrases (free Browse API) ----------------
async function ebayCheck(n = 20) {
  const client = require('../ebay/client');
  if (!client.connected?.()) return;
  const E = require('./ebay'); const mk = E.prefs().marketplace; const m = E.market();
  const res = {};
  for (const t of top({ n })) {
    try {
      const j = await client.api('GET', '/buy/browse/v1/item_summary/search', undefined, { user: false, marketplace: mk, query: { q: t.phrase, filter: `buyingOptions:{FIXED_PRICE},conditions:{NEW},deliveryCountry:${m.country}`, limit: '50' } });
      const prices = list(j.itemSummaries).filter((x) => x.price?.currency === m.currency).map((x) => Number(x.price.value)).sort((a, b) => a - b);
      res[t.phrase] = { total: Number(j.total) || 0, median: prices.length ? prices[Math.floor(prices.length / 2)] : null, currency: m.currency, at: now() };
    } catch (e) { console.warn('[trends] eBay', t.phrase, e.message); }
    await sleep(400);
  }
  put('trends_ebay', { phrases: res, at: now() });
}

// ---------------- using it ----------------
/**
 * Phrases for the product search (CJ / AliExpress), hottest first: rising Google phrases and shop searches that found
 * nothing (customers want it, Kinan does not have it yet). Each with its department and section.
 */
function hotKeywords({ departments = null, n = 40 } = {}) {
  const S = require('./sourcing');
  const okDept = (d) => !departments || departments.includes(d);
  const out = []; const seen = new Set();
  const add = (x) => { if (!seen.has(x.kw) && okDept(x.dept)) { seen.add(x.kw); out.push(x); } };
  for (const s of shopSearches(14).filter((x) => x.searches >= 2 && !x.found && okPhrase(x.phrase))) {
    const r = S.ruleFor({ title: s.phrase, keywords: [] }); if (r) add({ dept: r.dept, group: r.group, kw: s.phrase, why: 'shop search' });
  }
  for (const t of top({ n: n * 2, rising: true })) add({ dept: t.dept, group: t.group, kw: t.phrase, why: t.isNew ? 'new on Google' : 'rising on Google' });
  for (const t of top({ n: n * 2 })) add({ dept: t.dept, group: t.group, kw: t.phrase, why: 'popular on Google' });
  return out.slice(0, n);
}

/** Real search phrases for a product: the bank's phrases whose words are all in the product's title or keywords. */
function phrasesFor(l, max = 4) {
  const text = ` ${clean(`${l.title} ${list(l.keywords).join(' ')}`)} `;
  const depts = [...new Set([...list(l.collections), l.sourcing?.dept].filter(Boolean))];
  const D = require('./sourcing').DEPARTMENTS;
  const out = [];
  for (const d of depts.length ? depts : Object.keys(D)) for (const [p, x] of Object.entries(bank(d))) {
    const w = p.split(' ');
    if (w.length >= 2 && w.every((t) => text.includes(` ${t} `) || (t.endsWith('s') && text.includes(` ${t.slice(0, -1)} `)))) out.push({ p, sc: rate(x).score * w.length });
  }
  return out.sort((a, b) => b.sc - a.sc).map((x) => x.p).slice(0, max);
}

/** Add the matching real search phrases to Kinan's products (a batch at a time, no API calls). */
function enrich(limit = 300) {
  const kinan = require('./buyforme').systemSeller().id;
  let n = 0;
  for (const l of db.listings.all((x) => x.seller_id === kinan && x.status === 'active' && (x.trend_kw_at || 0) < now() - 7 * 864e5).slice(0, limit)) {
    const add = phrasesFor(l).filter((p) => !list(l.keywords).includes(p));
    db.listings.update(l.id, (x) => ({ ...x, trend_kw_at: now(), ...(add.length ? { keywords: [...add, ...list(x.keywords)].slice(0, 16), trend_kw: add } : {}) }));
    if (add.length) n++;
  }
  return n;
}

function status() {
  const st = get('trends_state') || {};
  const eb = get('trends_ebay')?.phrases || {};
  const withEbay = (x) => ({ ...x, ebay: eb[x.phrase] || null });
  return {
    source: 'Google search suggestions (UK) + Kinan shop + eBay UK + AliExpress/CJ', cost: 'free',
    scan: { day: st.day || null, done_today: st.done_day === day(), progress: st.seeds ? Math.round(((st.day === day() ? st.cursor : 0) || 0) / st.seeds * 100) : 0, keywords: st.seeds || seeds().length, last_run: st.last_run || null, error: st.error || null, days_scanned: st.scans || 0 },
    rising: top({ n: 25, rising: true }).map(withEbay), popular: top({ n: 25 }).map(withEbay),
    shop_searches: shopSearches(7).slice(0, 25), missing: shopSearches(14).filter((x) => !x.found).slice(0, 15),
    winners: winners(15), next_for_sourcing: hotKeywords({ n: 15 })
  };
}

module.exports = { suggest, seeds, tick, top, rate, logSearch, shopSearches, winners, hotKeywords, phrasesFor, enrich, status, clean, okPhrase, _bank: bank };
