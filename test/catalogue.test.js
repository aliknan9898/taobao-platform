'use strict';
/* Printable catalogue: served at /catalogue, and the QR encoder it uses builds valid symbols. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
const QR = require('../public/assets/qr.js');
const { server } = require('../src/server');
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

test('catalogue page is served under both spellings', async () => {
  for (const p of ['/catalogue', '/catalog']) {
    const r = await fetch(base + p); const html = await r.text();
    assert.strictEqual(r.status, 200);
    assert.match(html, /\/assets\/qr\.js/);
    assert.match(r.headers.get('content-security-policy'), /img-src 'self' https:/);
  }
});

test('QR symbols: right size per version, finder patterns in place, longer text → bigger symbol', () => {
  const a = QR.matrix('https://kinan.shop', 'H'); // version 3
  assert.strictEqual(a.length, 29);
  const finder = (m, x, y) => m[y][x] && m[y][x + 6] && m[y + 6][x] && !m[y + 1][x + 1] && m[y + 3][x + 3];
  assert.ok(finder(a, 0, 0) && finder(a, a.length - 7, 0) && finder(a, 0, a.length - 7));
  assert.strictEqual(a[a.length - 8][8], true, 'dark module');
  const b = QR.matrix(`https://kinan.shop/p/lst_${'a'.repeat(300)}`, 'M');
  assert.ok(b.length > 57, 'version 11 or above');
  assert.match(QR.svg('https://kinan.shop', { logo: '/assets/logo-main.png' }), /^<svg[\s\S]+<image href="\/assets\/logo-main\.png"/);
  assert.throws(() => QR.matrix('x'.repeat(3000), 'H'), /too long/);
});
