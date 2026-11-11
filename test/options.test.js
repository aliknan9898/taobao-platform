// Copyright (c) 2026 Ali Almadhoun Mohammed Kinan. All rights reserved.
// Proprietary and confidential. See LICENSE.
'use strict';
/* Product options grouped into Color / Size for every product source. */
const test = require('node:test');
const assert = require('node:assert');
const { optionGroups } = require('../src/services/catalog');
const names = (og) => og && og.groups.map((g) => [g.name, g.values.map((v) => v.value)]);

test('Taobao style "Name: value / Name: value"', () => {
  const og = optionGroups([{ props: 'Color: Red / Size: M' }, { props: 'Color: Red / Size: L' }, { props: 'Color: Blue / Size: M' }]);
  assert.deepStrictEqual(names(og), [['Color', ['Red', 'Blue']], ['Size', ['M', 'L']]]);
  assert.deepStrictEqual(og.picks[2], ['Blue', 'M']);
});
test('manual "Red / M" gets Color and Size', () => {
  assert.deepStrictEqual(names(optionGroups([{ props: 'Black / L' }, { props: 'Black / XL' }])), [['Color', ['Black']], ['Size', ['L', 'XL']]]);
});
test('single option list', () => {
  assert.deepStrictEqual(names(optionGroups([{ props: '128GB' }, { props: '256GB' }])), [['Option', ['128GB', '256GB']]]);
});
test('stored names win; pictures kept on the first group only when they differ', () => {
  const og = optionGroups([{ opts: [{ name: 'Color', value: 'Red' }, { name: 'Size', value: 'S' }], image: 'https://x/r.jpg' }, { opts: [{ name: 'Color', value: 'Blue' }, { name: 'Size', value: 'S' }], image: 'https://x/b.jpg' }]);
  assert.strictEqual(og.groups[0].values[1].image, 'https://x/b.jpg'); assert.strictEqual(og.groups[1].values[0].image, undefined);
});
test('inconsistent options fall back to a simple list', () => {
  assert.strictEqual(optionGroups([{ props: 'Red / M' }, { props: 'Blue' }]), null);
  assert.strictEqual(optionGroups([{ props: 'Only one' }]), null);
});
