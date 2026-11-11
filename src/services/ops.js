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
  // Customers in the UK / Europe paid in GBP / EUR: the invoice is in what they paid
  const cur = (o.charge?.currency || o.currency || config.currency).toUpperCase(); const rate = o.charge?.rate || 1;
  const fmt = (n) => { const v = Math.round(Number(n) * rate * 100) / 100; try { return v.toLocaleString('en-US', { style: 'currency', currency: cur }); } catch { return `${v} ${cur}`; } };
  const no = `KN-${new Date(o.paid_at || o.created_at).getFullYear()}-${o.id.slice(-8).toUpperCase()}`;
  const op = config.operator;
  const rows = o.lines.map((l) => `<tr><td>${esc(l.title)}${l.props ? `<div class="m">${esc(String(l.props).slice(0, 80))}</div>` : ''}</td><td class="r">${l.qty}</td><td class="r">${fmt(l.price)}</td><td class="r">${fmt(l.price * l.qty)}</td></tr>`).join('');
  const line = (label, v, cls = '') => `<tr class="${cls}"><td colspan="3">${label}</td><td class="r">${v}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${no}</title>
<style>body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#141b3a;margin:0;background:#f4f6f9}.p{max-width:780px;margin:20px auto;background:#fff;padding:32px;border:1px solid #e1e5ee;border-radius:12px}
h1{font-size:22px;margin:0}.top{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}.brand{color:#0e7c66;font-weight:800;font-size:26px}.m{color:#6b7290;font-size:12px}.ar{color:#6b7290;font-size:12px}
table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:8px 6px;border-bottom:1px solid #eef0f5;text-align:start;vertical-align:top}th{font-size:12px;color:#6b7290;font-weight:600}.r{text-align:end;white-space:nowrap}.tot td{font-weight:700;font-size:16px;border-bottom:0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}.btn{display:inline-block;margin:0 0 12px;padding:8px 14px;border-radius:8px;background:#0e7c66;color:#fff;text-decoration:none;font-weight:600;border:0;cursor:pointer}
@media print{body{background:#fff}.p{border:0;margin:0;max-width:none}.noprint{display:none}}</style></head><body><div class="p">
<a class="btn noprint" href="/invoice/${o.id}.pdf">Download PDF</a> <button class="btn noprint" onclick="print()" style="background:#141b3a">Print</button>
<div class="top"><div><div class="brand">kinan</div><div class="m">${esc(op.tradingName || 'Kinan')}<br>${esc(op.email || 'support@kinan.shop')}${op.vatNumber ? `<br>VAT ${esc(op.vatNumber)}` : ''}${op.companyNumber ? `<br>Company ${esc(op.companyNumber)}` : ''}</div></div>
<div style="text-align:end"><h1>Invoice</h1><div>${no}</div><div class="m">Date: ${day(o.paid_at || o.created_at)}<br>Order: ${o.id.slice(-8).toUpperCase()}</div></div></div>
<div class="cols"><div><b>Bill to</b><div>${esc(a.name || buyer.name || '')}<br>${esc(buyer.email || '')}</div></div>
<div><b>Ship to</b><div>${esc(a.name || '')}<br>${esc(a.line1 || '')}${a.line2 ? `, ${esc(a.line2)}` : ''}<br>${esc(a.city || '')} ${esc(a.postal_code || '')}<br>${esc(a.country || '')}</div></div></div>
<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>${rows}
${line('Subtotal', fmt(o.subtotal))}${line('Shipping', fmt(o.shipping_fee))}${o.packaging_fee ? line('Extra protection', fmt(o.packaging_fee)) : ''}${o.discount ? line(`Discount${o.coupon_code ? ` (${esc(o.coupon_code)})` : ''}`, `−${fmt(o.discount)}`) : ''}${line('Total', fmt(o.total), 'tot')}</tbody></table>
<p class="m">${o.paid_at ? `Paid ${day(o.paid_at)} · ${esc({ stripe: 'card', wallet: 'Kinan wallet', demo: 'TEST payment — no money received' }[o.payment?.provider] || o.payment?.provider || '')}` : 'Not paid yet'}. Import duties or VAT charged by the destination country on delivery are not included.</p>
</div></body></html>`;
}

/** Invoice number shown to the customer. */
const invoiceNo = (o) => `KN-${new Date(o.paid_at || o.created_at).getFullYear()}-${o.id.slice(-8).toUpperCase()}`;

/** The invoice as a PDF with the Kinan logo (sent by email after payment, and downloadable from the order). */
function invoicePdf(o) {
  const { PDF } = require('../pdf');
  const buyer = db.users.get(o.buyer_id) || {};
  const a = o.shipping_address || {};
  const cur = (o.charge?.currency || o.currency || config.currency).toUpperCase(); const rate = o.charge?.rate || 1;
  const fmt = (n) => { const v = Math.round(Number(n) * rate * 100) / 100; try { return v.toLocaleString('en-US', { style: 'currency', currency: cur }); } catch { return `${v.toFixed(2)} ${cur}`; } };
  const no = invoiceNo(o); const op = config.operator;
  const INK = '#141b3a'; const MUTED = '#6b7290'; const JADE = '#0e7c66'; const LINE = '#e1e5ee';
  const doc = new PDF({ title: `Kinan invoice ${no}`, author: 'Kinan' });
  const L = 48; const R = doc.w - 48; let y;

  const header = (first) => {
    // Logo: the Kinan "K" mark
    doc.rect(L, 40, 46, 46, { fill: JADE, radius: 11.5 });
    doc.path('M20 15h8v14l13-14h10L36.5 30.5 52 49H41.5L28 33v16h-8z', L, 40, 46 / 64, { fill: '#ffffff' });
    doc.circle(L + 49 * 46 / 64, 40 + 15 * 46 / 64, 6 * 46 / 64, { fill: '#f4b400' });
    doc.text('kinan', L + 58, 72, { size: 26, bold: true, color: INK });
    doc.text('INVOICE', R, 70, { size: 20, bold: true, color: INK, align: 'right' });
    if (!first) { doc.text(no, R, 96, { size: 9, color: MUTED, align: 'right' }); return 120; }
    let yy = 108;
    // The owner's personal name and home address are not printed on customer invoices
    for (const t of [op.tradingName || 'Kinan', op.email || 'support@kinan.shop', op.vatNumber ? `VAT ${op.vatNumber}` : '', op.companyNumber ? `Company ${op.companyNumber}` : '', 'kinan.shop'].filter(Boolean)) { doc.text(t, L, yy, { size: 8.5, color: MUTED }); yy += 12; }
    const meta = [['Invoice no.', no], ['Date', day(o.paid_at || o.created_at)], ['Order', o.id.slice(-8).toUpperCase()]];
    meta.forEach(([k, v], i) => { doc.text(k, R - 150, 108 + i * 14, { size: 9, color: MUTED }); doc.text(v, R, 108 + i * 14, { size: 9, bold: true, align: 'right' }); });
    return Math.max(yy, 108 + meta.length * 14) + 14;
  };
  y = header(true);

  // Bill to / Ship to
  const col = (x, label, rows) => {
    doc.text(label, x, y, { size: 9, bold: true, color: JADE });
    let yy = y + 15;
    for (const r of rows.filter(Boolean)) for (const ln of doc.wrap(r, 220, 9.5)) { doc.text(ln, x, yy, { size: 9.5 }); yy += 13; }
    return yy;
  };
  const yb = col(L, 'BILL TO', [a.name || buyer.name, buyer.email]);
  const ys = col(L + 260, 'SHIP TO', [a.name, [a.line1, a.line2].filter(Boolean).join(', '), [a.city, a.state, a.postal_code].filter(Boolean).join(' '), a.country || a.country_code, a.phone]);
  y = Math.max(yb, ys) + 16;

  // Items table
  const cQty = R - 170; const cPrice = R - 95; const tableHead = () => {
    doc.rect(L, y, R - L, 24, { fill: '#e3f2ee', radius: 6 });
    doc.text('Item', L + 10, y + 16, { size: 9, bold: true });
    doc.text('Qty', cQty, y + 16, { size: 9, bold: true, align: 'right' }); doc.text('Price', cPrice, y + 16, { size: 9, bold: true, align: 'right' }); doc.text('Amount', R - 10, y + 16, { size: 9, bold: true, align: 'right' });
    y += 36;
  };
  tableHead();
  for (const l of o.lines) {
    const title = doc.wrap(l.title, cQty - L - 60, 9.5); const opt = l.props ? doc.wrap(String(l.props).slice(0, 120), cQty - L - 60, 8) : [];
    const h = title.length * 13 + opt.length * 11 + 10;
    if (y + h > doc.h - 170) { doc.addPage(); y = header(false); tableHead(); }
    title.forEach((t, i) => doc.text(t, L + 10, y + i * 13, { size: 9.5 }));
    opt.forEach((t, i) => doc.text(t, L + 10, y + title.length * 13 + i * 11, { size: 8, color: MUTED }));
    doc.text(String(l.qty), cQty, y, { size: 9.5, align: 'right' }); doc.text(fmt(l.price), cPrice, y, { size: 9.5, align: 'right' }); doc.text(fmt(l.price * l.qty), R - 10, y, { size: 9.5, align: 'right' });
    y += h; doc.line(L, y - 6, R, y - 6, { color: LINE, width: 0.6 }); y += 6;
  }

  // Totals
  if (y > doc.h - 200) { doc.addPage(); y = header(false); }
  y += 6; const tx = R - 230;
  const sum = (label, v, strong) => {
    doc.text(label, tx, y, { size: strong ? 11 : 9.5, bold: strong, color: strong ? INK : MUTED });
    doc.text(v, R - 10, y, { size: strong ? 12 : 9.5, bold: strong, align: 'right', color: strong ? JADE : INK }); y += strong ? 20 : 16;
  };
  sum('Subtotal', fmt(o.subtotal));
  sum('Shipping', fmt(o.shipping_fee));
  if (o.packaging_fee) sum('Extra protection', fmt(o.packaging_fee));
  if (o.discount) sum(`Discount${o.coupon_code ? ` (${o.coupon_code})` : ''}`, `−${fmt(o.discount)}`);
  doc.line(tx, y - 8, R, y - 8, { color: LINE, width: 0.8 }); y += 6;
  sum('Total', fmt(o.total), true);

  // Payment status + footer
  y += 10;
  const method = { stripe: 'card', wallet: 'Kinan wallet', demo: 'TEST payment — no money received' }[o.payment?.provider] || o.payment?.provider || '';
  const paidLine = o.paid_at ? `Paid ${day(o.paid_at)}${method ? ` · ${method}` : ''}${o.payment?.mode === 'test' ? ' (test mode)' : ''}` : 'Not paid yet';
  doc.rect(L, y, R - L, 28, { fill: o.paid_at ? '#e8f5ee' : '#fff4e0', radius: 6 });
  doc.text(paidLine, L + 12, y + 18, { size: 9.5, bold: true, color: o.paid_at ? '#1f7a4d' : '#9a6400' });
  y += 44;
  for (const t of doc.wrap('Import duties or VAT charged by the destination country on delivery are not included.', R - L, 8)) { doc.text(t, L, y, { size: 8, color: MUTED }); y += 11; }
  const fy = doc.h - 54;
  doc.line(L, fy - 16, R, fy - 16, { color: LINE, width: 0.6 });
  doc.text('Thank you for shopping with Kinan', L, fy, { size: 9.5, bold: true, color: JADE });
  doc.text(`Questions? ${op.email || 'support@kinan.shop'} · kinan.shop`, L, fy + 14, { size: 8, color: MUTED });
  return { name: `Kinan-invoice-${no}.pdf`, body: doc.toBuffer() };
}

// ---------------- Seller account statement ----------------
/** The Kinan mark: rounded square with the K and the yellow dot. */
function drawLogo(doc, x, y, size) {
  const k = size / 64;
  doc.rect(x, y, size, size, { fill: '#0e7c66', radius: size / 4 });
  doc.path('M20 15h8v14l13-14h10L36.5 30.5 52 49H41.5L28 33v16h-8z', x, y, k, { fill: '#ffffff' });
  doc.circle(x + 49 * k, y + 15 * k, 6 * k, { fill: '#f4b400' });
}

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
/** Statement period from ?from=&to= (YYYY-MM-DD, inclusive); default: this month so far. */
function statementPeriod(from, to) {
  const now = new Date();
  const f = isDay(from) ? from : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const t = isDay(to) ? to : day();
  if (f > t) throw httpError(400, 'The start date is after the end date');
  return { from: f, to: t, start: Date.parse(`${f}T00:00:00Z`), end: Date.parse(`${t}T00:00:00Z`) + 86400e3 };
}

/**
 * Account statement for a seller as a PDF: opening balance, every sale / refund / withdrawal in the period
 * with a running balance, and the closing balance. Balance = everything earned (sales after Kinan's
 * commission and purchase cost, minus refunds) less withdrawals already sent.
 */
function sellerStatementPdf(seller, { from, to } = {}) {
  const { PDF } = require('../pdf');
  const per = statementPeriod(from, to);
  const cur = String(config.currency).toUpperCase();
  const fmt = (n) => { const v = Math.round(Number(n) * 100) / 100; try { return v.toLocaleString('en-US', { style: 'currency', currency: cur }); } catch { return `${v.toFixed(2)} ${cur}`; } };
  const led = db.ledger.all((l) => l.seller_id === seller.id && l.status !== 'void');
  const paid = db.payouts.all((p) => p.seller_id === seller.id && p.status === 'paid');
  const at = (x) => x.created_at || 0; const pAt = (p) => p.paid_at || p.updated_at || p.created_at || 0;
  const opening = led.filter((l) => at(l) < per.start).reduce((a, l) => a + l.net, 0) - paid.filter((p) => pAt(p) < per.start).reduce((a, p) => a + p.amount, 0);
  const STATUS = { pending_payout: 'on the way', payable: 'available', paid: 'paid out' };
  const rows = [
    ...led.filter((l) => at(l) >= per.start && at(l) < per.end).map((l) => ({ at: at(l), kind: l.type === 'refund' ? 'Refund' : 'Sale', desc: `${l.type === 'refund' ? 'Refund' : 'Sale'} — order ${String(l.order_id).slice(-8).toUpperCase()}`, note: STATUS[l.status] || l.status, gross: l.gross, commission: l.commission, cost: l.cost, net: l.net })),
    ...paid.filter((p) => pAt(p) >= per.start && pAt(p) < per.end).map((p) => ({ at: pAt(p), kind: 'Withdrawal', desc: `Withdrawal${p.details?.method === 'bank' && p.details.iban ? ` to IBAN …${String(p.details.iban).slice(-4)}` : p.details?.email ? ` to ${p.details.method === 'paypal' ? 'PayPal' : 'Wise'}` : ''}`, note: p.reference ? `ref. ${p.reference}` : '', gross: null, commission: null, cost: null, net: -p.amount }))
  ].sort((a, b) => a.at - b.at);
  const tot = (k, f = () => true) => rows.filter(f).reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const sales = tot('gross', (r) => r.kind === 'Sale'); const commission = tot('commission'); const cost = tot('cost');
  const refunds = tot('net', (r) => r.kind === 'Refund'); const withdrawals = tot('net', (r) => r.kind === 'Withdrawal');
  const closing = opening + tot('net');
  const bal = require('./money').sellerBalance(seller.id);
  const owner = db.users.get(seller.user_id) || {};

  const INK = '#141b3a'; const MUTED = '#6b7290'; const JADE = '#0e7c66'; const LINE = '#e1e5ee';
  const doc = new PDF({ title: `Kinan statement ${seller.shop_name || ''} ${per.from} to ${per.to}`, author: 'Kinan' });
  const L = 40; const R = doc.w - 40; let y;
  const header = (first) => {
    drawLogo(doc, L, 36, 42);
    doc.text('kinan', L + 52, 66, { size: 24, bold: true, color: INK });
    doc.text('ACCOUNT STATEMENT', R, 58, { size: 16, bold: true, color: INK, align: 'right' });
    doc.text(`${per.from}  to  ${per.to}`, R, 74, { size: 9, color: MUTED, align: 'right' });
    if (!first) return 100;
    doc.text(seller.shop_name || 'Shop', L, 104, { size: 11, bold: true });
    doc.text(owner.email || '', L, 118, { size: 9, color: MUTED });
    doc.text(`Seller ID ${String(seller.id).slice(-8).toUpperCase()}`, L, 131, { size: 9, color: MUTED });
    doc.text(`Issued ${day()}`, R, 104, { size: 9, color: MUTED, align: 'right' });
    doc.text(`Currency ${cur}`, R, 118, { size: 9, color: MUTED, align: 'right' });
    return 150;
  };
  y = header(true);

  // Summary
  const box = (x, w, label, value, color = INK) => { doc.rect(x, y, w, 46, { fill: '#f4f6f9', radius: 8 }); doc.text(label, x + 10, y + 17, { size: 8, color: MUTED }); doc.text(value, x + 10, y + 36, { size: 12, bold: true, color }); };
  const bw = (R - L - 18) / 4;
  box(L, bw, 'Opening balance', fmt(opening)); box(L + bw + 6, bw, 'Earned in period', fmt(sales - commission - cost + refunds), JADE);
  box(L + 2 * (bw + 6), bw, 'Withdrawals sent', fmt(-withdrawals)); box(L + 3 * (bw + 6), bw, 'Closing balance', fmt(closing), JADE);
  y += 60;
  const kv = [['Sales', fmt(sales)], ['Kinan commission', `−${fmt(commission)}`], ['Purchase cost', cost ? `−${fmt(cost)}` : fmt(0)], ['Refunds', fmt(refunds)]];
  kv.forEach(([k, v], i) => { const x = L + i * ((R - L) / 4); doc.text(k, x, y, { size: 8, color: MUTED }); doc.text(v, x, y + 13, { size: 9.5, bold: true }); });
  y += 32;

  // Transactions
  const C = { date: L + 6, desc: L + 66, sales: R - 250, comm: R - 185, cost: R - 125, net: R - 62, bal: R - 6 };
  const head = () => {
    doc.rect(L, y, R - L, 22, { fill: '#e3f2ee', radius: 6 });
    const hy = y + 15; const o = { size: 8, bold: true };
    doc.text('Date', C.date, hy, o); doc.text('Description', C.desc, hy, o); doc.text('Sales', C.sales, hy, { ...o, align: 'right' }); doc.text('Commission', C.comm, hy, { ...o, align: 'right' });
    doc.text('Cost', C.cost, hy, { ...o, align: 'right' }); doc.text('Amount', C.net, hy, { ...o, align: 'right' }); doc.text('Balance', C.bal, hy, { ...o, align: 'right' });
    y += 32;
  };
  head();
  doc.text('Opening balance', C.desc, y, { size: 8.5, color: MUTED }); doc.text(fmt(opening), C.bal, y, { size: 8.5, bold: true, align: 'right' }); y += 8;
  doc.line(L, y, R, y, { color: LINE, width: 0.5 }); y += 14;
  let run = opening;
  for (const r of rows) {
    if (y > doc.h - 90) { doc.addPage(); y = header(false); head(); }
    run += r.net;
    doc.text(day(r.at), C.date, y, { size: 8.5 });
    doc.text(r.desc, C.desc, y, { size: 8.5, bold: r.kind === 'Withdrawal' });
    if (r.note) doc.text(r.note, C.desc, y + 10, { size: 7, color: MUTED });
    if (r.gross !== null) { doc.text(fmt(r.gross), C.sales, y, { size: 8.5, align: 'right' }); doc.text(r.commission ? `−${fmt(r.commission)}` : '—', C.comm, y, { size: 8.5, color: MUTED, align: 'right' }); doc.text(r.cost ? `−${fmt(r.cost)}` : '—', C.cost, y, { size: 8.5, color: MUTED, align: 'right' }); }
    doc.text(fmt(r.net), C.net, y, { size: 8.5, bold: true, align: 'right', color: r.net < 0 ? '#b42318' : INK });
    doc.text(fmt(run), C.bal, y, { size: 8.5, align: 'right' });
    y += r.note ? 14 : 8; doc.line(L, y, R, y, { color: LINE, width: 0.5 }); y += 14;
  }
  if (!rows.length) { doc.text('No transactions in this period.', C.desc, y, { size: 9, color: MUTED }); y += 22; }
  if (y > doc.h - 150) { doc.addPage(); y = header(false); }
  doc.rect(L, y, R - L, 26, { fill: '#e8f5ee', radius: 6 });
  doc.text('Closing balance', L + 12, y + 17, { size: 10, bold: true, color: '#1f7a4d' }); doc.text(fmt(closing), R - 12, y + 17, { size: 11, bold: true, color: '#1f7a4d', align: 'right' });
  y += 44;
  doc.text(`Today: available to withdraw ${fmt(bal.available)} · on the way ${fmt(bal.pending)} · withdrawal in progress ${fmt(bal.requested)}`, L, y, { size: 8, color: MUTED }); y += 12;
  for (const t of doc.wrap('Sales are your sale price; Kinan’s commission and, for items Kinan buys for you, the purchase cost are deducted. Earnings become available when the customer receives the order. Withdrawals appear on the date they were sent.', R - L, 7.5)) { doc.text(t, L, y, { size: 7.5, color: MUTED }); y += 10; }
  doc.line(L, doc.h - 56, R, doc.h - 56, { color: LINE, width: 0.6 });
  doc.text('Kinan Seller Center · kinan.shop/seller', L, doc.h - 40, { size: 8, color: MUTED });
  doc.text('support@kinan.shop', R, doc.h - 40, { size: 8, color: MUTED, align: 'right' });
  const safe = String(seller.shop_name || 'shop').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';
  return { name: `Kinan-statement-${safe}-${per.from}_${per.to}.pdf`, body: doc.toBuffer() };
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

module.exports = { backupFile, dailyBackup, backupRecipient, invoiceHtml, invoicePdf, invoiceNo, sellerStatementPdf, statementPeriod, countView, sellerStats, bulkUpload };
