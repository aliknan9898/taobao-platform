// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinan-web-'));
process.env.PUBLIC_BASE_URL = 'https://kinan.example';
process.env.TAOBAO_APP_KEY = '';

const { server, safeReturnTo } = require('../src/server');
let base;
test.before(async () => { await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

test('every interface is served with its brand and manifest', async () => {
  for (const [p, needle, manifest] of [['/', 'Kinan', 'shop'], ['/seller', 'Kinan Seller Center', 'seller'], ['/admin', 'Kinan Admin', 'admin'], ['/warehouse', 'Kinan Warehouse', 'warehouse']]) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200, p);
    const html = await r.text();
    assert.ok(html.includes(needle), `${p} has brand`);
    assert.ok(html.includes(`/assets/${manifest}.webmanifest`), `${p} has manifest`);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  }
  const shopCsp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(shopCsp, /js\.stripe\.com/);
  const sellerCsp = (await fetch(base + '/seller')).headers.get('content-security-policy');
  assert.doesNotMatch(sellerCsp, /stripe/);
});

test('download page lists the customer and seller apps', async () => {
  const r = await fetch(base + '/download');
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('Kinan Shop') && html.includes('Kinan Seller') && html.includes('Add to Home Screen'));
  assert.ok(!html.includes('href="/admin"'), 'staff apps are not advertised');
  assert.match(html, /\/assets\/kinan\.css\?v=\w+/);
});

test('static assets, service worker and traversal protection', async () => {
  const css = await fetch(base + '/assets/kinan.css');
  assert.strictEqual(css.status, 200); assert.match(css.headers.get('content-type'), /text\/css/);
  const man = await (await fetch(base + '/assets/shop.webmanifest')).json();
  assert.strictEqual(man.name, 'Kinan Shop'); assert.strictEqual(man.display, 'standalone');
  for (const ic of man.icons) assert.strictEqual((await fetch(base + ic.src)).status, 200, ic.src);
  const sw = await fetch(base + '/sw.js');
  assert.strictEqual(sw.status, 200); assert.strictEqual(sw.headers.get('service-worker-allowed'), '/');
  assert.strictEqual((await fetch(base + '/assets/..%2Fsrc%2Fconfig.js')).status, 404);
  assert.strictEqual((await fetch(base + '/assets/nope.txt')).status, 404);
});

test('public config exposes what the web apps need, no secrets', async () => {
  const c = await (await fetch(base + '/api/config/public')).json();
  assert.strictEqual(c.brand, 'Kinan'); assert.ok(c.cny_rate > 0); assert.ok('stripe_publishable_key' in c);
  assert.ok(!JSON.stringify(c).includes('sk_'));
});

test('Taobao return_to only allows this site or an app scheme', () => {
  assert.strictEqual(safeReturnTo('https://kinan.example/seller?taobao=connected'), 'https://kinan.example/seller?taobao=connected');
  assert.strictEqual(safeReturnTo('myseller://taobao-connected'), 'myseller://taobao-connected');
  assert.strictEqual(safeReturnTo('https://evil.example/phish'), null);
  assert.strictEqual(safeReturnTo('javascript:alert(1)'), null);
  assert.strictEqual(safeReturnTo('data:text/html,hi'), null);
  assert.strictEqual(safeReturnTo(''), null);
});

test('Taobao request signature matches the official Python sample', () => {
  const { signRequest } = require('../src/taobao/sign');
  const params = { app_key: '000000', access_token: 'test', timestamp: '1517820392000', sign_method: 'sha256', item_id: '676648141230' };
  // Output of the Python sign() function published on open.taobao.global for these inputs
  assert.strictEqual(signRequest('/product/get', params, 'helloworld'), 'E9F5F928AB9F703DA9EE071DEA7A5B184FCF9AFAF94AD9C12C3671173EDFE45F');
  assert.strictEqual(signRequest('/product/get', { ...params, sign: 'ignored' }, 'helloworld'), 'E9F5F928AB9F703DA9EE071DEA7A5B184FCF9AFAF94AD9C12C3671173EDFE45F');
});

test('reads /product/get in the format of the official sample response', () => {
  const { normalizeProduct } = require('../src/services/catalog');
  const sample = { data: { quantity: 600, mp_id: '6001304379094412300', item_id: 676648141230, item_type: 'WITHOUT_MATERIAL', begin_amount: 0, shop_name: 'Singor4', title: 'printed drawstring shorts', promotion_price: 18800, price: 18800,
    sku_list: [{ mp_skuId: 4871614981760, quantity: 200, price: 18800, postFee: 800, sku_id: 4859054248495, pic_url: 'https://img.alicdn.com/x.jpg', properties: [{ prop_name: 'color', prop_id: 1627207, value_id: 28338, value_name: 'blue' }, { prop_name: 'size', prop_id: 20518, value_id: 27432, value_name: '1' }], promotion_price: 18800, status: 'active' }] }, success: true, code: '0' };
  const p = normalizeProduct(sample, '676648141230');
  assert.strictEqual(p.mp_id, '6001304379094412300');
  assert.strictEqual(p.skus[0].mp_sku_id, '4871614981760', 'uses mp_skuId, not the Taobao sku_id');
  assert.strictEqual(p.skus[0].cost_cny, 188, 'fen → yuan');
  assert.strictEqual(p.skus[0].props, 'color: blue / size: 1');
  assert.deepStrictEqual(p.images, [], 'WITHOUT_MATERIAL: no Taobao photos');
});

test('legal pages are served with the owner and no third-party requests', async () => {
  for (const p of ['/terms', '/seller-terms', '/privacy', '/legal']) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200, p);
    const html = await r.text();
    assert.ok(html.includes('Ali Almadhoun Mohammed Kinan'), `${p} names the owner`);
    assert.ok(!/\{\{\w+\}\}/.test(html), `${p} has no unfilled placeholders`);
    assert.match(r.headers.get('content-security-policy'), /script-src 'none'/);
  }
  for (const p of ['/', '/seller', '/admin', '/warehouse']) {
    const html = await (await fetch(base + p)).text();
    assert.ok(!html.includes('fonts.googleapis') && !html.includes('fonts.gstatic'), `${p} loads no Google Fonts`);
    assert.ok(html.includes('/assets/fonts.css'));
  }
  assert.strictEqual((await fetch(base + '/assets/bricolage-700.woff')).headers.get('content-type'), 'font/woff');
  assert.strictEqual((await fetch(base + '/assets/FONTS-OFL.txt')).status, 200);
});
