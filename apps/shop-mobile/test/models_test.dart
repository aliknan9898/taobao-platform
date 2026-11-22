import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:kinan_shop/src/api/models.dart';

import 'fixtures.dart';

void main() {
  test('catalog page parses products, variants and delivery eligibility', () {
    final page = CatalogPage.fromJson(jsonDecode(catalogJson) as Map<String, dynamic>);
    expect(page.total, 2);
    final lamp = page.items.first;
    expect(lamp.currency, 'USD');
    expect(lamp.titleFor('ar'), 'مصباح');
    expect(lamp.titleFor('en'), 'Lamp');
    expect(lamp.sku('v_blue')!.inStock, isFalse);
    expect(lamp.deliverableTo('MT'), isTrue);
    expect(page.items[1].deliverableTo('MT'), isFalse);
    expect(page.items[1].deliverableTo('SA'), isTrue);
  });

  test('order parses server totals, currency and client secret', () {
    final o = Order.fromJson(jsonDecode(orderPendingJson) as Map<String, dynamic>);
    expect(o.currency, 'EUR');
    expect(o.total, 29.9);
    expect(o.awaitingPayment, isTrue);
    expect(o.clientSecret, 'pi_1_secret_x');
    final shipped = Order.fromJson(jsonDecode(orderShippedJson) as Map<String, dynamic>);
    expect(shipped.isPaid, isTrue);
    expect(shipped.clientSecret, isNull);
    expect(shipped.tracking!.number, 'PILOT123456');
    expect(shipped.timeline.map((e) => e.event), ['created', 'paid', 'shipped']);
  });

  test('quote lists undeliverable listings', () {
    final q = ShippingQuote.fromJson(jsonDecode(quoteJson) as Map<String, dynamic>);
    expect(q.fee, 12.5);
    expect(q.undeliverable, ['lst_heater']);
  });

  test('an unexpected shape fails loudly instead of showing a wrong price', () {
    final bad = jsonDecode(orderPendingJson) as Map<String, dynamic>..['total'] = '29.90';
    expect(() => Order.fromJson(bad), throwsFormatException);
    final noCurrency = jsonDecode(orderPendingJson) as Map<String, dynamic>..remove('currency');
    expect(() => Order.fromJson(noCurrency), throwsFormatException);
  });

  test('public config keeps only test-mode Stripe keys', () {
    final base = {'currency': 'usd', 'payments': 'stripe', 'countries': [['MT', 'Malta']]};
    expect(PublicConfig.fromJson({...base, 'stripe_publishable_key': 'pk_live_x'}).stripePublishableKey, isNull);
    expect(PublicConfig.fromJson({...base, 'stripe_publishable_key': 'pk_test_x'}).stripePublishableKey, 'pk_test_x');
    expect(PublicConfig.fromJson({...base, 'payments': 'demo'}).isMockPayments, isTrue);
  });
}
