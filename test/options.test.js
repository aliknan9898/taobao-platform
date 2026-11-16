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

test('the colour keeps its photos even when it is the second option', () => {
  const og = optionGroups([
    { opts: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Red' }], image: 'https://x/r.jpg' },
    { opts: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Red' }], image: 'https://x/r.jpg' },
    { opts: [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Blue' }], image: 'https://x/b.jpg' }
  ]);
  assert.strictEqual(og.groups[0].values.some((v) => v.image), false);
  assert.deepStrictEqual(og.groups[1].values.map((v) => v.image), ['https://x/r.jpg', 'https://x/b.jpg']);
});

test('AliExpress options carry their own photo and names', () => {
  const { normalizeProduct } = require('../src/services/aliexpress');
  const p = normalizeProduct({ ae_item_base_info_dto: { product_id: 1, subject: 'Mug' }, ae_multimedia_info_dto: { image_urls: 'https://a/1.jpg' },
    ae_item_sku_info_dtos: { ae_item_sku_info_d_t_o: [
      { sku_id: '11', sku_attr: '14:1', offer_sale_price: '3', sku_available_stock: 5, ae_sku_property_dtos: { ae_sku_property_d_t_o: [{ sku_property_name: 'Color', sku_property_value: 'red', property_value_definition_name: 'Red', sku_image: 'http://a/red.jpg' }] } },
      { sku_id: '12', sku_attr: '14:2', offer_sale_price: '3', sku_available_stock: 5, ae_sku_property_dtos: { ae_sku_property_d_t_o: [{ sku_property_name: 'Color', sku_property_value: 'blue', sku_image: 'https://a/blue.jpg' }] } }
    ] } }, '1');
  assert.strictEqual(p.skus[0].image, 'https://a/red.jpg');
  assert.deepStrictEqual(p.skus[1].opts, [{ name: 'Color', value: 'blue' }]);
});
