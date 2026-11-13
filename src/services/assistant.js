// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Kinan's AI helpers for shoppers:
 *  - Shopping assistant: "a gift for my mum under €30" → the AI turns it into searches and a budget, Kinan finds the
 *    products, the AI picks the best few and says why, in the shopper's language.
 *  - Product questions: shoppers ask on the product page; the AI answers at once from the product's own details
 *    (or says it cannot, and Kinan answers later from the admin). Answers are public, like Amazon's Q&A.
 */
const db = require('../db');
const { httpError } = require('../auth');
const { config } = require('../config');

const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const words = (s) => require('./visual').words(s);

// ---------------- shopping assistant ----------------

const PLAN = {
  type: 'object',
  properties: {
    searches: { type: 'array', items: { type: 'string' }, description: '2–6 short English product searches (2–4 words each) that would find what the shopper wants. Empty if they are not looking for a product.' },
    max_price: { type: 'number', description: 'Budget per item in the shopper\'s currency, 0 if none.' },
    min_price: { type: 'number', description: 'Lowest price per item, 0 if none.' },
    reply_if_no_products: { type: 'string', description: 'A short helpful answer in the shopper\'s language, used when this is not a product request (greeting, delivery/returns question…).' }
  },
  required: ['searches', 'max_price', 'min_price', 'reply_if_no_products']
};
const PICK = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'A warm, short answer (2–4 sentences) in the shopper\'s language that introduces the picks. No prices unless helpful. No links.' },
    picks: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, why: { type: 'string', description: 'One short reason in the shopper\'s language.' } }, required: ['i', 'why'] }, description: 'Up to 6 products from the list, best first.' }
  },
  required: ['reply', 'picks']
};

function find(searches, { min = 0, max = 0, rate = 1 } = {}) {
  const items = require('./catalog').browse({ limit: 100000 }).items;
  const qs = searches.map((s) => words(s)).filter((w) => w.length);
  const scored = [];
  for (const p of items) {
    const local = p.min_price * rate;
    if (max > 0 && local > max * 1.05) continue;
    if (min > 0 && local < min) continue;
    const l = db.listings.get(p.id); if (!l) continue;
    const t = new Set(words(`${l.title} ${(l.keywords || []).join(' ')} ${l.sourcing?.dept || ''} ${l.collection_group || ''}`));
    let best = 0;
    for (const q of qs) { const hit = q.filter((w) => t.has(w) || [...t].some((x) => x.length > 3 && (x.startsWith(w) || w.startsWith(x)))).length; best = Math.max(best, hit / q.length + (hit === q.length ? 0.5 : 0)); }
    if (best >= 0.5) scored.push({ p, s: best + (p.rating ? p.rating / 20 : 0) + (p.deal ? 0.1 : 0) });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, 24).map((x) => x.p);
}

/** messages: [{ role: 'user'|'assistant', text }]; currency: the shopper's display currency (EUR, GBP, USD…). */
async function chat({ messages, currency = 'EUR', lang = 'en' } = {}) {
  const ai = require('./ai');
  if (!ai.enabled()) throw httpError(503, 'The shopping assistant is not available right now');
  const msgs = (Array.isArray(messages) ? messages : []).slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: str(m.text, 600) })).filter((m) => m.text);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw httpError(400, 'Write a message');
  const cur = /^[A-Z]{3}$/.test(String(currency)) ? currency : 'EUR';
  let rate = 1; try { rate = cur === config.currency.toUpperCase() ? 1 : require('./fx').publicRates()?.rates?.[cur] || 1; } catch { rate = 1; }
  const convo = msgs.map((m) => `${m.role === 'user' ? 'Shopper' : 'Kinan'}: ${m.text}`).join('\n');
  const sys = `You are Kinan's shopping assistant. Kinan is an online marketplace (home, kitchen, décor, garden, pets, beauty, sports, electronics, phone and car accessories, baby, toys, fashion, tools, office, Christmas) that delivers across the UK and Europe, many items from European warehouses. Always answer in the language the shopper writes in (their app language is "${lang}"). Be brief and friendly. Never invent products, prices, discounts or delivery promises.`;
  const plan = await ai.structured({ system: sys, name: 'shopping_plan', schema: PLAN, kind: 'assistant', maxTokens: 500, timeoutMs: 30000, text: `Prices are in ${cur}.\n${convo}` });
  const searches = (plan.searches || []).map((s) => str(s, 60)).filter(Boolean).slice(0, 6);
  if (!searches.length) return { reply: str(plan.reply_if_no_products, 900) || 'How can I help you find something today?', items: [] };
  const found = find(searches, { min: Number(plan.min_price) || 0, max: Number(plan.max_price) || 0, rate });
  if (!found.length) {
    return { reply: str(plan.reply_if_no_products, 900) || 'I could not find a good match yet — try other words, or browse the departments.', items: [], searches };
  }
  const list = found.map((p, i) => `${i}. ${p.title.slice(0, 100)} — ${(p.min_price * rate).toFixed(2)} ${cur}${p.rating ? ` · ${p.rating}★` : ''}${p.ships_from ? ` · ships from ${p.ships_from}` : ''}`).join('\n');
  let pick;
  try { pick = await ai.structured({ system: sys, name: 'shopping_picks', schema: PICK, kind: 'assistant', maxTokens: 700, timeoutMs: 30000, text: `${convo}\n\nProducts Kinan has (choose only from these):\n${list}` }); }
  catch { pick = { reply: '', picks: found.slice(0, 6).map((_, i) => ({ i, why: '' })) }; }
  const seen = new Set();
  const items = (pick.picks || []).filter((x) => found[x.i] && !seen.has(x.i) && seen.add(x.i)).slice(0, 6).map((x) => ({ ...found[x.i], why: str(x.why, 200) }));
  return { reply: str(pick.reply, 900) || 'Here are some ideas:', items: items.length ? items : found.slice(0, 6), searches };
}

// ---------------- product questions ----------------

const ANSWER = {
  type: 'object',
  properties: {
    allowed: { type: 'boolean', description: 'false if the question is spam, rude, personal data, or not about the product/delivery.' },
    can_answer: { type: 'boolean', description: 'true only if the product details below really answer it.' },
    answer: { type: 'string', description: 'Short, factual answer in the language of the question, from the details only. Empty if you cannot answer.' }
  },
  required: ['allowed', 'can_answer', 'answer']
};

function publicQ(q) { return { id: q.id, question: q.question, answer: q.answer || null, by: q.answer ? (q.answered_by === 'ai' ? 'ai' : 'kinan') : null, name: q.name, at: q.created_at, answered_at: q.answered_at || null }; }
function questionsFor(listingId) {
  return { questions: db.questions.all((q) => q.listing_id === listingId && q.status !== 'hidden').sort((a, b) => (b.answer ? 1 : 0) - (a.answer ? 1 : 0) || b.created_at - a.created_at).slice(0, 30).map(publicQ) };
}

async function ask(user, listingId, text) {
  const l = db.listings.get(listingId);
  if (!l || l.status !== 'active') throw httpError(404, 'Product not found');
  const question = str(text, 400);
  if (question.length < 6) throw httpError(400, 'Write your question');
  const today = db.questions.all((q) => q.user_id === user.id && Date.now() - q.created_at < 86400e3).length;
  if (today >= 10) throw httpError(429, 'You asked a lot today — try again tomorrow');
  let d = null;
  const ai = require('./ai');
  if (ai.enabled()) {
    const opts = [...new Set((l.skus || []).map((s) => s.props).filter(Boolean))].slice(0, 20);
    const from = l.cj_from && l.cj_from !== 'CN' ? `ships from a warehouse in ${l.cj_from}` : l.fulfillment === 'direct' ? 'ships from the supplier' : 'ships from Kinan\'s warehouse';
    try {
      d = await ai.structured({
        system: 'You answer shoppers\' questions on a product page of Kinan, an online marketplace. Use ONLY the product details given. If they do not contain the answer, set can_answer to false. Never guess sizes, materials, compatibility or dates. Returns: 14 days for most items; delivery time and price are shown at checkout for the shopper\'s address.',
        name: 'product_answer', schema: ANSWER, kind: 'qa', maxTokens: 400, timeoutMs: 30000,
        text: `Product: ${l.title}\nOptions: ${opts.join(', ') || 'one'}\nDelivery: ${from}\nDetails:\n${String(l.description || '').slice(0, 3000)}\n\nQuestion: ${question}`
      });
    } catch { d = null; }
  }
  if (d && d.allowed === false) throw httpError(400, 'Please ask about the product or its delivery');
  const answered = d && d.can_answer && str(d.answer, 1200);
  const q = db.questions.insert({
    listing_id: l.id, seller_id: l.seller_id, user_id: user.id, name: str((user.name || user.email || 'Customer').split(/[\s@]/)[0], 30), question,
    status: 'published', ...(answered ? { answer: answered, answered_by: 'ai', answered_at: Date.now() } : {})
  });
  if (!answered) {
    try { require('../mailer').send({ to: config.operator.email || process.env.ADMIN_EMAIL, key: `qa:${q.id}`, kind: 'ops', subject: `Question on ${l.title.slice(0, 50)}`, title: 'A shopper asked a question', lines: [question, `Product: ${l.title}`], button: { text: 'Answer in the admin', url: `${config.publicBaseUrl}/admin` } }); } catch { /* optional */ }
  }
  return publicQ(q);
}

function pending() {
  return db.questions.all((q) => !q.answer && q.status !== 'hidden').sort((a, b) => a.created_at - b.created_at).slice(0, 100)
    .map((q) => ({ ...publicQ(q), listing_id: q.listing_id, title: db.listings.get(q.listing_id)?.title || '' }));
}
function answer(id, text, by = 'kinan') {
  const q = db.questions.get(id); if (!q) throw httpError(404, 'Not found');
  const a = str(text, 1200);
  if (!a) return db.questions.update(id, { status: 'hidden' }) && { hidden: true };
  const out = db.questions.update(id, { answer: a, answered_by: by, answered_at: Date.now(), status: 'published' });
  try { require('../push').toUser(q.user_id, { title: 'Your question was answered', body: a.slice(0, 120), url: `/#/p/${q.listing_id}`, tag: `qa-${q.id}`, ar: { title: 'تمت الإجابة على سؤالك', body: a.slice(0, 120) } }); } catch { /* optional */ }
  return publicQ(out);
}

module.exports = { chat, find, ask, questionsFor, pending, answer };
