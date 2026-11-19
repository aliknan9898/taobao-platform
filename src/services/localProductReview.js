// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';

const db = require('../db');

function words(title) {
  return new Set(String(title || '').slice(0, 300).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
}

function example(listing) {
  const review = listing.ai_review;
  // Only complete reviews with their original title are comparable. Exclude
  // photo-only decisions, reviews that were undone, and automatic releases.
  if (!review?.before?.title || !review.provider || review.mode === 'photos' || review.reverted_at) return null;
  if (!['ok', 'stopped'].includes(review.decision)) return null;
  const original = review.before;
  const tokens = words(original.title);
  if (tokens.size < 2) return null;
  return {
    id: listing.id,
    tokens,
    key: [...tokens].sort().join(' '),
    category: original.category,
    decision: review.decision,
    at: Number(review.at) || 0,
  };
}

// Each supplier product contributes one current verdict per review mode.
function record(source, mode, supplierId, product, decision) {
  if (!supplierId) return;
  try {
    const store = db.product_review_feedback;
    const id = `${source}:${mode}:${supplierId}`;
    const row = {
      id, source, mode, listing_id: product.id,
      title: String(product.title || '').slice(0, 300), category: product.category,
      decision, at: Date.now(),
    };
    if (!store.update(id, row)) store.insert(row);
    const rows = store.all();
    if (rows.length > 1500) {
      rows.sort((a, b) => a.at - b.at).slice(0, rows.length - 1500).forEach((old) => store.remove(old.id));
    }
  } catch (error) {
    console.warn('[local product review] feedback write failed', error.code || error.name);
  }
}

function recordFull(source, supplierId, product, review, reason) {
  // Transport errors and incomplete responses are not supplier verdicts.
  if (review?.error || typeof review?.keep !== 'boolean' || typeof review.photos_ok !== 'boolean'
    || !Number.isInteger(review.quality) || review.quality < 1 || review.quality > 10
    || !Array.isArray(review.clean_photos)) return;
  record(source, 'full', supplierId, product, reason ? 'stopped' : 'ok');
}

function feedbackExample(row) {
  if (row.mode !== 'full' || !['ok', 'stopped'].includes(row.decision)) return null;
  const tokens = words(row.title);
  if (tokens.size < 2) return null;
  return { id: row.listing_id, tokens, key: [...tokens].sort().join(' '), category: row.category, decision: row.decision, at: row.at };
}

function predict(tokens, category, examples) {
  const similar = [];
  for (const row of examples) {
    if (row.category !== category) continue;
    let shared = 0;
    for (const token of tokens) if (row.tokens.has(token)) shared++;
    const score = shared / (tokens.size + row.tokens.size - shared);
    if (shared >= 2 && score >= 0.5) similar.push({ score, decision: row.decision });
  }
  const closest = similar.sort((a, b) => b.score - a.score).slice(0, 5);
  if (closest.length < 3 || closest.some((row) => row.decision !== closest[0].decision)) {
    return { decision: 'uncertain', examples: closest.length };
  }
  return { decision: closest[0].decision, examples: closest.length };
}

function compare(listings, feedback = []) {
  const labels = [...listings.map(example), ...feedback.map(feedbackExample)].filter(Boolean).sort((a, b) => b.at - a.at);
  const seen = new Set();
  const unique = labels.filter((row) => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  }).slice(0, 1000);

  const holdout = unique.length >= 10 ? unique.slice(0, Math.min(50, Math.floor(unique.length / 5))) : [];
  const older = unique.slice(holdout.length);
  const results = holdout.map((row) => ({ actual: row.decision, predicted: predict(row.tokens, row.category, older).decision }));
  const decided = results.filter((row) => row.predicted !== 'uncertain');

  const pending = listings.filter((listing) => listing.status === 'pending_review')
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 30).map((listing) => {
      const images = new Set((Array.isArray(listing.images) ? listing.images : []).filter((image) => typeof image === 'string' && /^https?:\/\//i.test(image)));
      const tokens = words(listing.title);
      const key = [...tokens].sort().join(' ');
      const hint = tokens.size < 2 || images.size < 2 ? { decision: 'uncertain', examples: 0 }
        : predict(tokens, listing.category, unique.filter((row) => row.id !== listing.id && row.key !== key));
      return { id: listing.id, title: String(listing.title || '').slice(0, 200), photo_links: images.size, ...hint };
    });

  return {
    examples: unique.length,
    feedback: {
      cj_full: feedback.filter((row) => row.source === 'cj' && row.mode === 'full').length,
      cj_photos: feedback.filter((row) => row.source === 'cj' && row.mode === 'photos').length,
      aliexpress_full: feedback.filter((row) => row.source === 'aliexpress' && row.mode === 'full').length,
    },
    holdout: { size: holdout.length, decided: decided.length, agreed: decided.filter((row) => row.predicted === row.actual).length },
    pending,
  };
}

const dashboard = () => compare(db.listings.all(), db.product_review_feedback.all());

module.exports = { compare, dashboard, record, recordFull };
