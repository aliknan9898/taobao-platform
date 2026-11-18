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

/**
 * Stripe: verify signature, answer at once, act in the background (idempotent).
 * The event is marked processed only once its work succeeded: if it fails, Stripe's next delivery of the same event
 * runs it again (and checkUnpaidCards() catches anything still missed).
 */
const stripeRunning = new Set();
async function processStripeItem(item) {
  if (!item || item.processed || stripeRunning.has(item.id)) return;
  stripeRunning.add(item.id);
  try {
    const pi = item.msg?.payment_intent;
    if (!pi) throw new Error('Missing persisted payment intent; manual reconciliation required');
    if (String(pi?.metadata?.order_id || '').startsWith('gc_')) await require('./services/giftcards').paid(pi);
    else await orders.stripePaid(pi);
    db.inbox.update(item.id, { processed: true, processed_at: Date.now() });
    await db.flush();
  } catch (e) {
    console.error('[stripe→paid]', e.message);
    db.inbox.update(item.id, (x) => ({ ...x, attempts: (x.attempts || 0) + 1, last_error: String(e.message).slice(0, 300) }));
    try { await db.flush(); } catch (flushError) { console.error('[stripe] failed to persist retry', flushError.message); }
  } finally { stripeRunning.delete(item.id); }
}
async function stripeHook(rawBody, headers) {
  if (!stripe.verifyWebhook(rawBody, headers['stripe-signature'])) return { status: 400, body: 'invalid signature' };
  let evt;
  try { evt = JSON.parse(rawBody); } catch { return { status: 400, body: 'bad json' }; }
  if (!evt?.id || !evt?.type) return { status: 400, body: 'invalid event' };
  const key = `msg_st_${evt.id}`;
  const seen = db.inbox.get(key);
  if (seen?.processed || stripeRunning.has(key)) return { status: 200, body: 'dup' };
  if (!seen) db.inbox.insert({ id: key, source: 'stripe', msg: { type: evt.type, id: evt.id, ...(evt.type === 'payment_intent.succeeded' ? { payment_intent: evt.data?.object } : {}) }, processed: evt.type !== 'payment_intent.succeeded' });
  try { await db.flush(); } catch (e) {
    console.error('[stripe] inbox persistence failed', e.message);
    return { status: 503, body: 'retry later' };
  }
  if (evt.type === 'payment_intent.succeeded') {
    // Persist before acknowledgement; process and replay asynchronously.
    void processStripeItem(db.inbox.get(key));
  }
  return { status: 200, body: 'ok' };
}

/**
 * Safety net for card payments: unpaid orders whose PaymentIntent Stripe says succeeded are marked paid
 * (a webhook that failed or never arrived). Orders from the last 3 days, each checked at most once an hour.
 */
async function checkUnpaidCards(now = Date.now()) {
  if (stripe.demoMode()) return 0;
  let n = 0;
  const due = db.orders.all((o) => o.status === 'pending_payment' && o.payment?.provider === 'stripe' && /^pi_/.test(o.payment?.intent_id || '')
    && now - o.created_at > 10 * 60e3 && now - o.created_at < 3 * 86400e3 && now - (o.payment.checked_at || 0) > 3600e3).slice(-50);
  for (const o of due) {
    db.orders.update(o.id, (x) => ({ ...x, payment: { ...x.payment, checked_at: now } }));
    try {
      const pi = await stripe.retrieveIntent(o.payment.intent_id);
      if (pi && pi.status === 'succeeded') { await orders.stripePaid(pi); n++; }
    } catch (e) { console.warn('[stripe] check unpaid', o.id, e.message); }
  }
  if (n) console.log(`[stripe] ${n} paid order(s) found by the hourly check`);
  return n;
}

let running = false;
async function processInbox() {
  if (running) return;
  running = true;
  try {
    // Recover acknowledged Stripe events left unfinished by a crash/restart.
    for (const item of db.inbox.all((m) => m.source === 'stripe' && m.msg?.type === 'payment_intent.succeeded' && !m.processed)) {
      await processStripeItem(item);
    }
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

module.exports = { taobao, stripeHook, processInbox, checkUnpaidCards };
