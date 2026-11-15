// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* AliExpress short links from the app's Share button resolve to the product ID. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aelink-'));
global.fetch = async (url) => {
  const u = new URL(url);
  const H = (loc) => ({ status: 302, headers: { get: (k) => (k === 'location' ? loc : null) }, text: async () => '' });
  if (u.hostname === 'a.aliexpress.com' && u.pathname === '/_Eyrr08W') return H('https://s.click.aliexpress.com/e/_abc?bz=1');
  if (u.hostname === 's.click.aliexpress.com') return H('https://m.aliexpress.com/item/1005006123456789.html?spm=x&srcSns=sns_WhatsApp');
  if (u.hostname === 'a.aliexpress.com' && u.pathname === '/_Page') return { status: 200, headers: { get: () => null }, text: async () => '<script>location.href="https://www.aliexpress.com/item/1005009999999999.html"</script>' };
  return { status: 404, headers: { get: () => null }, text: async () => '' };
};
const ae = require('../src/services/aliexpress');

test('AliExpress links: full, short (redirects), short (script page), and not AliExpress', async () => {
  assert.strictEqual(await ae.resolveProductId('https://www.aliexpress.com/item/1005001111111111.html'), '1005001111111111');
  assert.strictEqual(await ae.resolveProductId('https://a.aliexpress.com/_Eyrr08W'), '1005006123456789');
  assert.strictEqual(await ae.resolveProductId('Look at this! https://a.aliexpress.com/_Eyrr08W'), '1005006123456789', 'shared text with the link inside');
  assert.strictEqual(await ae.resolveProductId('https://a.aliexpress.com/_Page'), '1005009999999999');
  assert.strictEqual(await ae.resolveProductId('https://evil.example/_x'), null);
  assert.strictEqual(await ae.resolveProductId('https://a.aliexpress.com/_Nothing'), null);
});
