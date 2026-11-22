import 'dart:convert';
import 'dart:math';

import '../api/api_client.dart';
import '../api/models.dart';
import '../storage/stores.dart';

/// One logical checkout attempt: one Idempotency-Key bound to one exact request body.
/// Persisted (encrypted) BEFORE the request is sent, so after a timeout, a dropped connection or an
/// app restart the same key and the same bytes are sent again and the server returns the same order.
class CheckoutAttempt {
  CheckoutAttempt({required this.key, required this.body, required this.createdAt, this.orderId});

  final String key;
  final String body; // exact JSON sent to POST /api/buyer/checkout
  final DateTime createdAt;
  final String? orderId; // known once the server answered

  bool get uncertain => orderId == null;

  CheckoutAttempt withOrder(String id) => CheckoutAttempt(key: key, body: body, createdAt: createdAt, orderId: id);

  String encode() => jsonEncode({'key': key, 'body': body, 'created_at': createdAt.millisecondsSinceEpoch, 'order_id': orderId});

  static CheckoutAttempt? decode(String? raw) {
    if (raw == null) return null;
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return CheckoutAttempt(
        key: j['key'] as String,
        body: j['body'] as String,
        createdAt: DateTime.fromMillisecondsSinceEpoch(j['created_at'] as int),
        orderId: j['order_id'] as String?,
      );
    } catch (_) {
      return null; // unreadable: treated as no attempt
    }
  }
}

/// Server rule: `^[A-Za-z0-9_-]{8,100}$`. 32 random chars from a CSPRNG.
String newIdempotencyKey([Random? rng]) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  final r = rng ?? Random.secure();
  return 'kshop-${List.generate(32, (_) => chars[r.nextInt(chars.length)]).join()}';
}

/// Builds the checkout body with a fixed key order, so the same basket always gives the same bytes.
String checkoutBody({required List<Map<String, Object>> items, required Map<String, String> address}) => jsonEncode({
      'items': items,
      'shipping_address': {
        for (final k in const ['name', 'phone', 'country_code', 'city', 'line1', 'line2', 'postal_code'])
          if ((address[k] ?? '').trim().isNotEmpty) k: address[k]!.trim(),
      },
    });

sealed class CheckoutOutcome {
  const CheckoutOutcome();
}

/// The server created (or returned) the order for this attempt.
class CheckoutPlaced extends CheckoutOutcome {
  const CheckoutPlaced(this.order, {required this.recoveredPrevious});
  final Order order;

  /// True when this was a previous, uncertain attempt (different basket) that had to be resolved
  /// first. The UI must show that order instead of silently starting another one.
  final bool recoveredPrevious;
}

/// No answer: the order may or may not exist. The attempt is kept; retry sends the same key + body.
class CheckoutUncertain extends CheckoutOutcome {
  const CheckoutUncertain(this.cause);
  final Object cause;
}

/// The server refused the basket (stock, price, delivery, address…). No order was created.
class CheckoutRejected extends CheckoutOutcome {
  const CheckoutRejected(this.error);
  final ApiException error;
}

class CheckoutCoordinator {
  CheckoutCoordinator({required this.api, required this.store, this.keyFactory = newIdempotencyKey});

  final ApiClient api;
  final KeyValueStore store;
  final String Function() keyFactory;

  static const _maxAge = Duration(hours: 23); // server keeps keys for 24 h

  Future<CheckoutAttempt?> pending() async {
    final a = CheckoutAttempt.decode(await store.read(StoreKeys.checkoutAttempt));
    if (a != null && DateTime.now().difference(a.createdAt) > _maxAge && !a.uncertain) {
      await clear();
      return null;
    }
    return a;
  }

  Future<void> clear() => store.delete(StoreKeys.checkoutAttempt);

  /// Places the order for [body]. Order of operations:
  /// 1. An uncertain earlier attempt is always resolved first, with its own key and bytes.
  /// 2. A resolved attempt for the same bytes returns that order again (no new key).
  /// 3. Otherwise a new key is generated and saved before sending.
  Future<CheckoutOutcome> submit(String body) async {
    final prev = await pending();
    if (prev != null && prev.uncertain) {
      final r = await _send(prev);
      if (r is CheckoutPlaced && prev.body != body) return CheckoutPlaced(r.order, recoveredPrevious: true);
      if (r is! CheckoutRejected || prev.body == body) return r;
      // Continue with the new basket only if the earlier attempt was refused for good (and so cleared).
      if ((await pending())?.uncertain ?? false) return r;
    }
    if (prev != null && !prev.uncertain && prev.body == body) {
      return _send(prev);
    }
    final attempt = CheckoutAttempt(key: keyFactory(), body: body, createdAt: DateTime.now());
    await store.write(StoreKeys.checkoutAttempt, attempt.encode());
    return _send(attempt);
  }

  /// Resolves a saved uncertain attempt on app start / when connectivity returns.
  Future<CheckoutOutcome?> recover() async {
    final prev = await pending();
    if (prev == null || !prev.uncertain) return null;
    final r = await _send(prev);
    return r is CheckoutPlaced ? CheckoutPlaced(r.order, recoveredPrevious: true) : r;
  }

  Future<CheckoutOutcome> _send(CheckoutAttempt a) async {
    try {
      final order = await api.checkout(idempotencyKey: a.key, rawBody: a.body);
      await store.write(StoreKeys.checkoutAttempt, a.withOrder(order.id).encode());
      return CheckoutPlaced(order, recoveredPrevious: false);
    } on NetworkUncertainException catch (e) {
      return CheckoutUncertain(e);
    } on ApiException catch (e) {
      // 401/403: the session failed, which says nothing about an earlier send of this key. Keep it.
      // 429: rate limited — try again later with the same key.
      if (!e.isDefinitive || e.status == 401 || e.status == 403) {
        return e.isDefinitive ? CheckoutRejected(e) : CheckoutUncertain(e);
      }
      if (a.uncertain) await clear(); // 400/404/409/422: refused, so no order exists for this key
      return CheckoutRejected(e);
    } on FormatException catch (e) {
      // The server answered but the body did not parse: the order may exist. Keep the attempt.
      return CheckoutUncertain(e);
    }
  }

  /// Call when the order of the saved attempt is paid or cancelled: the next basket gets a new key.
  Future<void> finish(String orderId) async {
    final a = await pending();
    if (a != null && a.orderId == orderId) await clear();
  }
}
