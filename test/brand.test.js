// Brand assets: every app links the KINAN bag artwork, the seller apps use the purple version,
// and each web manifest points at icons that exist with the sizes it declares.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');

function pngSize(file) {
  const b = fs.readFileSync(path.join(PUB, file));
  assert.strictEqual(b.toString('ascii', 1, 4), 'PNG', `${file} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('logo artwork exists for the main and seller apps', () => {
  for (const f of ['assets/logo-main.png', 'assets/logo-seller.png', 'assets/favicon-48.png', 'assets/favicon-seller-48.png']) {
    const [w, h] = pngSize(f);
    assert.strictEqual(w, h, `${f} is square`);
  }
});

test('web manifests reference icons that exist with the declared size', () => {
  for (const app of ['shop', 'seller', 'admin', 'warehouse']) {
    const m = JSON.parse(read(`assets/${app}.webmanifest`));
    assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
    for (const ic of m.icons) {
      const [w, h] = pngSize(ic.src.replace(/^\//, ''));
      assert.strictEqual(`${w}x${h}`, ic.sizes, `${app}: ${ic.src}`);
    }
    const seller = app === 'seller';
    assert.ok(m.icons.every((ic) => ic.src.includes('seller') === seller), `${app} uses the ${seller ? 'purple' : 'emerald'} icons`);
  }
});

test('pages use the new artwork and no longer link the retired SVG mark', () => {
  for (const page of ['shop.html', 'seller.html', 'admin.html', 'warehouse.html', 'download.html', 'reset.html', 'legal/_shell.html']) {
    const html = read(page);
    assert.ok(!html.includes('/assets/icon.svg'), `${page} links the retired icon`);
    assert.ok(!html.includes('M20 15h8v14l13-14h10'), `${page} still draws the old K`);
  }
  assert.match(read('seller.html'), /rel="icon" href="\/assets\/(favicon-seller-48|icon-seller-192)\.png"/);
  assert.match(read('admin.html'), /logo-main\.png/);
  assert.match(read('warehouse.html'), /logo-main\.png/);
});

test('brand helper picks the seller artwork only for the seller apps', () => {
  const src = read('assets/common.js');
  // Any browser global the helpers touch at load time resolves to an inert stub.
  const stub = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub), apply: () => stub, construct: () => stub });
  const ctx = new Proxy({ console, URL, URLSearchParams, Promise, setTimeout, clearTimeout }, { has: () => true, get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : k in globalThis ? globalThis[k] : stub) });
  // eslint-disable-next-line no-new-func
  const K = new Function('ctx', `with (ctx) { ${src}; return K; }`)(ctx);
  assert.match(K.brand('Seller Center'), /logo-seller\.png/);
  assert.match(K.brand('Seller'), /logo-seller\.png/);
  for (const sub of ['Shop', 'Admin', 'Warehouse', undefined]) assert.match(K.brand(sub), /logo-main\.png/);
  assert.match(K.brand('Shop'), /KINAN<span class="brand-tld">\.shop<\/span>/);
  assert.match(K.brand('Shop'), /dir="ltr"/, 'the name stays upright in Arabic');
});
