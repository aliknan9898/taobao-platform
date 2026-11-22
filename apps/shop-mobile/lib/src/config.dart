/// Build-time configuration. Values come from `--dart-define-from-file=config/<env>.json`
/// (see config/*.example.json). No secrets belong here: the Stripe publishable key is read from
/// the server's public config at run time, and server keys never reach the app.
class AppConfig {
  const AppConfig({required this.apiBaseUrl, required this.appEnv});

  final Uri apiBaseUrl;
  final String appEnv;

  static AppConfig fromEnvironment() {
    const raw = String.fromEnvironment('API_BASE_URL');
    const env = String.fromEnvironment('APP_ENV', defaultValue: 'local');
    if (raw.isEmpty) {
      throw StateError('API_BASE_URL is not set. Run with --dart-define-from-file=config/local.json');
    }
    final uri = Uri.parse(raw.endsWith('/') ? raw.substring(0, raw.length - 1) : raw);
    if (!uri.hasScheme || (uri.scheme != 'https' && uri.scheme != 'http')) {
      throw StateError('API_BASE_URL must be an http(s) URL');
    }
    if (env == 'production') {
      // The pilot is not approved for production. Refuse to build against it by accident.
      throw StateError('APP_ENV=production is not allowed for the pilot build');
    }
    return AppConfig(apiBaseUrl: uri, appEnv: env);
  }

  /// Images in API responses are often relative (`/img/l/...`).
  Uri resolve(String pathOrUrl) => apiBaseUrl.resolve(pathOrUrl);
}
