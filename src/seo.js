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
  const active = new Map(db.sellers.all((s) => s.status === 'active' && !s.system).map((s) => [s.id, s]));
  return db.listings.all((l) => l.status === 'active' && active.has(l.seller_id)).map((l) => ({ l, s: active.get(l.seller_id) }));
}
const images = (l) => [...(l.own_images || []).map((u, i) => require('./services/catalog').photoUrl(l, i, u)), ...(l.images || [])];

function robots() {
  return `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /warehouse\nDisallow: /seller\nDisallow: /api/\nDisallow: /invoice/\n\nSitemap: ${config.publicBaseUrl}/sitemap.xml\n`;
}

function sitemap() {
  const urls = [['/', 'daily', '1.0'], ['/download', 'monthly', '0.4'], ['/terms', 'yearly', '0.2'], ['/privacy', 'yearly', '0.2'], ['/legal', 'yearly', '0.2']]
    .map(([u, f, p]) => ({ loc: abs(u), changefreq: f, priority: p }));
  const shops = new Set();
  for (const { l, s } of liveProducts()) { urls.push({ loc: abs(`/p/${l.id}`), lastmod: new Date(l.updated_at || l.created_at).toISOString().slice(0, 10), changefreq: 'weekly', priority: '0.8' }); shops.add(s.id); }
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
<g:price>${price.toFixed(2)} ${cur}</g:price><g:availability>${stock ? 'in_stock' : 'out_of_stock'}</g:availability><g:condition>new</g:condition><g:brand>${xml(s.shop_name)}</g:brand><g:identifier_exists>no</g:identifier_exists>${l.weight_kg ? `<g:shipping_weight>${l.weight_kg} kg</g:shipping_weight>` : ''}${r.reviews ? `<g:product_review_average>${r.rating}</g:product_review_average><g:product_review_count>${r.reviews}</g:product_review_count>` : ''}</item>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>Kinan Shop</title><link>${xml(config.publicBaseUrl)}</link><description>Products from China delivered to your door</description>\n${items.join('\n')}\n</channel></rss>\n`;
}

/** Product structured data for Google rich results (price, stock, stars). */
function productJsonLd(l, seller) {
  const r = require('./services/growth').ratingFor(l.id);
  const prices = l.skus.map((k) => k.price);
  const data = {
    '@context': 'https://schema.org', '@type': 'Product', name: l.title, image: images(l).map(abs).slice(0, 6), description: plain(l.description || l.title).slice(0, 500),
    sku: l.id, brand: { '@type': 'Brand', name: seller?.shop_name || 'Kinan' },
    offers: { '@type': 'AggregateOffer', priceCurrency: config.currency.toUpperCase(), lowPrice: Math.min(...prices).toFixed(2), highPrice: Math.max(...prices).toFixed(2), offerCount: l.skus.length,
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
  const v = String(process.env.GOOGLE_SITE_VERIFICATION || '').replace(/[^A-Za-z0-9_-]/g, '');
  return v ? `<meta name="google-site-verification" content="${v}">` : '';
}

module.exports = { robots, sitemap, merchantFeed, productJsonLd, analytics, analyticsCsp, verificationMeta };
