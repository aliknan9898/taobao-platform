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

test('static assets, service worker and traversal protection', async () => {
  const css = await fetch(base + '/assets/kinan.css');
  assert.strictEqual(css.status, 200); assert.match(css.headers.get('content-type'), /text\/css/);
  const man = await (await fetch(base + '/assets/shop.webmanifest')).json();
  assert.strictEqual(man.name, 'Kinan'); assert.strictEqual(man.display, 'standalone');
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
