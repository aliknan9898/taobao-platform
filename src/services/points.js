// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Kinan points: shoppers earn points on every order once it is delivered (so cancelled or refunded orders earn nothing)
 * and turn them into a one-time discount code for their next order.
 *   POINTS_PER_UNIT  points per 1 unit of the shop currency spent on products (default 10)
 *   POINT_VALUE      what one point is worth in the shop currency (default 0.003 → 1,000 points = 3.00, i.e. 3% back)
 *   POINTS_MIN       fewest points that can be turned into a code (default 500)
 * Kept on the customer: points (balance) and points_log (latest 60 entries).
 */
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../auth');
const { config } = require('../config');

const PER_UNIT = () => Math.max(0, Number(process.env.POINTS_PER_UNIT ?? 10));
const VALUE = () => Math.max(0, Number(process.env.POINT_VALUE ?? 0.003));
const MIN = () => Math.max(1, Math.floor(Number(process.env.POINTS_MIN ?? 500)));
const money = (v) => Math.round(Number(v) * 100) / 100;
const now = () => Date.now();

/** Points an order earns: products only (not delivery), after any discount. */
function forOrder(o) {
  const spent = Math.max(0, Number(o.subtotal || 0) - Number(o.discount || 0));
  return Math.floor(spent * PER_UNIT());
}
const forPrice = (price) => Math.floor(Math.max(0, Number(price) || 0) * PER_UNIT());

function add(userId, pts, reason, extra = {}) {
  if (!pts) return null;
  return db.users.update(userId, (u) => ({
    ...u, points: Math.max(0, (Number(u.points) || 0) + pts),
    points_log: [{ at: now(), pts, reason: String(reason).slice(0, 160), ...extra }, ...(u.points_log || [])].slice(0, 60)
  }));
}

const earns = (o) => o.channel !== 'ebay' && !db.users.get(o.buyer_id)?.system && PER_UNIT() > 0;

/** Hourly: points for delivered orders; taken back if a delivered order is refunded later. */
function settle() {
  let given = 0; let taken = 0;
  for (const o of db.orders.all((x) => x.status === 'delivered' && !x.points_awarded)) {
    if (!earns(o)) { db.orders.update(o.id, { points_awarded: { pts: 0, at: now() } }); continue; }
    const pts = forOrder(o);
    db.orders.update(o.id, { points_awarded: { pts, at: now() } });
    if (pts) { add(o.buyer_id, pts, `Order ${o.id.slice(-8).toUpperCase()} delivered`, { order_id: o.id }); given++; }
  }
  for (const o of db.orders.all((x) => x.status === 'refunded' && x.points_awarded?.pts > 0 && !x.points_reversed)) {
    db.orders.update(o.id, { points_reversed: now() });
    add(o.buyer_id, -o.points_awarded.pts, `Order ${o.id.slice(-8).toUpperCase()} refunded`, { order_id: o.id }); taken++;
  }
  return { given, taken };
}

function info(userId) {
  const u = db.users.get(userId);
  if (!u) throw httpError(404, 'Not found');
  const balance = Number(u.points) || 0;
  const pending = db.orders.all((o) => o.buyer_id === userId && o.paid_at && !['delivered', 'cancelled', 'refunded'].includes(o.status) && earns(o)).reduce((a, o) => a + forOrder(o), 0);
  const codes = db.coupons.all((c) => c.owner_id === userId && c.points && c.active && !(c.used_by || []).length && (!c.expires_at || c.expires_at > now()))
    .map((c) => ({ code: c.code, value: c.value, expires_at: c.expires_at }));
  return {
    balance, value: money(balance * VALUE()), pending, currency: config.currency, per_unit: PER_UNIT(), point_value: VALUE(), min: MIN(),
    example: { spend: 100, points: forPrice(100), worth: money(forPrice(100) * VALUE()) }, codes, log: (u.points_log || []).slice(0, 40)
  };
}

/** Turn points into a one-time discount code for this customer (90 days). */
function redeem(userId, pts) {
  const u = db.users.get(userId);
  if (!u) throw httpError(404, 'Not found');
  const n = Math.floor(Number(pts) || 0);
  const have = Number(u.points) || 0;
  if (n < MIN()) throw httpError(400, `Use at least ${MIN()} points`);
  if (n > have) throw httpError(400, 'You do not have that many points');
  const value = money(n * VALUE());
  if (value < 0.5) throw httpError(400, 'That is too few points for a discount');
  let code;
  do { code = `PTS-${crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`; } while (db.coupons.find((c) => c.code === code));
  const c = db.coupons.insert({ code, kind: 'fixed', value, min_subtotal: 0, max_discount: null, max_uses: 1, first_order_only: false, expires_at: now() + 90 * 86400e3, active: true, owner_id: userId, points: n, note: `Kinan points (${n})`, uses: 0, used_by: [] });
  add(userId, -n, `Discount code ${code}`, { code });
  return { ...info(userId), code: c.code, value, expires_at: c.expires_at };
}

module.exports = { settle, info, redeem, forOrder, forPrice, VALUE, PER_UNIT };
