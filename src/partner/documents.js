// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
/* Partner order documents (Batch 3): pro-forma invoice, packing slip and credit notes as PDF.
 * Sandbox documents carry a "SANDBOX — NOT A TAX DOCUMENT" banner on every page. Live tax documents need the owner's
 * decision on the invoicing entity, VAT registration and numbering, so live requests answer 503 until then.
 * Only the packing slip shows the recipient (it travels with the parcel); the other documents show city and country. */
'use strict';
const fs = require('fs');
const path = require('path');
const pg = require('./pg');
const orders = require('./orders');
const catalog = require('./catalog');
const { PartnerError } = catalog;
const { open } = orders.internal;

const INK = '#172923'; const MUTED = '#55655e'; const JADE = '#036747'; const LINE = '#e3e9e4'; const SOFT = '#e8f3ec';
let LOGO = null;
const eur = (minor) => `€${(Number(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => new Date(d).toISOString().slice(0, 10);

async function load(ctx, orderId) {
  if (ctx.env !== 'sandbox') throw new PartnerError(503, 'TEMPORARILY_UNAVAILABLE', 'Live documents are not available yet', 'Tax documents for live orders start once KINAN’s invoicing entity is set up.');
  const o = (await pg.q('SELECT * FROM partner_order WHERE id = $1 AND env = $2 AND store_id = $3', [orderId, ctx.env, ctx.store.id])).rows[0];
  if (!o) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Order not found');
  const credits = (await pg.q(`SELECT id, rma_number, items, credit_minor, updated_at FROM partner_return WHERE order_id = $1 AND state = 'credited' ORDER BY created_at`, [o.id])).rows;
  const cancel = (await pg.q(`SELECT id, decided_at FROM partner_cancellation WHERE order_id = $1 AND state = 'accepted'`, [o.id])).rows[0];
  return { o, credits, cancel };
}

/** The documents available for an order right now. */
async function list(ctx, orderId) {
  const { o, credits, cancel } = await load(ctx, orderId);
  const link = (id) => `/api/partner/v1/orders/${o.id}/documents/${id}`;
  const docs = [{ document_id: 'proforma', type: 'proforma_invoice', title: 'Pro-forma invoice', created_at: new Date(o.created_at).toISOString(), content_type: 'application/pdf', links: { download: link('proforma') } }];
  if (['processing', 'partially_shipped', 'shipped', 'delivered', 'exception'].includes(o.fulfillment_state)) docs.push({ document_id: 'packing_slip', type: 'packing_slip', title: 'Packing slip', created_at: new Date(o.updated_at).toISOString(), content_type: 'application/pdf', links: { download: link('packing_slip') } });
  if (cancel && o.payment_state === 'credited' && !credits.length) docs.push({ document_id: 'credit_cancellation', type: 'credit_note', title: 'Credit note (cancellation)', created_at: new Date(cancel.decided_at).toISOString(), content_type: 'application/pdf', links: { download: link('credit_cancellation') } });
  for (const r of credits) docs.push({ document_id: `credit_${r.id}`, type: 'credit_note', title: `Credit note ${r.rma_number}`, created_at: new Date(r.updated_at).toISOString(), content_type: 'application/pdf', links: { download: link(`credit_${r.id}`) } });
  return { data: docs, sandbox: true };
}

function titleOf(env, variantId) { const f = catalog.findVariant(env, variantId); const t = f?.base?.title; return (t && (t.en || Object.values(t)[0])) || variantId; }
function skuOf(env, variantId) { return catalog.findVariant(env, variantId)?.variant?.sku || ''; }

/** Render one document; returns { name, body } (PDF bytes). */
async function render(ctx, orderId, documentId) {
  const { o, credits, cancel } = await load(ctx, orderId);
  const available = (await list(ctx, orderId)).data.map((d) => d.document_id);
  if (!available.includes(documentId)) throw new PartnerError(404, 'RESOURCE_NOT_FOUND', 'Document not found', `Available now: ${available.join(', ')}`);
  const { PDF } = require('../pdf');
  const kind = documentId === 'proforma' ? 'PRO-FORMA INVOICE' : documentId === 'packing_slip' ? 'PACKING SLIP' : 'CREDIT NOTE';
  const ret = documentId.startsWith('credit_pr_') ? credits.find((r) => `credit_${r.id}` === documentId) : null;
  const ship = open(o.env, o.ship_to);
  const doc = new PDF({ title: `KINAN ${kind.toLowerCase()} ${o.id}`, author: 'KINAN' });
  const L = 48; const R = doc.w - 48; let y;
  if (!LOGO) LOGO = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'assets', 'logo-main.jpg'));
  const header = () => {
    doc.rect(0, 0, doc.w, 22, { fill: '#fff4e0' });
    doc.text('SANDBOX — NOT A TAX DOCUMENT · test data only', doc.w / 2, 15, { size: 8.5, bold: true, color: '#9a6400', align: 'center' });
    doc.image(LOGO, L, 40, 46, 46);
    doc.text('KINAN', L + 56, 72, { size: 24, bold: true, color: INK });
    doc.text(kind, R, 70, { size: 17, bold: true, color: INK, align: 'right' });
    const meta = [['Order', o.id], ['Your reference', o.external_order_ref], ['Date', day(ret ? ret.updated_at : documentId === 'credit_cancellation' ? cancel.decided_at : o.created_at)], ...(ret ? [['RMA', ret.rma_number]] : [])];
    meta.forEach(([k, v], i) => { doc.text(k, R - 230, 104 + i * 14, { size: 9, color: MUTED }); doc.text(String(v), R, 104 + i * 14, { size: 9, bold: true, align: 'right' }); });
    doc.text('KINAN B2B · partners@kinan.shop · kinan.shop', L, 104, { size: 8.5, color: MUTED });
    return 104 + meta.length * 14 + 18;
  };
  y = header();
  doc.text(documentId === 'packing_slip' ? 'SHIP TO' : 'DELIVERY TO', L, y, { size: 9, bold: true, color: JADE }); y += 15;
  const to = documentId === 'packing_slip' ? [ship.recipient, [ship.line1, ship.line2].filter(Boolean).join(', '), `${ship.postal_code} ${ship.city}`, ship.country] : [`${ship.postal_code || ''} ${ship.city || ''}`.trim(), ship.country];
  for (const t of to.filter(Boolean)) { doc.text(String(t), L, y, { size: 9.5 }); y += 13; }
  y += 14;

  const priced = documentId !== 'packing_slip';
  const lines = ret ? ret.items.map((l) => ({ ...l, unit_ex_tax_minor: (o.commercial.items.find((x) => x.variant_id === l.variant_id) || {}).unit_ex_tax_minor || 0 })) : o.commercial.items;
  const cQty = priced ? R - 170 : R - 10; const cPrice = R - 95;
  const head = () => {
    doc.rect(L, y, R - L, 24, { fill: SOFT, radius: 6 });
    doc.text('Item', L + 10, y + 16, { size: 9, bold: true }); doc.text('Qty', cQty, y + 16, { size: 9, bold: true, align: 'right' });
    if (priced) { doc.text('Unit ex tax', cPrice, y + 16, { size: 9, bold: true, align: 'right' }); doc.text('Amount', R - 10, y + 16, { size: 9, bold: true, align: 'right' }); }
    y += 36;
  };
  head();
  for (const l of lines) {
    if (y > doc.h - 170) { doc.addPage(); y = header(); head(); }
    const t = doc.wrap(titleOf(o.env, l.variant_id), cQty - L - 70, 9.5);
    t.forEach((s, i) => doc.text(s, L + 10, y + i * 13, { size: 9.5 }));
    doc.text(`${skuOf(o.env, l.variant_id)}  ${l.variant_id}`, L + 10, y + t.length * 13, { size: 7.5, color: MUTED });
    doc.text(String(l.quantity), cQty, y, { size: 9.5, align: 'right' });
    if (priced) { doc.text(eur(l.unit_ex_tax_minor), cPrice, y, { size: 9.5, align: 'right' }); doc.text(eur(l.unit_ex_tax_minor * l.quantity), R - 10, y, { size: 9.5, align: 'right' }); }
    y += t.length * 13 + 18; doc.line(L, y - 6, R, y - 6, { color: LINE, width: 0.6 }); y += 4;
  }
  if (priced) {
    if (y > doc.h - 200) { doc.addPage(); y = header(); }
    const T = o.commercial.totals; const tx = R - 240; y += 6;
    const sum = (label, v, strong) => { doc.text(label, tx, y, { size: strong ? 11 : 9.5, bold: strong, color: strong ? INK : MUTED }); doc.text(v, R - 10, y, { size: strong ? 12 : 9.5, bold: strong, align: 'right', color: strong ? JADE : INK }); y += strong ? 20 : 16; };
    if (ret) sum('Credit (goods, ex tax)', `−${eur(ret.credit_minor)}`, true);
    else if (documentId === 'credit_cancellation') sum('Credit (whole order)', `−${eur(T.payable_minor)}`, true);
    else {
      sum('Goods ex tax', eur(T.items_ex_tax_minor)); sum('Shipping ex tax', eur(T.shipping_ex_tax_minor));
      if (T.handling_minor) sum('Import handling', eur(T.handling_minor));
      if (T.duties_minor) sum('Duties', eur(T.duties_minor));
      sum('Tax', eur(T.tax_minor)); doc.line(tx, y - 8, R, y - 8, { color: LINE, width: 0.8 }); y += 6;
      sum('Payable', eur(T.payable_minor), true);
    }
    y += 10;
    for (const t of doc.wrap(ret ? 'Shipping is not credited for returns. This sandbox credit note is test data and has no accounting effect.' : 'Prices are wholesale, before tax, as quoted. This sandbox document is test data: no payment is due and it is not a tax invoice.', R - L, 8)) { doc.text(t, L, y, { size: 8, color: MUTED }); y += 11; }
  } else {
    y += 10; for (const t of doc.wrap('No prices on packing slips. Please check the contents on arrival.', R - L, 8)) { doc.text(t, L, y, { size: 8, color: MUTED }); y += 11; }
  }
  const fy = doc.h - 54; doc.line(L, fy - 16, R, fy - 16, { color: LINE, width: 0.6 });
  doc.text('KINAN Partner API', L, fy, { size: 9.5, bold: true, color: JADE }); doc.text('Generated for your store · kinan.shop', L, fy + 14, { size: 8, color: MUTED });
  return { name: `KINAN-${documentId}-${o.id}.pdf`, body: doc.toBuffer() };
}

module.exports = { list, render };
