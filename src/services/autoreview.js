// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/**
 * Automatic AI review of every product on Kinan — imported (CJ, AliExpress, Banggood, Taobao) or typed in by hand,
 * from Kinan's own shop or from sellers. A background job looks at each product once, and again whenever its title,
 * description or photos change. For each product the AI:
 *  - rewrites the title, description and search keywords (English and Arabic) from the facts given,
 *  - picks the category,
 *  - checks every photo: photos with another shop's watermark or logo, a fake brand logo, or showing a different
 *    product are taken off; photos with foreign text or blur go to the back; the best photo goes first,
 *  - stops products that must not be sold (counterfeit brands, weapons, medicines, adult items…): they go to
 *    "Needs changes" with the reason, and Kinan gets a Telegram message.
 * The listing's status is not otherwise changed: products waiting for approval still wait for the admin.
 * What was there before is kept in `ai_review.before`, so the admin can undo a review.
 * Settings: AI_AUTO_REVIEW=off to stop it, AI_REVIEW_DAILY (default 300 products a day), AI_REVIEW_GAP_MS (default 8000 between products).
 */
const crypto = require('crypto');
const db = require('../db');
const ai = require('./ai');
const { httpError } = require('../auth');

const s = (v, n) => String(v ?? '').trim().slice(0, n);
const on = () => ai.enabled() && String(process.env.AI_AUTO_REVIEW || '').toLowerCase() !== 'off';
const dailyCap = () => Math.max(1, Number(process.env.AI_REVIEW_DAILY) || 300);
const gapMs = () => Math.max(0, Number(process.env.AI_REVIEW_GAP_MS ?? 8000));
const STATUSES = ['pending_review', 'active', 'paused', 'private'];
const MAX_TRIES = 3;

/** What the review looked at: text and photos. A different fingerprint means the product changed since. */
const fpCache = new Map(); // id → { at: updated_at, fp }: products are only hashed again after they change
function fingerprint(l) {
  // cheap key: when the product was saved plus the sizes of what is hashed (two saves in one millisecond still differ)
  const key = `${l.updated_at}|${l.title}|${String(l.description || '').length}|${(l.images || []).join('|').length}|${(l.own_images || []).reduce((a, u) => a + String(u).length, 0)}`;
  const c = l.id && fpCache.get(l.id);
  if (c && c.key === key && l.updated_at) return c.fp;
  const fp = crypto.createHash('sha1').update(JSON.stringify([l.title || '', l.description || '', l.images || [], l.own_images || []])).digest('hex').slice(0, 16);
  if (l.id && l.updated_at) { if (fpCache.size > 50000) fpCache.clear(); fpCache.set(l.id, { key, fp }); }
  return fp;
}
// Christmas Shop products get their copy from the Christmas job first; review them after that
const waitingForXmasCopy = (l) => l.xmas && l.xmas.copy !== 'ai' && !l.xmas.copy_failed;
function needsReview(l) {
  if (!l || !STATUSES.includes(l.status) || waitingForXmasCopy(l)) return false;
  const r = l.ai_review;
  if (!r) return true;
  if (r.off) return false;
  const fp = fingerprint(l);
  if (r.fp === fp) return false;
  return !(r.failed_fp === fp && (r.tries || 0) >= MAX_TRIES);
}

const SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['ok', 'block'], description: '"block" only if the product must not be sold on Kinan (see rules). Otherwise "ok".' },
    block_reason: { type: 'string', description: 'When blocked: one short sentence for the seller, in English. Empty otherwise.' },
    title: { type: 'string', description: 'Clear English product title, 40–110 characters, Title Case.' },
    description: { type: 'string', description: 'English, plain text: 1–2 short sentences, then 3–6 "• " lines with the real facts. 300–1200 characters.' },
    title_ar: { type: 'string', description: 'Natural Arabic title.' },
    description_ar: { type: 'string', description: 'Natural Arabic description with the same facts and layout.' },
    keywords: { type: 'array', items: { type: 'string' }, description: '8–14 search keywords customers would type: English first, then a few Arabic. Lower case, 1–3 words each.' },
    category: { type: 'string', description: 'Best category id from the list given.' },
    photos: {
      type: 'array', description: 'One entry per photo, in the order received.',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '1-based photo number.' },
          verdict: { type: 'string', enum: ['good', 'fix', 'remove'] },
          issue: { type: 'string', description: 'Short problem found, in English. Empty when good.' }
        },
        required: ['index', 'verdict', 'issue']
      }
    },
    main_photo: { type: 'integer', description: 'Number of the best photo to show first: the whole product, clean, no text.' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Up to 3 short notes for Kinan about anything else wrong (e.g. options look like different products, price range suspicious, missing size chart).' }
  },
  required: ['decision', 'block_reason', 'title', 'description', 'title_ar', 'description_ar', 'keywords', 'category', 'photos', 'main_photo', 'notes']
};

function system(categories) {
  return [
    'You review product listings for Kinan, an online shop that delivers to customers in Europe, the UK and worldwide. Prices on Kinan already include shipping.',
    'Most products are imported from suppliers, so titles are often keyword lists and photos often carry other shops\' marks. Make each listing clear, honest and easy to find.',
    'Text rules:',
    '- Use ONLY facts in the supplier text, the options or clearly visible in the photos. Never invent materials, sizes, certifications, brands, warranties or numbers. Leave unknown facts out.',
    '- Do not mention China, Taobao, Tmall, 1688, AliExpress, CJ, Banggood, dropshipping, suppliers, factories, "wholesale", "cross-border", Amazon or other shops, or where the item ships from.',
    '- No brand or trademark names unless the product really is that brand and it is clearly genuine. No ALL CAPS, emoji, prices, delivery promises or words like "best", "hot", "2024 new".',
    '- Plain text only (no HTML, no markdown headings).',
    'Photo rules, for each photo: "remove" for another shop\'s watermark or logo, a counterfeit brand logo, explicit or offensive content, a photo of a different product, or an advert that is mostly text; "fix" for Chinese or other foreign-language text on the image, blur or very low resolution, a heavy collage, or borders/stickers; otherwise "good".',
    'Block the product ("block") only when it must not be sold: counterfeit or replica branded goods (fake logos of real brands), weapons or parts, knives sold as weapons, drugs, medicines or supplements with health claims, tobacco or vapes, adult or sexual items, animal products from protected species, hazardous chemicals, or anything illegal in the EU. When in doubt, do not block.',
    `Category ids you may use: ${categories.join(', ')}.`
  ].join('\n');
}

/** The photos as stored: seller-uploaded first, then the supplier's. */
function photosOf(l) {
  return [...(l.own_images || []).map((u, i) => ({ kind: 'own', i, u })), ...(l.images || []).map((u, i) => ({ kind: 'img', i, u }))];
}

/** Review one product now and save the result. Returns the updated product. */
async function reviewListing(id, { force = false } = {}) {
  if (!ai.enabled()) throw httpError(503, 'The AI is not switched on — add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY');
  const l = db.listings.get(id);
  if (!l) throw httpError(404, 'Product not found');
  if (!force && !needsReview(l)) return l;
  const fp = fingerprint(l);
  const photos = photosOf(l).slice(0, 8);
  const categories = require('./shipping').CATEGORIES.map(([cid]) => cid);
  const options = [...new Set((l.skus || []).map((k) => s(k.props, 80)).filter(Boolean))].slice(0, 25);
  const prices = (l.skus || []).map((k) => Number(k.price)).filter((x) => x > 0);
  const text = [
    `Supplier title: ${s(l.title, 300)}`,
    `Supplier description: ${s(String(l.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '), 2500) || '(none)'}`,
    options.length ? `Options (${(l.skus || []).length} in total): ${options.join(' | ')}` : '',
    prices.length ? `Price range: ${Math.min(...prices)}–${Math.max(...prices)} ${l.currency || 'USD'}` : '',
    `Current category: ${l.category || '(none)'}`,
    `Photos attached: ${photos.length}`
  ].filter(Boolean).join('\n');

  let out;
  try {
    out = await ai.structured({ system: system(categories), name: 'product_review', description: 'Return the reviewed listing and the photo check.', schema: SCHEMA, text, images: photos.map((p) => p.u), maxTokens: 3000, timeoutMs: 90000, kind: 'review' });
  } catch (e) {
    if (e.status !== 429) {
      const prev = l.ai_review || {}; const tries = prev.failed_fp === fp ? (prev.tries || 0) + 1 : 1;
      db.listings.update(l.id, (x) => ({ ...x, ai_review: { ...prev, failed_fp: fp, tries, error: s(e.message, 200), error_at: Date.now() } }));
      if (tries >= MAX_TRIES) release(l.id, 'the AI could not check it'); // don't keep a Kinan product hidden for ever
    }
    throw e;
  }
  return apply(l.id, out, { fp, photos, categories });
}

/** Save the AI's answer on the product (kept separate so it can be tested without the AI). */
function apply(id, out, { fp, photos, categories }) {
  const l = db.listings.get(id);
  if (!l) return null;
  if (fingerprint(l) !== fp) return l; // changed while the AI was thinking: the next round reviews the new version
  const before = { title: l.title, description: l.description || '', keywords: l.keywords || [], category: l.category || null, title_ar: l.title_ar || '', description_ar: l.description_ar || '', status: l.status, review: l.review || null };
  const patch = {}; const changed = [];
  const block = out.decision === 'block';

  // A product that must not be sold is only stopped: its text and photos stay as the seller made them
  let removed = []; let seen = []; let allBad = false;
  if (!block) {
    const title = s(out.title, 200);
    if (title.length >= 10 && title !== l.title) { patch.title = title; changed.push('title'); }
    const description = s(out.description, 5000).replace(/<[^>]*>/g, '');
    if (description.length >= 40 && description !== (l.description || '')) { patch.description = description; changed.push('description'); }
    const keywords = ai.cleanKeywords(out.keywords);
    if (keywords.length >= 3) { patch.keywords = keywords; changed.push('keywords'); }
    if (categories.includes(out.category) && out.category !== l.category) { patch.category = out.category; changed.push('category'); }
    if (!l.ar_manual && s(out.title_ar, 300).length >= 5) { patch.title_ar = s(out.title_ar, 300); patch.description_ar = s(out.description_ar, 6000).replace(/<[^>]*>/g, ''); changed.push('arabic'); }

    // Photos: drop "remove", put "fix" at the back, best photo first. Photos the AI did not see stay at the end.
    const verdict = new Map((Array.isArray(out.photos) ? out.photos : []).map((p) => [Number(p.index), p]));
    seen = photos.map((p, k) => ({ ...p, n: k + 1, v: ['good', 'fix', 'remove'].includes(verdict.get(k + 1)?.verdict) ? verdict.get(k + 1).verdict : 'good', issue: s(verdict.get(k + 1)?.issue, 160) }));
    const unseen = photosOf(l).slice(photos.length);
    let keep = seen.filter((p) => p.v !== 'remove');
    removed = seen.filter((p) => p.v === 'remove');
    if (!keep.length && !unseen.length) { allBad = true; keep = seen; } // never leave a product without photos
    const main = Number(out.main_photo);
    const rank = (p) => (p.n === main ? 0 : p.v === 'good' ? 1 : 2);
    keep = [...keep].sort((a, b) => rank(a) - rank(b) || a.n - b.n);
    const ordered = [...keep, ...unseen];
    const newOwn = ordered.filter((p) => p.kind === 'own').map((p) => p.u);
    const newImgs = ordered.filter((p) => p.kind === 'img').map((p) => p.u);
    if (JSON.stringify(newOwn) !== JSON.stringify(l.own_images || []) || JSON.stringify(newImgs) !== JSON.stringify(l.images || [])) {
      // Keep the old photo lists only when they changed (seller photos can be large)
      if (JSON.stringify(newOwn) !== JSON.stringify(l.own_images || [])) before.own_images = l.own_images || [];
      if (JSON.stringify(newImgs) !== JSON.stringify(l.images || [])) before.images = l.images || [];
      patch.own_images = newOwn; patch.images = newImgs; changed.push(removed.length && !allBad ? 'photos_removed' : 'photos_ordered');
    }

  }
  const reason = block ? `AI check: ${s(out.block_reason, 300) || 'this product cannot be sold on Kinan'}` : allBad ? 'AI check: every photo has a problem (another shop’s watermark or logo, or a different product) — add clean photos' : null;
  // Kinan's own new products waiting only for this review go live when it passes
  if (!reason && isHeld(l)) { patch.status = 'active'; patch.review = { ...l.review, state: 'approved', decided_at: Date.now(), decided_by: 'ai', note: 'Checked by Kinan AI' }; changed.push('approved'); }
  if (reason) { patch.status = 'rejected'; patch.review = { ...(l.review || {}), state: 'rejected', reason, decided_at: Date.now(), decided_by: 'ai' }; changed.push('stopped'); }

  const updated = db.listings.update(l.id, (x) => ({ ...x, ...patch }));
  if (patch.title_ar) db.listings.update(l.id, { ar_src: require('./translate').fingerprint(updated), ar_auto: true });
  const fin = db.listings.update(l.id, (x) => ({ ...x, ai_review: {
    at: Date.now(), fp: fingerprint(x), provider: ai.provider(), model: ai.model(), decision: reason ? 'stopped' : 'ok', reason: reason || null, changed,
    photo_issues: seen.filter((p) => p.v !== 'good').map((p) => ({ photo: p.n, verdict: p.v, issue: p.issue })), removed_photos: allBad ? 0 : removed.length,
    notes: (Array.isArray(out.notes) ? out.notes : []).map((n) => s(n, 240)).filter(Boolean).slice(0, 3), before
  } }));
  if (reason) {
    try { require('../push').telegram(`🤖 AI stopped a product: ${s(before.title, 80)}\n${reason}`); } catch { /* no Telegram */ }
  }
  return fin;
}

/**
 * New products in Kinan's own shop: with the automatic review on, they wait (hidden) until the AI has checked them,
 * then go live by themselves. Without the AI they go live at once, as before.
 */
function holdOwn() {
  return on() ? { status: 'pending_review', review: { state: 'pending', submitted_at: Date.now(), auto: 'ai' } } : null;
}

const isHeld = (l) => l && l.status === 'pending_review' && l.review?.auto === 'ai';
/** A Kinan product held for the AI goes live without the check (AI switched off, or it kept failing). */
function release(id, why) {
  const l = db.listings.get(id);
  if (!isHeld(l)) return false;
  db.listings.update(l.id, { status: 'active', review: { ...l.review, state: 'approved', decided_at: Date.now(), note: `Live without AI check: ${why}` } });
  return true;
}
function releaseAll(why) { let n = 0; for (const l of db.listings.all(isHeld)) if (release(l.id, why)) n++; if (n) console.log(`[ai-review] ${n} held product(s) put live: ${why}`); return n; }

/** Put a product back the way it was before the AI review, and don't review it again until it changes. */
function revert(id) {
  const l = db.listings.get(id);
  if (!l || !l.ai_review?.before) throw httpError(404, 'Nothing to undo for this product');
  const b = l.ai_review.before;
  const back = db.listings.update(l.id, (x) => ({ ...x, title: b.title, description: b.description, keywords: b.keywords, category: b.category, images: b.images || x.images, own_images: b.own_images || x.own_images, title_ar: b.title_ar, description_ar: b.description_ar,
    ...(x.ai_review.decision === 'stopped' && x.status === 'rejected' ? { status: b.status, review: b.review } : {}) }));
  return db.listings.update(l.id, (x) => ({ ...x, ar_src: require('./translate').fingerprint(back), ai_review: { ...x.ai_review, before: null, reverted_at: Date.now(), fp: fingerprint(x) } }));
}

// ---------------- Background job ----------------
const today = () => new Date().toISOString().slice(0, 10);
function usage() { const u = db.settings.get('ai_review_usage'); return u && u.day === today() ? u.n : 0; }
function count() {
  const u = db.settings.get('ai_review_usage'); const n = u && u.day === today() ? u.n + 1 : 1;
  if (u) db.settings.update('ai_review_usage', { day: today(), n }); else db.settings.insert({ id: 'ai_review_usage', day: today(), n });
}
function queue() {
  const rank = (l) => (l.status === 'pending_review' ? 0 : l.status === 'active' ? 1 : 2);
  return db.listings.all(needsReview).sort((a, b) => rank(a) - rank(b) || (b.created_at || 0) - (a.created_at || 0));
}

let running = false; let pauseUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Review the next few products. Called every minute; stops for a while when the AI quota runs out. */
async function tick({ max = 6 } = {}) {
  if (!on()) { releaseAll('the automatic AI review is off'); return 0; }
  // nothing stays hidden for more than a day waiting for the AI (quota used up, daily limit reached…)
  for (const l of db.listings.all((x) => isHeld(x) && Date.now() - (x.review.submitted_at || 0) > 24 * 3600e3)) release(l.id, 'not checked within 24 hours');
  if (running || Date.now() < pauseUntil) return 0;
  running = true; let n = 0;
  try {
    for (const l of queue().slice(0, max)) {
      if (usage() >= dailyCap()) break;
      try { count(); await reviewListing(l.id); n++; } catch (e) {
        if (e.status === 429) { pauseUntil = Date.now() + 10 * 60e3; console.warn('[ai-review] AI quota reached — pausing 10 minutes'); break; }
        console.warn('[ai-review]', l.id, e.message);
      }
      if (gapMs()) await sleep(gapMs());
    }
  } finally { running = false; }
  if (n) console.log(`[ai-review] ${n} product(s) reviewed`);
  return n;
}

/** For the admin dashboard. */
function status() {
  const all = db.listings.all((l) => STATUSES.includes(l.status) || l.ai_review);
  const reviewed = all.filter((l) => l.ai_review?.at);
  return {
    enabled: ai.enabled(), running: on(), provider: ai.provider(), model: ai.enabled() ? ai.model() : null,
    waiting: queue().length, reviewed: reviewed.length, stopped: reviewed.filter((l) => l.ai_review.decision === 'stopped' && l.status === 'rejected').length,
    today: usage(), daily_cap: dailyCap(), paused_until: pauseUntil > Date.now() ? pauseUntil : null,
    recent: reviewed.sort((a, b) => b.ai_review.at - a.ai_review.at).slice(0, 30).map((l) => ({
      id: l.id, title: l.title, before_title: l.ai_review.before?.title || null, status: l.status, decision: l.ai_review.decision, reason: l.ai_review.reason,
      changed: l.ai_review.changed || [], removed_photos: l.ai_review.removed_photos || 0, notes: l.ai_review.notes || [], at: l.ai_review.at, can_undo: Boolean(l.ai_review.before)
    }))
  };
}

module.exports = { on, release, releaseAll, fingerprint, needsReview, reviewListing, apply, revert, holdOwn, tick, status, queue };
