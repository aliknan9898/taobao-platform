'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
const navigation = html.slice(html.indexOf('const ALL_TABS ='), html.indexOf('function boot(user)'));

function fixture(user, hash) {
  return vm.runInNewContext(navigation + `
    me = user;
    TABS = ALL_TABS.filter(([, , roles]) => can(roles));
    tab = hashSection() || TABS[0][0];
    ({ nav: adminNav(), keys: TABS.map(([id]) => id).join(','), tab, hash: hashSection(),
       matchesArabic: navText('تَسْعِير', NAV_KEYWORDS.pricing).includes('تسعير') });
  `, { user, location: { hash }, esc: (text) => text.replaceAll('&', '&amp;') });
}

test('owner navigation includes each allowed section once and opens the deep-linked group', () => {
  const result = fixture({ role: 'admin', owner: true }, '#section/pricing');
  assert.equal(result.tab, 'pricing');
  assert.match(result.nav, /data-group="Pricing &amp; finance" open/);
  assert.deepEqual([...result.nav.matchAll(/data-t="([^"]+)"/g)].map((m) => m[1]).sort(), result.keys.split(',').sort());
  assert.equal(result.matchesArabic, true);
});

test('direct links, sidebar and defaults respect staff roles', () => {
  const result = fixture({ role: 'operator' }, '#section/pricing');
  assert.equal(result.hash, null);
  assert.equal(result.tab, 'team-orders');
  assert.doesNotMatch(result.nav, /data-t="(?:pricing|activity|payouts)"/);
  assert.match(result.nav, /data-t="mail"/);
  assert.equal(fixture({ role: 'ly_staff' }, '#orders').tab, 'libya');
  assert.equal(fixture({ role: 'admin' }, '#ebay').tab, 'ebay');
});

test('supplier panel links resolve to the supplier view only for admins', () => {
  const hash = '#section/smart-import-cj/usage';
  assert.equal(fixture({ role: 'admin' }, hash).tab, 'smart-import-cj');
  assert.equal(fixture({ role: 'operator' }, hash).hash, null);
});
