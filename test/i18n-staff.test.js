'use strict';
/* Staff apps: English/Arabic only, and their extra Arabic never overrides the shop's wording. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path'); const vm = require('vm');

function load(phoneLang, langsAttr) {
  const noop = () => {};
  const sb = { window: {}, navigator: { language: phoneLang, languages: [phoneLang] }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { documentElement: { setAttribute: noop, getAttribute: (k) => (k === 'data-langs' ? langsAttr : null) }, readyState: 'loading', addEventListener: noop, body: null, title: '' },
    location: { reload: noop }, fetch: () => new Promise(noop), console };
  sb.window = sb;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/assets/i18n.js'), 'utf8'), sb);
  return sb;
}

test('a French phone gets English on staff pages, Arabic stays Arabic', () => {
  assert.strictEqual(load('fr-FR', 'en ar').KinanLang.lang, 'en');
  assert.strictEqual(load('ar-MT', 'en ar').KinanLang.lang, 'ar');
  assert.strictEqual(load('fr-FR', null).KinanLang.lang, 'fr', 'the shop keeps every language');
});

test('the staff dictionary adds phrases and patterns without overriding existing ones', () => {
  const sb = load('ar', 'en ar');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/assets/i18n-staff.js'), 'utf8'), sb);
  const t = sb.KinanLang.t;
  assert.strictEqual(t('Receive parcel'), 'استلام طرد');
  assert.strictEqual(t('Expected (4)'), 'المتوقع (4)');
  assert.strictEqual(t('Order 1A2B3C4D: cj purchase problem'), 'الطلب 1A2B3C4D: مشكلة في الشراء من cj');
  assert.strictEqual(t('Sign out'), 'تسجيل الخروج', 'shared wording comes from the main dictionary');
});
