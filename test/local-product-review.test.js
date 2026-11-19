'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('../src/services/localProductReview');

const historical = (id, title, at, decision = 'ok') => ({
  id, title: 'Title after review', status: 'active',
  ai_review: { provider: 'claude', at, decision, before: { title, category: 'home' } },
});

test('local review uses original titles and holds out unseen examples', () => {
  const history = ['white', 'black', 'small', 'large', 'blue', 'orange', 'brown', 'cream', 'red', 'purple']
    .map((color, i) => historical(String(i), `foldable phone stand ${color}`, i + 1));
  const reviews = [
    ...history,
    historical('duplicate', 'white phone foldable stand', 0, 'stopped'),
    { ...historical('photo-only', 'foldable phone stand other', 12), ai_review: { mode: 'photos', provider: 'claude' } },
    { id: 'ready', title: 'foldable phone stand green', status: 'pending_review', category: 'home', images: ['https://a.test/a', 'https://a.test/b'] },
    { id: 'missing', title: 'foldable phone stand green', status: 'pending_review', category: 'home', images: ['https://a.test/a', 'https://a.test/a'] },
  ];
  const snapshot = JSON.stringify(reviews);
  const result = compare(reviews);
  assert.equal(result.examples, 10);
  assert.deepEqual(result.holdout, { size: 2, decided: 2, agreed: 2 });
  assert.deepEqual(result.pending.map((p) => [p.id, p.decision, p.photo_links]), [['ready', 'ok', 2], ['missing', 'uncertain', 1]]);
  assert.equal(JSON.stringify(reviews), snapshot);
});

test('local reviewer abstains when similar paid reviews disagree', () => {
  const reviews = [
    historical('a', 'foldable phone stand black', 1),
    historical('b', 'foldable phone stand red', 2),
    historical('c', 'foldable phone stand blue', 3, 'stopped'),
    { id: 'target', title: 'foldable phone stand gray', status: 'pending_review', category: 'home', images: ['https://a.test/a', 'https://a.test/b'] },
  ];
  assert.equal(compare(reviews).pending[0].decision, 'uncertain');
});


test('supplier full reviews inform suggestions and photo-only reviews are tracked separately', () => {
  const listings = [
    { id: 'target', title: 'foldable phone stand gray', status: 'pending_review', category: 'home', images: ['https://a.test/a', 'https://a.test/b'] },
  ];
  const feedback = ['white', 'black', 'silver'].map((color, i) => ({
    source: i ? 'aliexpress' : 'cj', mode: 'full', category: 'home',
    title: `foldable phone stand ${color}`, decision: 'ok', at: i + 1,
  }));
  feedback.push({ source: 'cj', mode: 'photos', category: 'home', title: 'foldable phone stand blue', decision: 'stopped', at: 4 });
  const result = compare(listings, feedback);
  assert.equal(result.examples, 3);
  assert.equal(result.pending[0].decision, 'ok');
  assert.deepEqual(result.feedback, { cj_full: 1, cj_photos: 1, aliexpress_full: 2 });
});
