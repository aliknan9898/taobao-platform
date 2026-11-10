// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Profit & loss for Kinan (the platform), per period.
 *
 *   Revenue            what customers paid (orders paid in the period, minus cancelled/refunded orders) + extra shipping paid later
 * − Seller earnings    what Kinan owes sellers for those orders (ledger net, incl. refunds charged back to them)
 * − Goods bought       AliExpress and manually added items Kinan buys itself (Taobao-API items are paid by the seller)
 * − Courier costs      real international shipping cost entered at dispatch
 * − Customer credits   refunds and shipping refunds to wallets/cards, goodwill wallet credits (net of deductions)
 * = Profit
 */
const db = require('../db');
const { config } = require('../config');

const money = (n) => Math.round(Number(n) * 100) / 100;
const DAY = 86400e3;

function range({ from, to, days } = {}) {
  const end = to ? new Date(to).getTime() + DAY - 1 : Date.now();
  const start = from ? new Date(from).getTime() : end - (Number(days) || 30) * DAY;
  if (!(start < end)) throw Object.assign(new Error('Invalid period'), { status: 400 });
  return { start, end };
}

const lineCost = (l) => (l.direct ? Number(l.cost_sale || 0) : l.manual && l.cost_cny ? l.cost_cny / config.cnyRate : 0) * l.qty;

function report(q = {}) {
  const { start, end } = range(q);
  const includeTest = q.include_test === '1' || q.include_test === true;
  const inRange = (t) => t >= start && t <= end;
  const all = db.orders.all((o) => o.paid_at && inRange(o.paid_at) && !['cancelled', 'refunded'].includes(o.status));
  const testCount = all.filter((o) => o.payment?.provider === 'demo').length;
  const orders = includeTest ? all : all.filter((o) => o.payment?.provider !== 'demo');
  const ids = new Set(orders.map((o) => o.id));

  const revenue = money(orders.reduce((a, o) => a + o.total + (o.shipping_due_paid || 0), 0));
  const itemsRevenue = money(orders.reduce((a, o) => a + o.subtotal, 0));
  const shippingCharged = money(orders.reduce((a, o) => a + o.shipping_fee + (o.shipping_due_paid || 0), 0));
  const ledger = db.ledger.all((l) => ids.has(l.order_id) && l.status !== 'void');
  const sellerEarnings = money(ledger.reduce((a, l) => a + l.net, 0));
  const commission = money(ledger.filter((l) => l.type === 'sale').reduce((a, l) => a + l.commission, 0));
  const goods = money(orders.reduce((a, o) => a + o.lines.reduce((s, l) => s + lineCost(l), 0), 0));
  const shipments = db.shipments.all((s) => ids.has(s.order_id));
  const courier = money(shipments.reduce((a, s) => a + (Number(s.cost) || 0), 0));
  const shipmentsWithoutCost = shipments.filter((s) => !(Number(s.cost) > 0)).length;
  // Money given back to customers in the period (wallet credits + card refunds from returns)
  const credits = db.wallet.all((w) => inRange(w.created_at) && w.amount > 0 && ['refund', 'shipping_refund', 'adjustment'].includes(w.kind) && (!w.order_id || ids.has(w.order_id) || w.kind === 'adjustment'));
  const debits = db.wallet.all((w) => inRange(w.created_at) && w.kind === 'adjustment' && w.amount < 0);
  const cardRefunds = db.returns.all((r) => r.status === 'refunded' && r.refund_to === 'card' && ids.has(r.order_id));
  // Cancelled orders are already left out of revenue, so their refunds are not counted again
  const customerCredits = money(credits.filter((w) => !(w.kind === 'refund' && /^Refund for order/.test(w.reason))).reduce((a, w) => a + w.amount, 0)
    + cardRefunds.reduce((a, r) => a + (r.refund_amount || 0), 0) + debits.reduce((a, w) => a + w.amount, 0));
  const profit = money(revenue - sellerEarnings - goods - courier - customerCredits);

  // Daily series
  const days = []; const dayStart = new Date(start); dayStart.setHours(0, 0, 0, 0);
  for (let t = dayStart.getTime(); t <= end; t += DAY) {
    const os = orders.filter((o) => o.paid_at >= t && o.paid_at < t + DAY);
    days.push({ date: new Date(t).toISOString().slice(0, 10), revenue: money(os.reduce((a, o) => a + o.total, 0)), orders: os.length });
  }

  // Best sellers
  const prod = {};
  for (const o of orders) for (const l of o.lines) {
    const p = (prod[l.listing_id] = prod[l.listing_id] || { listing_id: l.listing_id, title: l.title, qty: 0, revenue: 0, shop: db.sellers.get(l.seller_id)?.shop_name || '' });
    p.qty += l.qty; p.revenue = money(p.revenue + l.price * l.qty);
  }
  const best = Object.values(prod).sort((a, b) => b.revenue - a.revenue).slice(0, 20);

  // Sellers
  const sel = {};
  for (const o of orders) for (const l of o.lines) {
    const s = (sel[l.seller_id] = sel[l.seller_id] || { seller_id: l.seller_id, shop: db.sellers.get(l.seller_id)?.shop_name || '—', orders: new Set(), items: 0, gross: 0, commission: 0, returns: 0 });
    s.orders.add(o.id); s.items += l.qty; s.gross = money(s.gross + l.price * l.qty);
  }
  for (const l of ledger.filter((x) => x.type === 'sale')) if (sel[l.seller_id]) sel[l.seller_id].commission = money(sel[l.seller_id].commission + l.commission);
  for (const r of db.returns.all((x) => ids.has(x.order_id))) {
    const o = orders.find((x) => x.id === r.order_id);
    for (const sid of new Set(o.lines.filter((l) => r.lines.includes(l.line_no)).map((l) => l.seller_id))) if (sel[sid]) sel[sid].returns++;
  }
  const sellers = Object.values(sel).map((s) => ({ ...s, orders: s.orders.size, return_rate: s.orders.size ? Math.round((s.returns / s.orders.size) * 100) : 0 })).sort((a, b) => b.gross - a.gross);

  // Countries
  const ctry = {};
  for (const o of orders) { const k = o.shipping_address?.country || '—'; const c = (ctry[k] = ctry[k] || { country: k, orders: 0, revenue: 0 }); c.orders++; c.revenue = money(c.revenue + o.total); }
  const countries = Object.values(ctry).sort((a, b) => b.revenue - a.revenue);

  return {
    currency: config.currency, from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10),
    include_test: includeTest, test_orders: testCount,
    totals: { orders: orders.length, revenue, items_revenue: itemsRevenue, shipping_charged: shippingCharged, commission, seller_earnings: sellerEarnings, goods, courier, customer_credits: customerCredits, profit, margin_pct: revenue ? Math.round((profit / revenue) * 100) : 0, avg_order: orders.length ? money(revenue / orders.length) : 0 },
    shipments_without_cost: shipmentsWithoutCost, days, best, sellers, countries
  };
}

/** Orders in the period as CSV (opens in Excel / Google Sheets). */
function ordersCsv(q = {}) {
  const r = report(q);
  const { start, end } = range(q);
  const orders = db.orders.all((o) => o.paid_at && o.paid_at >= start && o.paid_at <= end && !['cancelled', 'refunded'].includes(o.status) && (r.include_test || o.payment?.provider !== 'demo'));
  const cell = (v) => { const s = String(v ?? ''); return /[",\n;]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  const rows = [['order', 'paid_at', 'status', 'customer', 'country', 'shops', 'items', 'subtotal', 'shipping', 'total', 'goods_cost', 'courier_cost', 'seller_earnings', 'payment']];
  for (const o of orders.sort((a, b) => a.paid_at - b.paid_at)) {
    const led = db.ledger.all((l) => l.order_id === o.id && l.status !== 'void');
    const sh = o.shipment_id ? db.shipments.get(o.shipment_id) : null;
    rows.push([o.id, new Date(o.paid_at).toISOString(), o.status, db.users.get(o.buyer_id)?.email || '', o.shipping_address?.country || '',
      [...new Set(o.lines.map((l) => db.sellers.get(l.seller_id)?.shop_name).filter(Boolean))].join(' | '), o.lines.reduce((a, l) => a + l.qty, 0),
      o.subtotal, o.shipping_fee, o.total, money(o.lines.reduce((a, l) => a + lineCost(l), 0)), sh?.cost ?? '', money(led.reduce((a, l) => a + l.net, 0)), o.payment?.provider || '']);
  }
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

module.exports = { report, ordersCsv };
