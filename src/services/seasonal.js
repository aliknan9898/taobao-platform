// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Seasonal collections — the Christmas Shop.
 * Picks CJ products kept in CJ's European warehouses (DE, FR, ES, IT, PL, CZ, NL, then GB) so they arrive in time,
 * across five groups (decorations, lights, clothing, gifts, kitchen). Each product is checked for stock in that
 * warehouse and for a real CJ shipping method, gets shop copy (Claude when ANTHROPIC_API_KEY is set, otherwise a
 * clean template), a price with Kinan's margin, and the tag `collections: ['christmas']`.
 * The shop shows it at #/x/christmas (share link /christmas) until the collection ends.
 */
const db = require('../db');
const { httpError } = require('../auth');
const { config } = require('../config');

const now = () => Date.now();
const money = (v) => Math.round(Number(v) * 100) / 100;
const list = (v) => (Array.isArray(v) ? v : []);

const CHRISTMAS = {
  id: 'christmas', name: 'Christmas Shop', name_ar: 'متجر الكريسمس',
  ends: Date.UTC(2026, 11, 27), order_by: '15 December',
  groups: {
    decor: { en: 'Decorations', ar: 'زينة', keywords: ['christmas ornament', 'christmas tree decoration', 'christmas wreath', 'christmas garland', 'christmas stocking', 'christmas pillow cover', 'christmas tablecloth', 'snowman decoration', 'christmas tree topper', 'christmas door hanger', 'christmas table runner', 'christmas window sticker', 'christmas bauble', 'christmas village house'] },
    lights: { en: 'Lights', ar: 'إضاءة', keywords: ['christmas lights', 'led fairy lights', 'christmas string lights', 'christmas projector light', 'led candle christmas', 'christmas star light', 'christmas curtain light', 'light up christmas decoration', 'christmas night light', 'snowflake light'] },
    clothing: { en: 'Clothing', ar: 'ملابس', keywords: ['christmas sweater', 'christmas pajamas', 'santa hat', 'christmas socks', 'christmas headband', 'family matching christmas', 'ugly christmas sweater', 'christmas dress', 'christmas t-shirt', 'christmas scarf', 'christmas gloves', 'kids christmas outfit'] },
    gifts: { en: 'Gifts', ar: 'هدايا', keywords: ['christmas gift box', 'advent calendar', 'christmas mug', 'christmas blanket', 'christmas plush toy', 'christmas gift', 'christmas candle', 'christmas jewelry', 'christmas keychain', 'christmas snow globe', 'christmas music box', 'christmas gift bag'] },
    kitchen: { en: 'Kitchen', ar: 'المطبخ', keywords: ['christmas cookie cutter', 'christmas baking mold', 'christmas apron', 'christmas plate', 'christmas napkin', 'christmas cake decoration', 'christmas cupcake', 'christmas cutlery', 'christmas placemat', 'christmas oven mitt', 'christmas cup', 'gingerbread house kit'] }
  }
};
const COLLECTIONS = { christmas: CHRISTMAS };
const WAREHOUSES = () => String(process.env.XMAS_WAREHOUSES || 'DE,FR,ES,IT,PL,CZ,NL,GB').split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x));
const PER_KEYWORD = Math.max(5, Number(process.env.XMAS_PER_KEYWORD) || 16);
const VERIFIED = process.env.XMAS_VERIFIED !== '0'; // only stock CJ has checked in its own warehouses
const EU = new Set(['DE', 'FR', 'ES', 'IT', 'PL', 'CZ', 'NL', 'BE', 'AT', 'HU', 'PT', 'IE', 'SE', 'DK']);
const WAREHOUSE_NAME = { DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', PL: 'Poland', CZ: 'Czechia', NL: 'Netherlands', GB: 'United Kingdom', BE: 'Belgium', CN: 'China', US: 'USA' };

const XMAS_RE = /christmas|xmas|santa|snowm[ae]n|snowflake|reindeer|\belk\b|gingerbread|advent|fairy light|string light|ornament|wreath|garland|holiday|winter|noel|nutcracker|stocking/i;
const NOT_HERE = /nativity|jesus|crucifix|church|bible|rosary|angel wings costume|sexy|lingerie|wine|beer|whisky|cocktail/i;

// ---------------- copy ----------------
const JUNK = /\b(hot sale|best seller|new arrivals?|new|hot|cross[- ]?border|amazon|wish|ebay|tiktok|wholesale|factory|direct sales?|european and american|europe and america|foreign trade|explosive|explosion models?|ins style|ins|20\d\d|in stock|spot|dropshipping|free shipping|creative|selling)\b/gi;
const SMALL = new Set(['a', 'an', 'and', 'or', 'for', 'of', 'the', 'with', 'in', 'on', 'to', 'by']);
function cleanTitle(raw) {
  const words = String(raw || '').replace(/[【】\[\]{}()|/\\]+/g, ' ').replace(JUNK, ' ').replace(/[^\p{L}\p{N}&'\- ]+/gu, ' ').split(/\s+/).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const w of words) { const k = w.toLowerCase().replace(/s$/, ''); if (seen.has(k) && !SMALL.has(k)) continue; seen.add(k); out.push(w); }
  let t = out.map((w, i) => (i && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : /^[A-Z0-9]{2,5}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, '');
  return t.replace(/\s+(and|or|for|with|of|the)$/i, '').trim() || String(raw || '').slice(0, 80);
}
const INTRO = {
  decor: 'Bring festive sparkle to your home this Christmas.',
  lights: 'Warm, twinkling light for cosy winter evenings and a magical Christmas.',
  clothing: 'Festive and comfortable — perfect for Christmas photos and family get-togethers.',
  gifts: 'A thoughtful gift that makes Christmas morning special.',
  kitchen: 'Make holiday baking and Christmas dinner extra merry.'
};
const FACT = /(Material|Materials|Size|Product size|Colou?r|Style|Shape|Pattern|Power supply|Power|Battery|Light colou?r|Length|Capacity|Weight|Applicable (?:people|scenes?|occasions?)|Packing list|Package (?:includes?|contents?)|Type)\s*[:：]\s*/gi;
function facts(desc) {
  const text = String(desc || '').replace(/\s+/g, ' ');
  const hits = []; let m; FACT.lastIndex = 0;
  const idx = []; while ((m = FACT.exec(text))) idx.push({ at: m.index, end: FACT.lastIndex, key: m[1] });
  for (let i = 0; i < idx.length && hits.length < 6; i++) {
    const val = text.slice(idx[i].end, i + 1 < idx.length ? idx[i + 1].at : idx[i].end + 90).replace(/\b(Note|Notes|Description|Product information|Features?)\b.*$/i, '').trim().replace(/[.;,\s]+$/, '');
    if (!val || val.length > 90 || /http|cj|dropship|china/i.test(val)) continue;
    const key = idx[i].key.replace(/^Materials$/i, 'Material').replace(/^Package (includes?|contents?)$/i, 'In the box').replace(/^Packing list$/i, 'In the box');
    if (!hits.some((h) => h.startsWith(`${key}:`))) hits.push(`${key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()}: ${val}`);
  }
  return hits;
}
function templateCopy(p, group, from) {
  const title = cleanTitle(p.title);
  const opts = [...new Set(p.skus.map((s) => s.props).filter(Boolean))].slice(0, 8);
  const lines = [INTRO[group] || INTRO.gifts, '', ...facts(p.description).map((f) => `• ${f}`)];
  if (opts.length > 1) lines.push(`• Choose from: ${opts.join(', ')}`.slice(0, 200));
  if (from && from !== 'CN') lines.push(`• Fast delivery from our ${EU.has(from) ? 'European' : WAREHOUSE_NAME[from] || ''} warehouse — order by ${CHRISTMAS.order_by} for Christmas`);
  const g = CHRISTMAS.groups[group];
  return { title, description: lines.join('\n').trim(), keywords: ['christmas', 'xmas', 'christmas gifts', g ? g.en.toLowerCase() : '', 'كريسمس', 'هدايا'].filter(Boolean), ad_line: `🎄 ${title.slice(0, 55)}` };
}

/** Group from the product itself (a search word can bring products of another group). */
function groupFor(title, fallback) {
  const t = String(title || '').toLowerCase();
  if (/\b(light|lights|lamp|led|candle|projector|neon)\b/.test(t)) return 'lights';
  if (/sweater|jumper|pajama|pyjama|\bhat\b|sock|headband|dress|t-shirt|shirt|hoodie|scarf|glove|onesie|costume/.test(t)) return 'clothing';
  if (/cookie|baking|mou?ld|apron|plate|napkin|cake|kitchen|tableware|cutlery|oven mitt|placemat/.test(t)) return 'kitchen';
  if (/gift|advent|mug|blanket|plush|toy|music box|snow globe/.test(t)) return 'gifts';
  if (/ornament|wreath|garland|stocking|pillow|tablecloth|decor|pendant|tree|ball|ornament|sticker|snowman|figurine/.test(t)) return 'decor';
  return fallback;
}

// ---------------- import ----------------
const RULES = 4; // import rules version: a deploy with new rules tops the collection up once by itself
const STATE = (id) => `set_collection_${id}`;
const state = (id = 'christmas') => db.settings.get(STATE(id)) || { running: false };
const setState = (id, patch) => (db.settings.get(STATE(id)) ? db.settings.update(STATE(id), patch) : db.settings.insert({ id: STATE(id), ...patch }));
const members = (id = 'christmas') => db.listings.all((l) => list(l.collections).includes(id));

function prefs(o = {}) {
  return {
    count: Math.min(400, Math.max(1, Math.floor(Number(o.count) || Number(process.env.XMAS_COUNT) || 200))),
    markup_pct: Math.min(400, Math.max(10, Number(o.markup_pct) || Number(process.env.XMAS_MARKUP_PCT) || 100)),
    max_cost: Math.min(200, Math.max(2, Number(o.max_cost) || 35)), min_cost: Math.max(0, Number(o.min_cost ?? 1.5)),
    min_stock: Math.max(1, Math.floor(Number(o.min_stock) || 10))
  };
}

/** Candidates for one keyword: products with stock in a European CJ warehouse, most-listed first. */
async function candidates(cjc, keyword, p, have, tried = new Set()) {
  const out = [];
  let lastFull = false;
  // First CJ-verified stock, then (when still short) suppliers' stock kept in the same European/UK warehouses —
  // every pick is still checked for stock in that warehouse and a real CJ shipping method before it is added.
  const passes = VERIFIED ? [1, 0] : [0];
  for (const verified of passes) for (const cc of WAREHOUSES()) for (const page of [1, 2]) {
    if (out.length >= PER_KEYWORD) break;
    if (page === 2 && !lastFull) continue; // a second page only when the first one was full
    let d;
    try { d = await cjc.call('GET', '/product/listV2', { query: { keyWord: keyword, countryCode: cc, page, size: 50, orderBy: 1, sort: 'desc', verifiedWarehouse: verified ? 1 : undefined, startSellPrice: p.min_cost || undefined, endSellPrice: p.max_cost } }); }
    catch (e) { if (/limit|busy|429/i.test(e.message)) throw e; continue; }
    const found = list(d?.content).flatMap((c) => list(c.productList));
    lastFull = found.length >= 50;
    for (const x of found) {
      const pid = String(x.id || x.pid || ''); const title = x.nameEn || x.productNameEn || '';
      if (tried.has(pid)) continue; // turned down before (no stock or no shipping from that warehouse)
      const cost = Number(String(x.sellPrice ?? '').split(/[-–]/)[0]);
      if (!pid || have.has(pid) || out.some((o) => o.pid === pid) || !XMAS_RE.test(title) || NOT_HERE.test(title) || require('./cj').BLOCK.test(title)) continue;
      if (!(cost >= p.min_cost && cost <= p.max_cost) || !(x.bigImage || x.productImage)) continue;
      out.push({ pid, from: cc, title, listed: Number(x.listedNum) || 0 });
    }
  }
  return out.sort((a, b) => b.listed - a.listed); // European and UK warehouses side by side, best sellers first
}

/** Import the collection (runs in the background on the server; progress in state()). */
async function importCollection(id = 'christmas', opts = {}, by = 'admin') {
  const c = COLLECTIONS[id]; if (!c) throw httpError(404, 'Unknown collection');
  const cjc = require('../cj/client'); const cj = require('./cj');
  if (!cjc.enabled()) throw httpError(503, 'CJdropshipping is not connected');
  const s0 = state(id);
  if (s0.running && now() - (s0.started_at || 0) < 3 * 3600e3) return s0;
  const p = prefs(opts);
  const kinan = require('./buyforme').systemSeller();
  const have = new Set(db.listings.all((l) => l.source === 'cj').map((l) => l.cj_pid));
  const already = members(id).filter((l) => l.status === 'active' || (l.status === 'pending_review' && l.review?.auto === 'ai')).length; // incl. ones waiting for the AI check
  const target = Math.max(0, p.count - already);
  const st = { v: RULES, running: true, started_at: now(), by, target: p.count, had: already, added: 0, checked: 0, skipped: 0, reasons: {}, error: null, prefs: p };
  const tried = new Set(list(s0.tried)); // CJ products turned down by earlier imports
  const skip = (why, pid) => { st.skipped++; st.reasons[why] = (st.reasons[why] || 0) + 1; if (pid) tried.add(pid); st.tried = [...tried].slice(-5000); };
  st.tried = [...tried];
  setState(id, st);
  console.log(`[xmas] import started — ${target} to add (${already} already in the collection)`);
  try {
    // 1) candidates per keyword (round-robin later, so every group is represented)
    const pools = [];
    for (const [group, g] of Object.entries(c.groups)) for (const kw of g.keywords) pools.push({ group, kw, items: await candidates(cjc, kw, p, have, tried) });
    st.candidates = pools.reduce((a, x) => a + x.items.length, 0); setState(id, { ...st });
    // 2) take them in turns
    for (let round = 0; st.added < target && pools.some((x) => x.items.length > round); round++) {
      for (const pool of pools) {
        if (st.added >= target) break;
        const cand = pool.items[round]; if (!cand || have.has(cand.pid)) continue;
        have.add(cand.pid); st.checked++;
        const group = groupFor(cand.title, pool.group);
        let l;
        try {
          l = await cj.publish(kinan, { ref: { pid: cand.pid }, from: cand.from, markup_pct: p.markup_pct, category: cj.guessCategory(`${cand.title}`) === 'other' ? 'home' : cj.guessCategory(cand.title), extra: { collections: [id], collection_group: group } });
        } catch (e) { skip(/stock|price/i.test(e.message) ? 'no price' : 'not available', cand.pid); st.last_item_error = e.message; continue; }
        if (l.cj_from !== cand.from) { db.listings.remove(l.id); skip('not in a European warehouse', cand.pid); continue; }
        if (!l.skus.some((k) => k.stock >= p.min_stock) || NOT_HERE.test(`${l.title} ${l.description}`) || cj.BLOCK.test(`${l.title} ${l.description}`)) { db.listings.remove(l.id); skip('low stock or not suitable', cand.pid); continue; }
        // a real CJ shipping method from that warehouse
        const vid = [...l.skus].filter((k) => k.stock > 0).sort((a, b) => a.price - b.price)[0]?.cj_vid;
        const dest = cand.from === 'GB' ? 'GB' : cand.from === 'DE' ? 'FR' : 'DE';
        let opt = null;
        const storage = [...new Set(l.skus.filter((k) => k.cj_vid === vid).flatMap((k) => k.cj_storage || []))];
        try { opt = cj.choose(await cj.freightOptions(dest, [{ vid, qty: 1 }], cand.from)); if (!opt && storage.length) opt = cj.choose(await cj.freightOptions(dest, [{ vid, qty: 1 }], cand.from, storage)); } catch (e) { st.last_item_error = e.message; }
        if (!opt) { db.listings.remove(l.id); skip('no shipping from the warehouse', cand.pid); continue; }
        const copy = templateCopy(l, group, cand.from);
        const cost = Math.min(...l.skus.map((k) => k.cost_sale));
        db.listings.update(l.id, (x) => ({
          ...x, title: copy.title, description: copy.description, keywords: copy.keywords, cj_auto: true, auto_added_at: now(),
          cj_ship: { ...(x.cj_ship || {}), [dest]: { fee: opt.fee, vid, at: now() } },
          xmas: { group, keyword: pool.kw, from: cand.from, cost, ship_fee: opt.fee, ship_days: opt.days || '', ship_method: opt.method, ship_to: dest, ad_line: copy.ad_line, copy: 'template', supplier_title: cand.title }
        }));
        st.added++; setState(id, { ...st });
      }
    }
  } catch (e) { st.error = e.message; }
  st.running = false; st.done_at = now();
  setState(id, { ...st });
  console.log(`[xmas] import done: added ${st.added}, checked ${st.checked}, skipped ${st.skipped} ${JSON.stringify(st.reasons)}${st.error ? ` — ${st.error}` : ''}`);
  if (st.added) try { require('../push').telegram(`🎄 Christmas Shop: ${st.added} products added from CJ's European and UK warehouses (${already + st.added} in total, each checked by the AI before it goes live).`); } catch { /* optional */ }
  polish(id).catch((e) => console.warn('[xmas] copy:', e.message));
  return st;
}

/** With ANTHROPIC_API_KEY: rewrite the template copy with Claude (English + Arabic), 8 products per call. */
let polishing = false;
async function polish(id = 'christmas', max = 200) {
  const ai = require('./ai');
  if (polishing || !ai.enabled()) return 0;
  polishing = true; let n = 0;
  try {
    const todo = members(id).filter((l) => l.xmas && l.xmas.copy !== 'ai' && !l.xmas.copy_failed).slice(0, max);
    for (let i = 0; i < todo.length; i += 8) {
      const batch = todo.slice(i, i + 8);
      let out;
      try { out = await ai.copywrite(batch.map((l) => ({ title: l.xmas.supplier_title || l.title, description: l.description, options: l.skus.map((k) => k.props) })), `${COLLECTIONS[id].name} — festive products shipped from Europe`); }
      catch (e) { console.warn('[xmas] copy:', e.message); break; }
      batch.forEach((l, k) => {
        const o = out[k];
        if (!o || o.title.length < 10) { db.listings.update(l.id, (x) => ({ ...x, xmas: { ...x.xmas, copy_failed: true } })); return; }
        const shipLine = l.xmas.from && l.xmas.from !== 'CN' ? `\n• Fast delivery from our ${EU.has(l.xmas.from) ? 'European' : WAREHOUSE_NAME[l.xmas.from] || ''} warehouse — order by ${CHRISTMAS.order_by} for Christmas` : '';
        const upd = db.listings.update(l.id, (x) => ({ ...x, title: o.title, description: `${o.description}${shipLine}`, keywords: o.keywords.length ? o.keywords : x.keywords, ...(o.title_ar ? { title_ar: o.title_ar, description_ar: o.description_ar } : {}), xmas: { ...x.xmas, copy: 'ai', ad_line: o.ad_line || x.xmas.ad_line } }));
        if (o.title_ar) db.listings.update(upd.id, { ar_src: require('./translate').fingerprint(upd), ar_auto: true });
        n++;
      });
    }
  } finally { polishing = false; }
  if (n) console.log(`[xmas] shop copy written by AI for ${n} product(s)`);
  return n;
}

/** Collection rows for the admin table / CSV. */
function rows(id = 'christmas') {
  const c = COLLECTIONS[id]; if (!c) throw httpError(404, 'Unknown collection');
  return members(id).map((l) => {
    const cheapest = [...l.skus].sort((a, b) => a.price - b.price)[0] || {};
    const cost = money(cheapest.cost_sale || l.xmas?.cost || 0); const price = money(cheapest.price || 0);
    return {
      id: l.id, status: l.status, group: c.groups[l.collection_group]?.en || '', title: l.title, title_ar: l.title_ar || '', description: l.description,
      cost_usd: cost, price_usd: price, margin_usd: money(price - cost), margin_pct: cost ? Math.round(((price - cost) / price) * 100) : null, markup_pct: cost ? Math.round(((price - cost) / cost) * 100) : null,
      ship_usd: l.xmas?.ship_fee ?? null, ship_days: l.xmas?.ship_days || '', ship_to: l.xmas?.ship_to || '', warehouse: WAREHOUSE_NAME[l.cj_from] || l.cj_from || 'China',
      stock: l.skus.reduce((a, k) => a + (k.stock || 0), 0), options: l.skus.length, image: (l.images || [])[0] || '',
      ad_line: l.xmas?.ad_line || '', cj_link: l.source_link, kinan_link: `${config.publicBaseUrl}/p/${l.id}`, copy: l.xmas?.copy || ''
    };
  }).sort((a, b) => a.group.localeCompare(b.group) || a.price_usd - b.price_usd);
}
function csv(id = 'christmas') {
  const cols = ['group', 'title', 'description', 'cost_usd', 'price_usd', 'margin_usd', 'margin_pct', 'markup_pct', 'ship_usd', 'ship_days', 'warehouse', 'stock', 'status', 'ad_line', 'cj_link', 'kinan_link', 'image', 'title_ar'];
  const q = (v) => { const t = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return '﻿' + [cols.join(','), ...rows(id).map((r) => cols.map((k) => q(r[k])).join(','))].join('\n');
}

/** What the shop needs: live collections with their groups. */
function publicInfo() {
  const out = [];
  for (const c of Object.values(COLLECTIONS)) {
    if (now() > c.ends) continue;
    const live = members(c.id).filter((l) => l.status === 'active');
    if (!live.length) continue;
    out.push({ id: c.id, name: c.name, name_ar: c.name_ar, ends: c.ends, order_by: c.order_by, count: live.length, groups: Object.entries(c.groups).map(([gid, g]) => ({ id: gid, en: g.en, ar: g.ar, count: live.filter((l) => l.collection_group === gid).length })).filter((g) => g.count) });
  }
  return out;
}

/** The Christmas coupon used in the ads (made once; the owner can change or switch it off in Admin → Coupons). */
function ensureCoupon() {
  if (now() > CHRISTMAS.ends || db.coupons.find((x) => x.code === 'XMAS10')) return null;
  try { return require('./growth').saveCoupon({ code: 'XMAS10', kind: 'percent', value: 10, min_subtotal: 25, max_discount: 20, expires_at: '2026-12-25T23:59:59Z', note: 'Christmas Shop ads' }); } catch { return null; }
}

/** Once, after deploy: start the import by itself (XMAS_AUTO=0 switches this off). */
function autoStart() {
  if (process.env.XMAS_AUTO === '0' || now() > CHRISTMAS.ends) return false;
  if (!require('../cj/client').enabled()) return false;
  const s = state('christmas');
  if ((s.done_at && s.v === RULES) || (s.running && now() - (s.started_at || 0) < 3 * 3600e3)) return false;
  require('../cj/client').background(() => importCollection('christmas', {}, 'auto')).catch((e) => console.warn('[xmas] import:', e.message));
  return true;
}

module.exports = { COLLECTIONS, CHRISTMAS, cleanTitle, groupFor, facts, templateCopy, importCollection, polish, rows, csv, publicInfo, state, members, ensureCoupon, autoStart, WAREHOUSE_NAME };
