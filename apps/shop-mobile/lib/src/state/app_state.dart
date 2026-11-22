import 'dart:async';

import 'package:flutter/widgets.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../checkout/checkout_attempt.dart';
import '../config.dart';
import '../storage/stores.dart';
import 'cart.dart';

class AppState extends ChangeNotifier {
  AppState({required this.config, required this.api, required this.secure, required this.prefs})
      : checkout = CheckoutCoordinator(api: api, store: secure) {
    api.onUnauthorized = _sessionEnded;
  }

  final AppConfig config;
  final ApiClient api;
  final KeyValueStore secure;
  final KeyValueStore prefs;
  final CheckoutCoordinator checkout;
  final Cart cart = Cart();

  PublicConfig? publicConfig;
  String lang = 'en';
  String? country;
  User? user;
  bool sessionExpired = false;

  bool get signedIn => user != null;
  bool get hasDestination => country != null;
  Locale get locale => Locale(lang);

  String countryName(String code) {
    for (final c in publicConfig?.countries ?? const <Country>[]) {
      if (c.code == code) return c.name;
    }
    return code;
  }

  /// Loads saved preferences, the session and the server's public config.
  Future<void> start() async {
    lang = await prefs.read(StoreKeys.lang) ?? (WidgetsBinding.instance.platformDispatcher.locale.languageCode == 'ar' ? 'ar' : 'en');
    country = await prefs.read(StoreKeys.country);
    cart.load(await prefs.read(StoreKeys.cart));
    api.lang = lang;
    final token = await secure.read(StoreKeys.token);
    if (token != null) {
      api.token = token;
      try {
        final u = await api.me();
        user = u.role == 'buyer' ? u : null;
        if (user == null) await _clearSession();
      } on ApiException catch (e) {
        if (e.isUnauthorized) await _clearSession();
      } catch (_) {/* offline: keep the token, try again later */}
    }
    await loadPublicConfig();
    notifyListeners();
  }

  Future<void> loadPublicConfig() async {
    publicConfig = await api.publicConfig();
    final c = country;
    if (c != null && publicConfig!.countries.every((x) => x.code != c)) country = null; // no longer supported
    notifyListeners();
  }

  Future<void> setLanguage(String l) async {
    lang = l;
    api.lang = l;
    await prefs.write(StoreKeys.lang, l);
    notifyListeners();
  }

  Future<void> setCountry(String code) async {
    country = code;
    await prefs.write(StoreKeys.country, code);
    notifyListeners();
  }

  Future<void> saveCart() async {
    await prefs.write(StoreKeys.cart, cart.encode());
    notifyListeners();
  }

  Future<void> signIn(String email, String password) async {
    final r = await api.login(email.trim(), password);
    if (r.user.role != 'buyer') throw ApiException(403, 'Not a customer account');
    api.token = r.token;
    await secure.write(StoreKeys.token, r.token);
    user = r.user;
    sessionExpired = false;
    notifyListeners();
  }

  Future<void> signOut() async {
    await api.logout();
    await _clearSession();
    notifyListeners();
  }

  Future<void> _clearSession() async {
    api.token = null;
    user = null;
    await secure.delete(StoreKeys.token);
    // The pending checkout attempt belongs to this customer (its key is per customer on the server).
    await checkout.clear();
  }

  void _sessionEnded() {
    sessionExpired = true;
    api.token = null;
    user = null;
    unawaited(secure.delete(StoreKeys.token));
    notifyListeners();
  }
}

class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);

  static AppState of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
  static AppState read(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}
