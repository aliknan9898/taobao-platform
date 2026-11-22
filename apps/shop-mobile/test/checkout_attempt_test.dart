import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kinan_shop/src/api/api_client.dart';
import 'package:kinan_shop/src/checkout/checkout_attempt.dart';
import 'package:kinan_shop/src/storage/stores.dart';

import 'fixtures.dart';

/// A fake Shop API that behaves like POST /api/buyer/checkout with Idempotency-Key:
/// one order per key, 409 for the same key with a different body.
class FakeCheckoutServer {
  final ordersByKey = <String, String>{}; // key -> body
  final requests = <({String key, String body})>[];
  bool dropNextResponse = false; // order is created, but the phone never gets the answer
  bool offline = false;
  int status = 201;

  MockClient client() => MockClient((req) async {
        if (offline) throw const SocketException('offline');
        final key = req.headers['Idempotency-Key']!;
        requests.add((key: key, body: req.body));
        if (status != 201) return http.Response('{"error":"Not enough stock: Lamp (Red)"}', status);
        final prev = ordersByKey[key];
        if (prev != null && prev != req.body) return http.Response('{"error":"This Idempotency-Key was already used for a different checkout"}', 409);
        ordersByKey[key] = req.body;
        if (dropNextResponse) {
          dropNextResponse = false;
          throw TimeoutException('lost');
        }
        return http.Response(orderPendingJson, prev == null ? 201 : 200, headers: {'content-type': 'application/json'});
      });
}

void main() {
  late FakeCheckoutServer server;
  late MemoryStore store;
  late int keys;

  CheckoutCoordinator coordinator() => CheckoutCoordinator(
        api: ApiClient(baseUrl: Uri.parse('http://test'), client: server.client())..token = 't',
        store: store, // the same store survives an "app restart"
        keyFactory: () => 'kshop-test-key-${++keys}',
      );

  String body(int qty) => checkoutBody(items: [{'listing_id': 'lst_lamp', 'mp_sku_id': 'v_red', 'qty': qty}], address: {
        'name': 'Pilot', 'phone': '+35679000000', 'country_code': 'MT', 'city': 'Valletta', 'line1': 'St 1', 'line2': '',
      });

  setUp(() {
    server = FakeCheckoutServer();
    store = MemoryStore();
    keys = 0;
  });

  test('keys match the server rule and are random', () {
    final a = newIdempotencyKey();
    expect(RegExp(r'^[A-Za-z0-9_-]{8,100}$').hasMatch(a), isTrue);
    expect(newIdempotencyKey(), isNot(a));
  });

  test('the body has a stable byte order and omits empty optional fields', () {
    expect(body(1), body(1));
    expect(body(1).contains('line2'), isFalse);
  });

  test('lost response + app restart + retry → same key, same bytes, one order', () async {
    server.dropNextResponse = true;
    final first = await coordinator().submit(body(2));
    expect(first, isA<CheckoutUncertain>());
    expect((await coordinator().pending())!.uncertain, isTrue, 'attempt persisted before sending');

    // "restart": a brand-new coordinator reading the same secure store
    final recovered = await coordinator().recover();
    expect(recovered, isA<CheckoutPlaced>());
    expect(server.ordersByKey.length, 1, 'one order on the server');
    expect(server.requests.map((r) => r.key).toSet(), {'kshop-test-key-1'});
    expect(server.requests.map((r) => r.body).toSet().length, 1, 'byte-identical retries');
    expect((await coordinator().pending())!.orderId, 'ord_d14c6ba6c8e0af75');
  });

  test('offline: the attempt is kept and retried with the same key', () async {
    server.offline = true;
    expect(await coordinator().submit(body(1)), isA<CheckoutUncertain>());
    server.offline = false;
    expect(await coordinator().submit(body(1)), isA<CheckoutPlaced>());
    expect(server.requests.map((r) => r.key).toSet(), {'kshop-test-key-1'});
  });

  test('a changed basket first resolves the uncertain attempt, then gets a new key', () async {
    server.dropNextResponse = true;
    await coordinator().submit(body(1));
    final r = await coordinator().submit(body(3)); // buyer changed the cart meanwhile
    expect(r, isA<CheckoutPlaced>());
    expect((r as CheckoutPlaced).recoveredPrevious, isTrue, 'the earlier order is shown, not a new one');
    expect(server.ordersByKey.length, 1);
    final next = await coordinator().submit(body(3));
    expect(next, isA<CheckoutPlaced>());
    expect(server.ordersByKey.keys, ['kshop-test-key-1', 'kshop-test-key-2']);
  });

  test('a refused basket clears the attempt (nothing was created)', () async {
    server.status = 409;
    final r = await coordinator().submit(body(1));
    expect(r, isA<CheckoutRejected>());
    expect(await coordinator().pending(), isNull);
  });

  test('an expired session never drops an uncertain attempt', () async {
    server.dropNextResponse = true;
    await coordinator().submit(body(1));
    server.status = 401;
    final r = await coordinator().submit(body(2));
    expect(r, isA<CheckoutRejected>());
    expect((await coordinator().pending())!.key, 'kshop-test-key-1', 'kept for after sign-in');
    expect(server.requests.where((x) => x.key != 'kshop-test-key-1'), isEmpty, 'no new key used');
  });

  test('5xx is uncertain, not a refusal', () async {
    server.status = 502;
    expect(await coordinator().submit(body(1)), isA<CheckoutUncertain>());
    expect((await coordinator().pending())!.uncertain, isTrue);
  });
}
