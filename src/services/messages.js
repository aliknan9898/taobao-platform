// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Messages on an order. A customer writes to Kinan support or to one of the shops in the order.
 * Shops only see their own conversation and only the customer's first name — never the address,
 * phone or email. Kinan staff see every conversation.
 */
const db = require('../db');
const { config } = require('../config');
const { httpError } = require('../auth');
const mailer = require('../mailer');
const push = require('../push');

const ref = (o) => o.id.slice(-8).toUpperCase();
const base = () => config.publicBaseUrl;
const fire = (p) => { Promise.resolve(p).catch(() => {}); };
const firstName = (u) => String(u?.name || u?.email || 'Customer').split(/[\s@]/)[0].slice(0, 30);

function view(m) { return { id: m.id, order_id: m.order_id, thread: m.thread, from: m.from, name: m.name, text: m.text, at: m.created_at }; }

function threadsFor(o, who) {
  const all = db.messages.all((m) => m.order_id === o.id).sort((a, b) => a.created_at - b.created_at);
  if (who.role === 'seller') return all.filter((m) => m.thread === who.seller_id).map(view);
  return all.map(view);
}

/** who = { role: 'buyer'|'seller'|'staff', user, seller_id? } */
function post(o, who, { thread, text }) {
  const body = String(text || '').trim().slice(0, 2000);
  if (!body) throw httpError(400, 'Write a message');
  const shops = [...new Set(o.lines.map((l) => l.seller_id))].filter((id) => !db.sellers.get(id)?.system);
  let t = who.role === 'seller' ? who.seller_id : String(thread || 'kinan');
  if (t !== 'kinan' && !shops.includes(t)) throw httpError(400, 'Choose Kinan support or a shop in this order');
  if (db.messages.all((m) => m.order_id === o.id && m.created_at > Date.now() - 3600e3 && m.user_id === who.user.id).length >= 30) throw httpError(429, 'Too many messages — please wait a little');
  const name = who.role === 'buyer' ? firstName(who.user) : who.role === 'seller' ? (db.sellers.get(who.seller_id)?.shop_name || 'Shop') : 'Kinan support';
  const m = db.messages.insert({ order_id: o.id, thread: t, from: who.role, user_id: who.user.id, name, text: body, read_by: [who.user.id] });

  // Tell the other side
  const url = (to) => (to === 'buyer' ? `${base()}/#/orders/${o.id}` : to === 'seller' ? `${base()}/seller#/orders` : `${base()}/admin`);
  const tell = (userId, to) => {
    const u = db.users.get(userId); if (!u) return;
    push.toUser(u.id, { title: `Message from ${name}`, body: body.slice(0, 120), url: url(to).replace(base(), ''), tag: `m-${o.id}-${t}` });
    fire(mailer.send({ to: u.email, key: `msg:${m.id}:${u.id}`, kind: 'message', subject: `New message about order ${ref(o)}`, title: `${name} wrote to you`, lines: [body.slice(0, 600)], button: { text: 'Reply', url: url(to) } }));
  };
  if (who.role === 'buyer') {
    if (t === 'kinan') push.telegram(`💬 Message from ${name} about order ${ref(o)}:\n${body.slice(0, 500)}\n${base()}/admin`);
    else tell(db.sellers.get(t)?.user_id, 'seller');
  } else tell(o.buyer_id, 'buyer');
  return view(m);
}

/** Staff: conversations where the customer wrote last (waiting for a reply). */
function waiting() {
  const last = new Map();
  for (const m of db.messages.all()) { const k = `${m.order_id}|${m.thread}`; const x = last.get(k); if (!x || m.created_at > x.created_at) last.set(k, m); }
  return [...last.values()].filter((m) => m.from === 'buyer' && m.thread === 'kinan').sort((a, b) => b.created_at - a.created_at).map(view);
}

module.exports = { post, threadsFor, waiting };
