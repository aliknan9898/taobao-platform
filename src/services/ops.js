// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Operations: daily backups by email, printable invoices, product view counts for sellers,
 * and bulk product upload from a spreadsheet (CSV).
 */
const zlib = require('zlib');
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');
const mailer = require('../mailer');

const money = (n) => Math.round(Number(n) * 100) / 100;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

// ---------------- Backups ----------------
function backupFile({ withIdPhotos = true } = {}) {
  const all = db.exportAll();
  // Identity-document photos are private and large: the emailed copy leaves them out (the dashboard download keeps them)
  if (!withIdPhotos) all.kyc_docs = [];
  const data = { app: 'kinan', at: new Date().toISOString(), collections: all };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
  return { name: `kinan-backup-${day()}.json.gz`, body: gz, counts: Object.fromEntries(Object.entries(data.collections).map(([k, v]) => [k, v.length])) };
}

function backupRecipient() {
  return process.env.BACKUP_EMAIL || config.adminGoogleEmails?.[0] || config.bootstrapAdminEmail || '';
}

/** Emails today's backup to the owner once a day (Brevo attachments up to ~8 MB). */
async function dailyBackup() {
  const to = backupRecipient();
  if (!to || !mailer.enabled()) return { skipped: 'email not set up' };
  const key = `backup:${day()}`;
  if (db.mail.find((m) => m.key === key)) return { skipped: 'already sent today' };
  const f = backupFile({ withIdPhotos: false });
  if (f.body.length > 8 * 1024 * 1024) {
    require('../push').telegram(`⚠️ Today's backup is ${(f.body.length / 1048576).toFixed(1)} MB — too big for email. Download it from the admin dashboard.`);
    return { skipped: 'too big', size: f.body.length };
  }
  const rec = await mailer.send({ to, key, kind: 'backup', subject: `Kinan backup ${day()}`, title: 'Daily backup',
    lines: [`Attached: all Kinan data on ${day()} (${(f.body.length / 1024).toFixed(0)} KB, compressed).`, `Orders: ${f.counts.orders} · Products: ${f.counts.listings} · Customers and staff: ${f.counts.users}.`, 'Keep this email. It is your copy if anything ever happens to the database.'],
    attachments: [{ name: f.name, content: f.body.toString('base64') }] });
  return { status: rec?.status, size: f.body.length };
}

// ---------------- Invoices ----------------
function invoiceHtml(o) {
  const buyer = db.users.get(o.buyer_id) || {};
  const a = o.shipping_address || {};
  const cur = (o.currency || config.currency).toUpperCase();
  const fmt = (n) => { try { return Number(n).toLocaleString('en-US', { style: 'currency', currency: cur }); } catch { return `${n} ${cur}`; } };
  const no = `KN-${new Date(o.paid_at || o.created_at).getFullYear()}-${o.id.slice(-8).toUpperCase()}`;
  const op = config.operator;
  const rows = o.lines.map((l) => `<tr><td>${esc(l.title)}${l.props ? `<div class="m">${esc(String(l.props).slice(0, 80))}</div>` : ''}</td><td class="r">${l.qty}</td><td class="r">${fmt(l.price)}</td><td class="r">${fmt(l.price * l.qty)}</td></tr>`).join('');
  const line = (label, ar, v, cls = '') => `<tr class="${cls}"><td colspan="3">${label} <span class="ar">${ar}</span></td><td class="r">${v}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${no}</title>
<style>body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#141b3a;margin:0;background:#f4f6f9}.p{max-width:780px;margin:20px auto;background:#fff;padding:32px;border:1px solid #e1e5ee;border-radius:12px}
h1{font-size:22px;margin:0}.top{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}.brand{color:#0e7c66;font-weight:800;font-size:26px}.m{color:#6b7290;font-size:12px}.ar{color:#6b7290;font-size:12px}
table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:8px 6px;border-bottom:1px solid #eef0f5;text-align:start;vertical-align:top}th{font-size:12px;color:#6b7290;font-weight:600}.r{text-align:end;white-space:nowrap}.tot td{font-weight:700;font-size:16px;border-bottom:0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}.btn{display:inline-block;margin:0 0 12px;padding:8px 14px;border-radius:8px;background:#0e7c66;color:#fff;text-decoration:none;font-weight:600;border:0;cursor:pointer}
@media print{body{background:#fff}.p{border:0;margin:0;max-width:none}.noprint{display:none}}</style></head><body><div class="p">
<button class="btn noprint" onclick="print()">Print / Save as PDF · طباعة</button>
<div class="top"><div><div class="brand">kinan</div><div class="m">${esc(op.tradingName)} — ${esc(op.name)}${op.address ? `<br>${esc(op.address)}` : ''}${op.email ? `<br>${esc(op.email)}` : ''}${op.vatNumber ? `<br>VAT ${esc(op.vatNumber)}` : ''}${op.companyNumber ? `<br>Company ${esc(op.companyNumber)}` : ''}</div></div>
<div style="text-align:end"><h1>Invoice <span class="ar">فاتورة</span></h1><div>${no}</div><div class="m">Date: ${day(o.paid_at || o.created_at)}<br>Order: ${o.id.slice(-8).toUpperCase()}</div></div></div>
<div class="cols"><div><b>Bill to <span class="ar">إلى</span></b><div>${esc(a.name || buyer.name || '')}<br>${esc(buyer.email || '')}</div></div>
<div><b>Ship to <span class="ar">عنوان الشحن</span></b><div>${esc(a.name || '')}<br>${esc(a.line1 || '')}${a.line2 ? `, ${esc(a.line2)}` : ''}<br>${esc(a.city || '')} ${esc(a.postal_code || '')}<br>${esc(a.country || '')}</div></div></div>
<table><thead><tr><th>Item <span class="ar">المنتج</span></th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>${rows}
${line('Subtotal', 'المجموع الفرعي', fmt(o.subtotal))}${line('Shipping', 'الشحن', fmt(o.shipping_fee))}${o.packaging_fee ? line('Extra protection', 'حماية إضافية', fmt(o.packaging_fee)) : ''}${o.discount ? line(`Discount${o.coupon_code ? ` (${esc(o.coupon_code)})` : ''}`, 'الخصم', `−${fmt(o.discount)}`) : ''}${line('Total', 'الإجمالي', fmt(o.total), 'tot')}</tbody></table>
<p class="m">${o.paid_at ? `Paid ${day(o.paid_at)} · ${esc({ stripe: 'card', wallet: 'Kinan wallet', demo: 'TEST payment — no money received' }[o.payment?.provider] || o.payment?.provider || '')}` : 'Not paid yet'}. Import duties or VAT charged by the destination country on delivery are not included.</p>
</div></body></html>`;
}

// ---------------- Product views (seller stats) ----------------
const seen = new Map();
/** Count a product page view (one per visitor per product per hour). */
function countView(listing, visitorKey) {
  if (!listing) return;
  const k = `${visitorKey}|${listing.id}`; const now = Date.now();
  if (seen.has(k) && now - seen.get(k) < 3600e3) return;
  seen.set(k, now);
  if (seen.size > 20000) for (const [kk, t] of seen) if (now - t > 3600e3) seen.delete(kk);
  const id = `vw_${listing.id}_${day().replace(/-/g, '')}`;
  if (db.views.get(id)) db.views.update(id, (v) => ({ ...v, n: (v.n || 0) + 1 }));
  else db.views.insert({ id, listing_id: listing.id, seller_id: listing.seller_id, day: day(), n: 1 });
}

/** Last 30 days per product: views, units sold, conversion. */
function sellerStats(seller, days = 30) {
  const since = day(Date.now() - days * 86400e3);
  const views = db.views.all((v) => v.seller_id === seller.id && v.day >= since);
  const t0 = Date.now() - days * 86400e3;
  const sold = new Map();
  for (const o of db.orders.all((x) => x.paid_at && x.paid_at >= t0 && !['cancelled', 'refunded'].includes(x.status))) {
    for (const l of o.lines.filter((x) => x.seller_id === seller.id)) { const s = sold.get(l.listing_id) || { units: 0, orders: new Set(), revenue: 0 }; s.units += l.qty; s.orders.add(o.id); s.revenue = money(s.revenue + l.price * l.qty); sold.set(l.listing_id, s); }
  }
  const perDay = {};
  for (const v of views) perDay[v.day] = (perDay[v.day] || 0) + v.n;
  const products = db.listings.all((l) => l.seller_id === seller.id && ['active', 'paused'].includes(l.status)).map((l) => {
    const vv = views.filter((v) => v.listing_id === l.id).reduce((a, v) => a + v.n, 0); const s = sold.get(l.id);
    return { id: l.id, title: l.title, views: vv, orders: s ? s.orders.size : 0, units: s ? s.units : 0, revenue: s ? s.revenue : 0, conversion: vv ? Math.round(((s ? s.orders.size : 0) / vv) * 1000) / 10 : null };
  }).sort((a, b) => b.views - a.views);
  return { days, views: views.reduce((a, v) => a + v.n, 0), orders: new Set([...sold.values()].flatMap((s) => [...s.orders])).size, revenue: money([...sold.values()].reduce((a, s) => a + s.revenue, 0)), per_day: perDay, products, currency: config.currency };
}

// ---------------- Bulk upload ----------------
/** rows: [{ title, price, stock, cost_cny, option, category, weight_kg, source_link, image_url(s), description }] */
function bulkUpload(seller, rows) {
  const catalog = require('./catalog');
  if (!Array.isArray(rows) || !rows.length) throw httpError(400, 'The file has no products');
  if (rows.length > 200) throw httpError(400, 'Up to 200 rows at a time');
  // Rows with the same title become one product with several options
  const groups = new Map();
  rows.forEach((r, i) => { const t = String(r.title || '').trim(); const g = groups.get(t) || []; g.push({ ...r, _row: i + 2 }); groups.set(t, g); });
  const markup = Number(seller.default_markup_pct ?? 30);
  const out = [];
  for (const [title, g] of groups) {
    const first = g[0];
    try {
      const images = [...new Set(g.flatMap((r) => String(r.image_urls || r.image_url || r.images || '').split(/[\s|,]+/)).filter((u) => /^https:\/\//.test(u)))].slice(0, 6);
      const variants = g.map((r) => {
        const cost = r.cost_cny === '' || r.cost_cny === undefined ? null : Number(r.cost_cny);
        const price = r.price !== '' && r.price !== undefined ? Number(r.price) : cost ? catalog.defaultPrice(cost, markup) : NaN;
        return { name: String(r.option || r.variant || '').trim(), price, stock: r.stock === '' || r.stock === undefined ? 99 : Number(r.stock), cost_cny: cost };
      });
      const l = catalog.publishManual(seller, { title, description: first.description || '', category: first.category || 'other', weight_kg: first.weight_kg || null, source_link: first.source_link || first.link || '', source: /aliexpress/i.test(first.source_link || '') ? 'aliexpress' : 'taobao', images, variants });
      out.push({ row: first._row, title, ok: true, id: l.id, options: variants.length });
    } catch (e) { out.push({ row: first._row, title, ok: false, error: e.message }); }
  }
  return { created: out.filter((x) => x.ok).length, failed: out.filter((x) => !x.ok).length, results: out };
}

module.exports = { backupFile, dailyBackup, backupRecipient, invoiceHtml, countView, sellerStats, bulkUpload };
