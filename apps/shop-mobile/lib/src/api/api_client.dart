import 'dart:async';
import 'dart:convert';
import 'dart:io' show SocketException, HandshakeException;

import 'package:http/http.dart' as http;

import 'models.dart';

/// The server answered with an error status. `{ "error": "...", "code"?: "..." }` per docs/API.md.
class ApiException implements Exception {
  ApiException(this.status, this.message, {this.code});
  final int status;
  final String message;
  final String? code;

  bool get isUnauthorized => status == 401;

  /// The request was understood and refused: nothing was created (400/401/403/404/409/422).
  bool get isDefinitive => status >= 400 && status < 500 && status != 408 && status != 429;

  @override
  String toString() => 'ApiException($status, $message)';
}

/// No usable answer arrived (offline, timeout, connection dropped, 5xx gateway). For a POST the
/// server may or may not have acted on it, so callers must treat the outcome as unknown.
class NetworkUncertainException implements Exception {
  NetworkUncertainException(this.cause);
  final Object cause;
  @override
  String toString() => 'NetworkUncertainException($cause)';
}

class ApiClient {
  ApiClient({required this.baseUrl, http.Client? client, this.timeout = const Duration(seconds: 20)})
      : _http = client ?? http.Client();

  final Uri baseUrl;
  final http.Client _http;
  final Duration timeout;

  String? token;
  String lang = 'en';

  /// Called when an authenticated request returns 401 (expired / revoked session).
  void Function()? onUnauthorized;

  Map<String, String> _headers([Map<String, String>? extra]) => {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Kinan-Lang': lang,
        if (token != null) 'Authorization': 'Bearer $token',
        ...?extra,
      };

  Uri _uri(String path, [Map<String, String>? query]) =>
      baseUrl.replace(path: '${baseUrl.path}$path', queryParameters: query == null || query.isEmpty ? null : query);

  Future<Object?> _send(String method, String path, {Map<String, String>? query, String? body, Map<String, String>? headers}) async {
    final req = http.Request(method, _uri(path, query))..headers.addAll(_headers(headers));
    if (body != null) req.body = body;
    http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req).timeout(timeout)).timeout(timeout);
    } on TimeoutException catch (e) {
      throw NetworkUncertainException(e);
    } on SocketException catch (e) {
      throw NetworkUncertainException(e);
    } on HandshakeException catch (e) {
      throw NetworkUncertainException(e);
    } on http.ClientException catch (e) {
      throw NetworkUncertainException(e);
    }
    if (res.statusCode >= 500 || res.statusCode == 408) {
      // 5xx: the server may have done part of the work. Never treat as definitive.
      throw NetworkUncertainException(ApiException(res.statusCode, _errorText(res)));
    }
    if (res.statusCode >= 400) {
      final e = ApiException(res.statusCode, _errorText(res), code: _errorCode(res));
      if (e.isUnauthorized && token != null) onUnauthorized?.call();
      throw e;
    }
    if (res.body.isEmpty) return null;
    try {
      return jsonDecode(utf8.decode(res.bodyBytes));
    } on FormatException {
      throw ApiException(res.statusCode, 'Unexpected response from the server');
    }
  }

  static String _errorText(http.Response res) {
    try {
      final j = jsonDecode(utf8.decode(res.bodyBytes));
      if (j is Map && j['error'] is String) return j['error'] as String;
    } catch (_) {/* not JSON */}
    return 'HTTP ${res.statusCode}';
  }

  static String? _errorCode(http.Response res) {
    try {
      final j = jsonDecode(utf8.decode(res.bodyBytes));
      if (j is Map && j['code'] is String) return j['code'] as String;
    } catch (_) {/* not JSON */}
    return null;
  }

  // ---- Shared ----
  Future<PublicConfig> publicConfig() async => PublicConfig.fromJson(asObject(await _send('GET', '/api/config/public'), 'config'));

  /// `POST /api/auth/login` with `app: "shop"` so the session is a buyer session.
  Future<({String token, User user})> login(String email, String password) async {
    final j = asObject(await _send('POST', '/api/auth/login', body: jsonEncode({'email': email, 'password': password, 'app': 'shop'})), 'login');
    final t = j['token'];
    if (t is! String || t.isEmpty) throw const FormatException('login: token missing');
    return (token: t, user: User.fromJson(asObject(j['user'], 'login.user')));
  }

  Future<void> logout() async {
    try {
      await _send('POST', '/api/auth/logout');
    } catch (_) {/* sign-out is local first; the server session expires anyway */}
  }

  Future<User> me() async => User.fromJson(asObject(await _send('GET', '/api/me'), 'me'));

  // ---- Catalog ----
  Future<CatalogPage> catalog({required String country, int limit = 20, int offset = 0, String q = ''}) async {
    final j = await _send('GET', '/api/catalog', query: {
      'country': country,
      'limit': '$limit',
      'offset': '$offset',
      if (q.isNotEmpty) 'q': q,
    });
    return CatalogPage.fromJson(asObject(j, 'catalog'));
  }

  Future<Product> product(String id) async => Product.fromJson(asObject(await _send('GET', '/api/catalog/${Uri.encodeComponent(id)}'), 'product'));

  /// Up to 30 products at once; ids that are no longer sold are simply missing from the answer.
  Future<List<Product>> products(List<String> ids) async {
    if (ids.isEmpty) return const [];
    final j = asObject(await _send('GET', '/api/catalog/many', query: {'ids': ids.take(30).join(',')}), 'catalog/many');
    return CatalogPage.fromJson({...j, 'total': (j['items'] as List?)?.length ?? 0}).items;
  }

  Future<ShippingQuote> shippingQuote(String country, List<Map<String, Object>> items) async =>
      ShippingQuote.fromJson(asObject(
          await _send('POST', '/api/shipping/quote', body: jsonEncode({'country_code': country, 'items': items})), 'shipping/quote'));

  // ---- Buyer ----
  /// [rawBody] is sent verbatim so a retry is byte-identical to the first attempt (the server
  /// compares a hash of the body for the same Idempotency-Key).
  Future<Order> checkout({required String idempotencyKey, required String rawBody}) async =>
      Order.fromJson(asObject(await _send('POST', '/api/buyer/checkout', body: rawBody, headers: {'Idempotency-Key': idempotencyKey}), 'checkout'));

  Future<List<Order>> orders() async {
    final j = await _send('GET', '/api/buyer/orders');
    if (j is! List) throw const FormatException('orders: expected a list');
    return [for (final o in j) Order.fromJson(asObject(o, 'orders[]'))];
  }

  Future<Order> order(String id) async => Order.fromJson(asObject(await _send('GET', '/api/buyer/orders/${Uri.encodeComponent(id)}'), 'order'));

  Future<Order> cancelOrder(String id) async =>
      Order.fromJson(asObject(await _send('POST', '/api/buyer/orders/${Uri.encodeComponent(id)}/cancel'), 'cancel'));

  /// Demo (mock) payment. The server only allows it when it has no Stripe keys.
  Future<Order> demoPay(String id) async =>
      Order.fromJson(asObject(await _send('POST', '/api/buyer/orders/${Uri.encodeComponent(id)}/demo-pay'), 'demo-pay'));
}
