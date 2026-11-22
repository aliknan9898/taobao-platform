import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Minimal string store so logic can be unit-tested with [MemoryStore].
abstract class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class MemoryStore implements KeyValueStore {
  final Map<String, String> data = {};
  @override
  Future<String?> read(String key) async => data[key];
  @override
  Future<void> write(String key, String value) async => data[key] = value;
  @override
  Future<void> delete(String key) async => data.remove(key);
}

/// Keychain (iOS) / Keystore-backed encrypted storage (Android). Used for the session token and
/// for the pending checkout attempt, which contains the delivery address and phone number.
class SecureStore implements KeyValueStore {
  SecureStore() : _s = const FlutterSecureStorage();
  final FlutterSecureStorage _s;
  @override
  Future<String?> read(String key) => _s.read(key: key);
  @override
  Future<void> write(String key, String value) => _s.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _s.delete(key: key);
}

/// Non-sensitive preferences: language, destination, cart contents.
class PrefsStore implements KeyValueStore {
  PrefsStore(this._p);
  final SharedPreferences _p;
  static Future<PrefsStore> open() async => PrefsStore(await SharedPreferences.getInstance());
  @override
  Future<String?> read(String key) async => _p.getString(key);
  @override
  Future<void> write(String key, String value) => _p.setString(key, value).then((_) {});
  @override
  Future<void> delete(String key) => _p.remove(key).then((_) {});
}

abstract final class StoreKeys {
  static const token = 'kinan.session.token';
  static const checkoutAttempt = 'kinan.checkout.attempt';
  static const lang = 'kinan.lang';
  static const country = 'kinan.country';
  static const cart = 'kinan.cart';
}
