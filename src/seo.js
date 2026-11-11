// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Being found on Google: robots.txt, sitemap.xml, product structured data (JSON-LD) and the
 * Google Merchant Center product feed (free listings in the Shopping tab).
 * Analytics settings (Google Analytics, Microsoft Clarity, Meta Pixel, TikTok Pixel) come from the
 * environment and only load after the visitor accepts cookies.
 */
const db = require('./db');
const { config } = require('./config');

const xml = (v) => String(v ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const abs = (u) => (u && u.startsWith('/') ? config.publicBaseUrl + u : u);
const plain = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function liveProducts() {
  const active = new Map(db.sellers.all((s) => s.status === 'active').map((s) => [s.id, s]));
  return db.listings.all((l) => l.status === 'active' && active.has(l.seller_id)).map((l) => ({ l, s: active.get(l.seller_id) }));
}
const images = (l) => [...(l.own_images || []).map((u, i) => require('./services/catalog').photoUrl(l, i, u)), ...(l.images || [])];

const PRIVATE = ['/admin', '/warehouse', '/seller', '/api/', '/invoice/'];
/** Search engines and AI search (ChatGPT, Perplexity, Gemini, Copilot) may read the shop; private areas stay closed. */
function robots() {
  const rules = `Allow: /\n${PRIVATE.map((x) => `Disallow: ${x}`).join('\n')}\n`;
  const bots = ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'ChatGPT-User', 'GPTBot', 'PerplexityBot', 'Google-Extended', 'Applebot', 'ClaudeBot', 'Claude-SearchBot'];
  return `${bots.map((b) => `User-agent: ${b}\n${rules}`).join('\n')}\nUser-agent: *\n${rules}\nSitemap: ${config.publicBaseUrl}/sitemap.xml\n`;
}

function sitemap() {
  const cats = new Set(liveProducts().map(({ l }) => l.category || 'other'));
  const xmas = require('./services/seasonal').publicInfo().length ? [['/christmas', 'daily', '0.9']] : [];
  const urls = [['/', 'daily', '1.0'], ...xmas, ...[...cats].map((c) => [`/c/${c}`, 'daily', '0.7']), ['/download', 'monthly', '0.4'], ['/terms', 'yearly', '0.2'], ['/privacy', 'yearly', '0.2'], ['/legal', 'yearly', '0.2']]
    .map(([u, f, p]) => ({ loc: abs(u), changefreq: f, priority: p }));
  const shops = new Set();
  for (const { l, s } of liveProducts()) { urls.push({ loc: abs(`/p/${l.id}`), lastmod: new Date(l.updated_at || l.created_at).toISOString().slice(0, 10), changefreq: 'weekly', priority: '0.8' }); if (!s.system) shops.add(s.id); }
  for (const id of shops) urls.push({ loc: abs(`/s/${id}`), changefreq: 'weekly', priority: '0.6' });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}\n</urlset>\n`;
}

/** Google Merchant Center feed (RSS 2.0 with the g: namespace). */
function merchantFeed() {
  const cur = config.currency.toUpperCase();
  const items = [];
  for (const { l, s } of liveProducts()) {
    const imgs = images(l).map(abs).filter((u) => /^https:\/\//.test(u));
    if (!imgs.length) continue;
    const price = Math.min(...l.skus.map((k) => k.price));
    const stock = l.skus.some((k) => k.stock > 0);
    const r = require('./services/growth').ratingFor(l.id);
    items.push(`<item><g:id>${xml(l.id)}</g:id><title>${xml(l.title.slice(0, 150))}</title><description>${xml(plain(l.description || l.title).slice(0, 4900))}</description>
<link>${xml(abs(`/p/${l.id}`))}</link><g:image_link>${xml(imgs[0])}</g:image_link>${imgs.slice(1, 10).map((u) => `<g:additional_image_link>${xml(u)}</g:additional_image_link>`).join('')}
<g:price>${price.toFixed(2)} ${cur}</g:price><g:availability>${stock ? 'in_stock' : 'out_of_stock'}</g:availability><g:condition>new</g:condition>${catName(l) ? `<g:product_type>${xml(catName(l))}</g:product_type>` : ''}<g:brand>${xml(s.shop_name)}</g:brand><g:identifier_exists>no</g:identifier_exists>${l.weight_kg ? `<g:shipping_weight>${l.weight_kg} kg</g:shipping_weight>` : ''}${r.reviews ? `<g:product_review_average>${r.rating}</g:product_review_average><g:product_review_count>${r.reviews}</g:product_review_count>` : ''}</item>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>Kinan Shop</title><link>${xml(config.publicBaseUrl)}</link><description>Products delivered to your door</description>\n${items.join('\n')}\n</channel></rss>\n`;
}

const catName = (l) => (require('./services/shipping').CATEGORIES.find(([id]) => id === (l.category || 'other')) || [])[1] || '';

/** OpenAI (ChatGPT shopping) product feed, JSON Lines — https://developers.openai.com/commerce/product-feeds/spec */
function openaiFeed() {
  const cur = config.currency.toUpperCase(); const out = [];
  for (const { l, s } of liveProducts()) {
    const imgs = images(l).map(abs).filter((u) => /^https:\/\//.test(u));
    if (!imgs.length) continue;
    const r = require('./services/growth').ratingFor(l.id);
    const many = l.skus.length > 1;
    for (const k of l.skus) {
      out.push(JSON.stringify({
        item_id: many ? `${l.id}-${k.mp_sku_id}` : l.id, ...(many ? { group_id: l.id, listing_has_variations: true, variant_dict: Object.fromEntries((k.opts || []).map((o) => [o.name, o.value]).filter(([a, b]) => a && b)) } : {}),
        title: (many && k.props ? `${l.title} — ${k.props}` : l.title).slice(0, 150), description: plain(l.description || l.title).slice(0, 5000),
        url: abs(`/p/${l.id}`), brand: s.system ? 'Kinan' : s.shop_name, seller_name: s.shop_name || 'Kinan', seller_url: abs(s.system ? '/' : `/s/${s.id}`),
        image_url: k.image && /^https:\/\//.test(k.image) ? k.image : imgs[0], additional_image_urls: imgs.slice(1, 10),
        price: `${Number(k.price).toFixed(2)} ${cur}`, availability: k.stock > 0 ? 'in_stock' : 'out_of_stock', condition: 'new',
        ...(catName(l) ? { product_category: catName(l) } : {}), ...(l.weight_kg ? { weight: l.weight_kg, item_weight_unit: 'kg' } : {}),
        return_policy: abs('/terms'), ...(r.reviews ? { review_count: r.reviews, star_rating: Number(r.rating).toFixed(2) } : {})
      }));
    }
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

/** /llms.txt — a short guide to the shop for AI assistants. */
function llmsTxt() {
  const list = liveProducts();
  const cats = new Map(); for (const { l } of list) cats.set(l.category || 'other', (cats.get(l.category || 'other') || 0) + 1);
  const money = (v) => `${Number(v).toFixed(2)} ${config.currency.toUpperCase()}`;
  const x = require('./services/seasonal').publicInfo()[0];
  return [
    '# Kinan Shop', '',
    '> Kinan (kinan.shop) is an online marketplace that delivers to Europe, the UK and worldwide with tracking. Independent sellers and Kinan\'s own shop sell home and kitchen items, fashion, electronics, beauty, toys and seasonal gifts. Prices are in USD and shown in the visitor\'s currency (EUR, GBP…); shipping is calculated for the address at checkout. Arabic and English.', '',
    '## Shop', `- [Home](${abs('/')}): all products`, ...(x ? [`- [Christmas Shop](${abs('/christmas')}): ${x.count} Christmas decorations, lights, jumpers and gifts shipped from European warehouses; code XMAS10 = 10% off`] : []),
    ...[...cats].map(([c, n]) => `- [${(require('./services/shipping').CATEGORIES.find(([id]) => id === c) || [c, c])[1]}](${abs(`/c/${c}`)}): ${n} products`), '',
    '## Feeds', `- [Product feed (JSON Lines)](${abs('/feeds/openai.jsonl')})`, `- [Google Merchant feed](${abs('/feeds/google.xml')})`, `- [Sitemap](${abs('/sitemap.xml')})`, '',
    '## Products', ...list.slice(0, 300).map(({ l }) => `- [${plain(l.title)}](${abs(`/p/${l.id}`)}): from ${money(Math.min(...l.skus.map((k) => k.price)))}`), '',
    '## Help', `- [Terms and returns](${abs('/terms')})`, `- [Privacy](${abs('/privacy')})`, '- Contact: support@kinan.shop', ''
  ].join('\n');
}

// ---------------- Server-rendered content (crawlers read it; the app replaces it on load) ----------------
const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const priceOf = (l) => `$${Math.min(...l.skus.map((k) => k.price)).toFixed(2)}`;
function cardsHtml(list) {
  return `<ul class="ssr-list">${list.map((l) => `<li><a href="/p/${h(l.id)}">${(images(l).map(abs).filter((u) => /^https:/.test(u))[0]) ? `<img src="${h(images(l).map(abs).filter((u) => /^https:/.test(u))[0])}" alt="${h(l.title)}" width="160" height="160" loading="lazy">` : ''}<span>${h(l.title)}</span> <b>${priceOf(l)}</b></a></li>`).join('')}</ul>`;
}
function ssrProduct(l, seller) {
  const cat = catName(l);
  const related = liveProducts().filter(({ l: x }) => x.id !== l.id && (x.category || 'other') === (l.category || 'other')).slice(0, 12).map(({ l: x }) => x);
  const desc = plain(l.description || '').slice(0, 3000);
  const opts = [...new Set(l.skus.map((k) => k.props).filter(Boolean))].slice(0, 30);
  return `<nav aria-label="Breadcrumb"><a href="/">Kinan Shop</a> › ${cat ? `<a href="/c/${h(l.category || 'other')}">${h(cat)}</a> › ` : ''}${h(l.title)}</nav>
<article itemscope><h1>${h(l.title)}</h1>${l.title_ar ? `<p lang="ar" dir="rtl">${h(l.title_ar)}</p>` : ''}
<p><b>From ${priceOf(l)}</b> · ${l.skus.some((k) => k.stock > 0) ? 'In stock' : 'Out of stock'} · Sold by ${h(seller?.shop_name || 'Kinan')} · Delivered with tracking${l.cj_from && l.cj_from !== 'CN' ? ' · Ships from a European warehouse' : ''}</p>
${images(l).map(abs).filter((u) => /^https:/.test(u)).slice(0, 4).map((u) => `<img src="${h(u)}" alt="${h(l.title)}" width="400" height="400" loading="lazy">`).join('')}
${desc ? `<p>${h(desc)}</p>` : ''}${opts.length > 1 ? `<p>Options: ${h(opts.join(', '))}</p>` : ''}${l.description_ar ? `<p lang="ar" dir="rtl">${h(plain(l.description_ar).slice(0, 1500))}</p>` : ''}</article>
${related.length ? `<h2>More ${h(cat || 'products')}</h2>${cardsHtml(related)}` : ''}`;
}
function ssrList({ title, intro, collection, category, seller_id, limit = 120 } = {}) {
  const list = liveProducts().filter(({ l }) => (!collection || (l.collections || []).includes(collection)) && (!category || (l.category || 'other') === category) && (!seller_id || l.seller_id === seller_id)).slice(0, limit).map(({ l }) => l);
  const cats = [...new Set(liveProducts().map(({ l }) => l.category || 'other'))];
  return `<h1>${h(title)}</h1>${intro ? `<p>${h(intro)}</p>` : ''}${cardsHtml(list)}
<nav aria-label="Categories">${cats.map((c) => `<a href="/c/${h(c)}">${h((require('./services/shipping').CATEGORIES.find(([id]) => id === c) || [c, c])[1])}</a>`).join(' · ')}${require('./services/seasonal').publicInfo().length ? ' · <a href="/christmas">Christmas Shop</a>' : ''}</nav>`;
}
function siteJsonLd() {
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'Organization', '@id': abs('/#org'), name: 'Kinan', url: abs('/'), logo: abs('/assets/icon-512.png'), email: 'support@kinan.shop', sameAs: ['https://www.instagram.com/kinanshop4u', 'https://www.tiktok.com/@kinan.shop4u'] },
    { '@type': 'WebSite', '@id': abs('/#site'), name: 'Kinan Shop', url: abs('/'), publisher: { '@id': abs('/#org') }, inLanguage: ['en', 'ar'] }
  ] }).replace(/</g, '\\u003c')}</script>`;
}
function listJsonLd(name, list, url) {
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'CollectionPage', name, url: abs(url), mainEntity: { '@type': 'ItemList', itemListElement: list.slice(0, 50).map(({ l }, i) => ({ '@type': 'ListItem', position: i + 1, url: abs(`/p/${l.id}`), name: l.title })) } }).replace(/</g, '\\u003c')}</script>`;
}

// ---------------- IndexNow (Bing, which ChatGPT search uses, Yandex, Seznam…) ----------------
function indexNowKey() {
  const env = String(process.env.INDEXNOW_KEY || '').replace(/[^A-Za-z0-9-]/g, '');
  if (env.length >= 8) return env;
  const s = db.settings.get('set_indexnow');
  if (s?.key) return s.key;
  const key = require('crypto').randomBytes(16).toString('hex');
  db.settings.insert({ id: 'set_indexnow', key, sent: {} });
  return key;
}
/** Tell search engines about new or changed product pages (title / price / stock), at most 10,000 URLs per call. */
async function indexNowTick() {
  if (!/^https:\/\//.test(config.publicBaseUrl) || process.env.INDEXNOW === '0') return 0;
  const key = indexNowKey();
  const st = db.settings.get('set_indexnow') || { sent: {} };
  const sent = { ...(st.sent || {}) }; const urls = []; const live = new Set();
  const fp = (l) => require('crypto').createHash('sha1').update(`${l.title}|${l.skus.map((k) => `${k.price}:${k.stock > 0}`).join(',')}`).digest('hex').slice(0, 10);
  for (const { l } of liveProducts()) { live.add(l.id); const f = fp(l); if (sent[l.id] !== f) { urls.push(abs(`/p/${l.id}`)); sent[l.id] = f; } }
  for (const id of Object.keys(sent)) if (!live.has(id)) { urls.push(abs(`/p/${id}`)); delete sent[id]; } // removed pages: let them drop out
  if (!urls.length) return 0;
  const extra = [abs('/'), abs('/sitemap.xml'), ...(require('./services/seasonal').publicInfo().length ? [abs('/christmas')] : [])];
  const host = new URL(config.publicBaseUrl).host;
  const r = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host, key, keyLocation: abs(`/${key}.txt`), urlList: [...extra, ...urls].slice(0, 10000) }), signal: AbortSignal.timeout(20000) });
  if (![200, 202].includes(r.status)) throw new Error(`IndexNow answered ${r.status}`);
  const doc = { sent, last_at: Date.now(), last_count: urls.length };
  if (db.settings.get('set_indexnow')) db.settings.update('set_indexnow', doc); else db.settings.insert({ id: 'set_indexnow', ...doc });
  console.log(`[seo] IndexNow: told Bing and others about ${urls.length} page(s)`);
  return urls.length;
}

/** Product structured data for Google rich results (price, stock, stars). */
function productJsonLd(l, seller) {
  const r = require('./services/growth').ratingFor(l.id);
  const prices = l.skus.map((k) => k.price);
  const data = {
    '@context': 'https://schema.org', '@type': 'Product', name: l.title, image: images(l).map(abs).slice(0, 6), description: plain(l.description || l.title).slice(0, 500),
    sku: l.id, brand: { '@type': 'Brand', name: seller?.shop_name || 'Kinan' }, ...(l.title_ar ? { alternateName: l.title_ar } : {}), ...(catName(l) ? { category: catName(l) } : {}),
    offers: { '@type': 'AggregateOffer', itemCondition: 'https://schema.org/NewCondition', seller: { '@type': 'Organization', name: seller?.shop_name || 'Kinan' }, priceCurrency: config.currency.toUpperCase(), lowPrice: Math.min(...prices).toFixed(2), highPrice: Math.max(...prices).toFixed(2), offerCount: l.skus.length,
      availability: l.skus.some((k) => k.stock > 0) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: abs(`/p/${l.id}`) },
    ...(r.reviews ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: r.rating, reviewCount: r.reviews } } : {})
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

// ---------------- Analytics (after cookie consent) ----------------
function analytics() {
  const e = process.env; const id = (v) => (/^[A-Za-z0-9-]{4,40}$/.test(String(v || '')) ? String(v) : null);
  const a = { ga: id(e.GA_MEASUREMENT_ID), clarity: id(e.CLARITY_PROJECT_ID), meta: id(e.META_PIXEL_ID), tiktok: id(e.TIKTOK_PIXEL_ID) };
  return Object.values(a).some(Boolean) ? a : null;
}
/** Extra CSP sources the analytics tools need. */
function analyticsCsp() {
  const a = analytics(); if (!a) return { script: '', connect: '', frame: '' };
  const s = []; const c = [];
  if (a.ga) { s.push('https://www.googletagmanager.com'); c.push('https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.googletagmanager.com'); }
  if (a.clarity) { s.push('https://*.clarity.ms'); c.push('https://*.clarity.ms'); }
  if (a.meta) { s.push('https://connect.facebook.net'); c.push('https://www.facebook.com', 'https://connect.facebook.net'); }
  if (a.tiktok) { s.push('https://analytics.tiktok.com'); c.push('https://analytics.tiktok.com'); }
  return { script: s.length ? ` ${s.join(' ')}` : '', connect: c.length ? ` ${c.join(' ')}` : '', frame: '' };
}
function verificationMeta() {
  const clean = (x) => String(process.env[x] || '').replace(/[^A-Za-z0-9_=-]/g, '');
  const g = clean('GOOGLE_SITE_VERIFICATION'); const b = clean('BING_SITE_VERIFICATION');
  return `${g ? `<meta name="google-site-verification" content="${g}">` : ''}${b ? `<meta name="msvalidate.01" content="${b}">` : ''}`;
}

module.exports = { robots, sitemap, merchantFeed, openaiFeed, llmsTxt, ssrProduct, ssrList, siteJsonLd, listJsonLd, liveProducts, indexNowKey, indexNowTick, productJsonLd, analytics, analyticsCsp, verificationMeta };
