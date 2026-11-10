// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const db = require('../db');
const { config, configProblems } = require('../config');
const sellerAuth = require('../taobao/sellerAuth');
const orders = require('./orders');
const { httpError, publicUser } = require('../auth');

const money = (n) => Math.round(Number(n) * 100) / 100;
const DAY = 86400e3;

function overview() {
  const all = db.orders.all();
  const paid = all.filter((o) => !['pending_payment', 'cancelled'].includes(o.status));
  const since = Date.now() - 30 * DAY;
  const recent = paid.filter((o) => (o.paid_at || o.created_at) >= since);
  const led = db.ledger.all((l) => l.status !== 'void');
  const byStatus = {};
  for (const o of all) byStatus[o.status] = (byStatus[o.status] || 0) + 1;

  // Daily revenue for the last 14 days
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - i);
    const end = start.getTime() + DAY;
    days.push({ date: `${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`, revenue: money(paid.filter((o) => (o.paid_at || 0) >= start.getTime() && (o.paid_at || 0) < end).reduce((a, o) => a + o.total, 0)) });
  }

  const alerts = [];
  for (const o of all.filter((x) => x.status === 'attention')) alerts.push({ kind: 'order', id: o.id, text: `Order ${o.id.slice(-8)} needs attention` });
  for (const o of all) for (const s of o.sub_orders || []) {
    if (/WAIT_BUYER_P/.test(s.status) && s.pay_deadline && Number(s.pay_deadline) - Date.now() < 6 * 3600e3) {
      alerts.push({ kind: 'pay_deadline', id: o.id, text: `Purchase order ${s.outer_purchase_id} payment deadline is close — ${db.sellers.get(s.seller_id)?.shop_name || ''}` });
    }
  }
  for (const s of db.sellers.all((x) => x.status === 'active')) {
    const st = sellerAuth.status(s);
    if (!st.connected) alerts.push({ kind: 'seller_auth', id: s.id, text: `Seller ${s.shop_name} is not connected to the Distribution Platform` });
    else if (st.needs_reauth_soon) alerts.push({ kind: 'seller_auth', id: s.id, text: `${s.shop_name}'s authorization expires within a week` });
  }
  const pendingListings = db.listings.all((l) => l.status === 'pending_review').length;
  if (pendingListings) alerts.push({ kind: 'listings', text: `${pendingListings} product(s) awaiting your approval before buyers can see them` });
  for (const o of all) for (const s of (o.sub_orders || []).filter((x) => x.direct)) {
    if (!['cancelled', 'refunded'].includes(o.status) && s.status === 'AE_TO_BUY' && o.status !== 'pending_payment') alerts.push({ kind: 'order', id: o.id, text: `Order ${o.id.slice(-8)}: AliExpress item to order${s.error ? ` (${s.error})` : ''}` });
    if (s.status === 'AE_PLACED') alerts.push({ kind: 'pay_deadline', id: o.id, text: `Order ${o.id.slice(-8)}: pay the AliExpress order ${(s.purchase_ids || []).join(', ')}` });
  }
  const payReq = db.payouts.all((p) => p.status === 'requested');
  if (payReq.length) alerts.push({ kind: 'payouts', text: `${payReq.length} seller withdrawal request(s) to pay` });
  const retReq = db.returns.all((r) => r.status === 'requested');
  if (retReq.length) alerts.push({ kind: 'returns', text: `${retReq.length} return request(s) to review` });
  const newRequests = db.requests.all((r) => r.status === 'new').length;
  if (newRequests) alerts.push({ kind: 'requests', text: `${newRequests} customer item request(s) waiting for a reply` });
  const pendingSellers = db.sellers.all((s) => s.status === 'pending').length;
  if (pendingSellers) alerts.push({ kind: 'sellers', text: `${pendingSellers} seller(s) awaiting approval` });

  return {
    currency: config.currency,
    kpis: {
      revenue_30d: money(recent.reduce((a, o) => a + o.total, 0)),
      orders_30d: recent.length,
      commission_total: money(led.reduce((a, l) => a + l.commission, 0)),
      payable_to_sellers: money(db.sellers.all().reduce((a, x) => { const b = require('./money').sellerBalance(x.id); return a + b.available + b.requested; }, 0)),
      active_sellers: db.sellers.all((s) => s.status === 'active').length,
      buyers: db.users.all((u) => u.role === 'buyer').length,
      listings: db.listings.all((l) => l.status === 'active').length,
      listings_pending: db.listings.all((l) => l.status === 'pending_review').length
    },
    by_status: byStatus,
    daily: days,
    alerts,
    config_problems: configProblems(),
    webhook_urls: { taobao: `${config.publicBaseUrl}/webhooks/taobao`, stripe: `${config.publicBaseUrl}/webhooks/stripe`, oauth_callback: config.redirectUri },
    inbox_backlog: db.inbox.all((m) => !m.processed).length
  };
}

function sellers() {
  return db.sellers.all().map((s) => {
    const u = db.users.get(s.user_id);
    const led = db.ledger.all((l) => l.seller_id === s.id && l.status !== 'void');
    return {
      id: s.id, shop_name: s.shop_name, status: s.status, commission_pct: s.commission_pct, auto_pay: s.auto_pay,
      email: u?.email, created_at: s.created_at, taobao: sellerAuth.status(s),
      listings: db.listings.all((l) => l.seller_id === s.id && l.status === 'active').length,
      gross: money(led.reduce((a, l) => a + l.gross, 0)), net: money(led.reduce((a, l) => a + l.net, 0))
    };
  });
}

function updateSeller(id, { status, commission_pct }) {
  const s = db.sellers.get(id);
  if (!s) throw httpError(404, 'Seller not found');
  const patch = {};
  if (status !== undefined) {
    if (!['pending', 'active', 'suspended'].includes(status)) throw httpError(400, 'Invalid status');
    patch.status = status;
  }
  if (commission_pct !== undefined) {
    const c = Number(commission_pct);
    if (!(c >= 0 && c <= 50)) throw httpError(400, 'Commission must be between 0 and 50%');
    patch.commission_pct = c;
  }
  const out = db.sellers.update(id, patch);
  if (patch.status === 'active' && s.status !== 'active') require('../notify').sellerApproved(out);
  return out;
}

function listOrders({ status } = {}) {
  return db.orders.all((o) => !status || o.status === status)
    .sort((a, b) => b.created_at - a.created_at)
    .map((o) => ({
      id: o.id, status: o.status, status_label: orders.ORDER_STATUS_LABEL[o.status], total: o.total, currency: o.currency,
      created_at: o.created_at, buyer: db.users.get(o.buyer_id)?.email, items: o.lines.reduce((a, l) => a + l.qty, 0),
      shops: [...new Set(o.lines.map((l) => db.sellers.get(l.seller_id)?.shop_name))].filter(Boolean),
      destination: `${o.shipping_address.city}, ${o.shipping_address.country}`
    }));
}

/** Admin sees cost & margin to judge each product before approving it. */
function listings({ status } = {}) {
  return db.listings.all((l) => !status || l.status === status)
    .sort((a, b) => (b.review?.submitted_at || b.created_at) - (a.review?.submitted_at || a.created_at))
    .map((l) => ({
      ...l,
      shop: db.sellers.get(l.seller_id)?.shop_name,
      skus: l.skus.map((s) => {
        const costSale = s.cost_sale !== undefined && s.cost_sale !== null ? s.cost_sale : s.cost_cny !== undefined && s.cost_cny !== null ? s.cost_cny / config.cnyRate : null;
        if (costSale === null) return { ...s, margin_pct: null };
        return { ...s, margin_pct: s.price > 0 ? Math.round(((s.price - costSale) / s.price) * 100) : null };
      })
    }));
}

function users() { return db.users.all().map(publicUser); }

module.exports = { overview, sellers, updateSeller, listOrders, listings, users };
