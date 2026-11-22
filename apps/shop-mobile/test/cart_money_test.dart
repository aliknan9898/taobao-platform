import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:kinan_shop/src/api/models.dart';
import 'package:kinan_shop/src/money.dart';
import 'package:kinan_shop/src/state/cart.dart';

import 'fixtures.dart';

String strip(String s) => s.replaceAll('⁨', '').replaceAll('⁩', '');

void main() {
  final page = CatalogPage.fromJson(jsonDecode(catalogJson) as Map<String, dynamic>);
  final lamp = page.items[0];
  final heater = page.items[1];

  test('money uses the explicit currency code and Latin digits in both languages', () {
    expect(strip(formatMoney(29.9, 'EUR', 'en')), contains('29.90'));
    expect(strip(formatMoney(29.9, 'EUR', 'en')), contains('€'));
    final ar = strip(formatMoney(1234.5, 'usd', 'ar'));
    expect(ar, contains('1'));
    expect(RegExp('[٠-٩]').hasMatch(ar), isFalse, 'no Arabic-Indic digits');
    expect(formatMoney(1, 'USD', 'ar').startsWith('⁨'), isTrue, 'isolated for RTL');
    expect(strip(formatMoney(1.5, 'KWD', 'en')), contains('1.500'));
    expect(sameAmount(29.9, 29.900000001), isTrue);
  });

  test('revalidation flags price changes, stock and destination eligibility', () {
    final cart = Cart()
      ..add(lamp, lamp.sku('v_red')!, 2)
      ..add(heater, heater.skus.first, 1);
    expect(cart.revalidate(page.items, country: 'SA'), isFalse, 'nothing changed for SA');
    final dearer = Product.fromJson({
      ...jsonDecode(catalogJson)['items'][0] as Map<String, dynamic>,
      'skus': [{'mp_sku_id': 'v_red', 'props': 'Red', 'price': 24, 'in_stock': true, 'stock': 1}],
    });
    expect(cart.revalidate([dearer, heater], country: 'MT'), isTrue);
    final l = cart.lines.first;
    expect(l.previousPrice, 20);
    expect(l.unitPrice, 24);
    expect(l.qty, 1, 'capped at the stock left');
    expect(cart.lines[1].undeliverable, isTrue, 'heater cannot go to MT');
    expect(cart.payable.length, 1);
    expect(cart.subtotal, 24);
    cart.revalidate([heater], country: 'MT');
    expect(cart.lines.first.unavailable, isTrue, 'missing from catalog/many = no longer sold');
  });

  test('cart survives encode/decode', () {
    final cart = Cart()..add(lamp, lamp.sku('v_red')!, 2);
    final again = Cart()..load(cart.encode());
    expect(again.lines.single.qty, 2);
    expect(again.lines.single.apiItem(), {'listing_id': 'lst_lamp', 'mp_sku_id': 'v_red', 'qty': 2});
  });
}
