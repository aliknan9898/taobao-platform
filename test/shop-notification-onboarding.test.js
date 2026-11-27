'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/shop.html'), 'utf8');
const code = html.slice(html.indexOf('const pushOnboardingKey'), html.indexOf('// ---------- views ----------'));
function fixture({ role = 'buyer', state = 'off' } = {}) {
  const makeStore = () => {
    const entries = new Map();
    return { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value),
      removeItem: (key) => entries.delete(key) };
  };
  let dialog;
  let enabled = 0;
  let permissionRequests = 0;
  let opens = 0;
  const location = { hash: '#/' };
  const Notification = { permission: 'default', requestPermission() {
    permissionRequests++; this.permission = 'granted'; return Promise.resolve('granted');
  } };
  const context = {
    window: { localStorage: makeStore(), sessionStorage: makeStore(), Notification }, Notification,
    document: {
      querySelector: () => dialog?.open ? dialog : null,
      body: { append(node) { dialog = node; } },
      createElement() {
        const children = new Map();
        return { setAttribute() {}, addEventListener() {}, showModal() { this.open = true; opens++; },
          close() { this.open = false; }, querySelector(key) {
            if (state === 'install' && key === '[data-push-allow]') return null;
            if (!children.has(key)) children.set(key, {});
            return children.get(key);
          } };
      }
    },
    me: role ? { role } : null, sessionReady: null, location, KinanLang: { lang: 'ar', t: (s) => s },
    K: { pushState: async () => state, enablePush: async () => { enabled++; } }, toast() {}, $: () => null
  };
  const api = vm.runInNewContext(code + '\n({ offerOrderNotifications, linkPendingPush })', context);
  return { ...api, context, location, get opens() { return opens; }, get enabled() { return enabled; },
    get permissionRequests() { return permissionRequests; }, get dialog() { return dialog; } };
}

test('shows once on first open and once for a newly confirmed order without interrupting payment', async () => {
  const app = fixture();
  await app.offerOrderNotifications();
  assert.match(app.dialog.innerHTML, /تفعيل الإشعارات/);
  assert.equal(app.enabled, 0);
  app.dialog.querySelector('[data-push-later]').onclick();
  await app.offerOrderNotifications();
  assert.equal(app.opens, 1);
  await app.offerOrderNotifications('order-a');
  await app.dialog.querySelector('[data-push-allow]').onclick();
  await app.offerOrderNotifications('order-a');
  assert.equal(app.opens, 2);
  assert.equal(app.enabled, 1);
});

test('guest permission is requested only on click and linked after sign-in', async () => {
  const app = fixture({ role: null });
  await app.offerOrderNotifications();
  assert.equal(app.permissionRequests, 0);
  await app.dialog.querySelector('[data-push-allow]').onclick();
  assert.equal(app.permissionRequests, 1);
  assert.match(app.location.hash, /signin/);
  assert.equal(app.enabled, 0);
  app.context.me = { role: 'buyer' };
  await app.linkPendingPush();
  await app.linkPendingPush();
  assert.equal(app.enabled, 1);
});

test('does not reprompt granted subscriptions or blocked permissions and offers iPhone installation', async () => {
  for (const state of ['on','denied','unsupported']) {
    const app = fixture({ state });
    await app.offerOrderNotifications('order-x');
    assert.equal(app.opens, 0);
  }
  const iphone = fixture({ state: 'install' });
  await iphone.offerOrderNotifications();
  assert.match(iphone.dialog.innerHTML, /href="\/download"/);
  assert.equal(iphone.dialog.querySelector('[data-push-allow]'), null);
});
