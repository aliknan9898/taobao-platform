// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const crypto = require('crypto');
const db = require('./db');
const { config } = require('./config');
const { verifyMessage } = require('./taobao/sign');
const stripe = require('./payments/stripe');
const orders = require('./services/orders');

/** Taobao Message Service: verify on RAW body, store, ack 200 fast (<500 ms), process later. */
function taobao(rawBody, headers) {
  if (!verifyMessage(rawBody, headers.authorization, config.appKey, config.appSecret)) return { status: 401, body: 'invalid signature' };
  let msg;
  try { msg = JSON.parse(rawBody); } catch { return { status: 400, body: 'bad json' }; }
  const key = `msg_tb_${crypto.createHash('sha1').update(rawBody).digest('hex')}`;
  if (!db.inbox.get(key)) db.inbox.insert({ id: key, source: 'taobao', msg, processed: false });
  return { status: 200, body: 'ok' };
}

/** Stripe: verify signature, then act synchronously (it's fast & idempotent). */
async function stripeHook(rawBody, headers) {
  if (!stripe.verifyWebhook(rawBody, headers['stripe-signature'])) return { status: 400, body: 'invalid signature' };
  const evt = JSON.parse(rawBody);
  const key = `msg_st_${evt.id}`;
  if (db.inbox.get(key)) return { status: 200, body: 'dup' };
  db.inbox.insert({ id: key, source: 'stripe', msg: { type: evt.type, id: evt.id }, processed: true });
  if (evt.type === 'payment_intent.succeeded') {
    const pi = evt.data.object;
    const orderId = pi.metadata && pi.metadata.order_id;
    if (orderId) orders.markPaid(orderId, { provider: 'stripe', intent_id: pi.id }).catch((e) => console.error('[stripe→paid]', e.message));
  }
  return { status: 200, body: 'ok' };
}

let running = false;
async function processInbox() {
  if (running) return;
  running = true;
  try {
    for (const item of db.inbox.all((m) => m.source === 'taobao' && !m.processed)) {
      const { msg } = item;
      const type = Number(msg.message_type);
      const d = msg.data || {};
      try {
        if (type === 3 || type === 8) {
          // Messages are unordered → never trust the payload status, re-query the API
          const outer = d.outer_purchase_id;
          const pid = String(d.purchase_id ?? d.purchaseOrderId ?? '');
          const hit = orders.findSub((s) => (outer && s.outer_purchase_id === outer) || (pid && (s.purchase_ids || []).includes(pid)));
          if (hit) await orders.syncSub(hit.order.id, hit.sub.outer_purchase_id);
        } else if (type === 9) {
          const pid = String(d.purchaseOrderId ?? '');
          const hit = orders.findSub((s) => (s.purchase_ids || []).includes(pid));
          if (hit) db.orders.update(hit.order.id, (x) => ({ ...x, refund_updates: [...(x.refund_updates || []), { refund_id: d.refundId, kind: d.messageType, at: d.businessTime }] }));
        }
        db.inbox.update(item.id, { processed: true, processed_at: Date.now() });
      } catch (e) {
        db.inbox.update(item.id, { attempts: (item.attempts || 0) + 1, last_error: e.message, processed: (item.attempts || 0) >= 4 });
      }
    }
  } finally { running = false; }
}

module.exports = { taobao, stripeHook, processInbox };
