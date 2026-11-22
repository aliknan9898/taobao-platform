import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'src/api/api_client.dart';
import 'src/checkout/checkout_attempt.dart';
import 'src/config.dart';
import 'src/l10n/strings.dart';
import 'src/state/app_state.dart';
import 'src/storage/stores.dart';
import 'src/ui/catalog_screen.dart';
import 'src/ui/destination_screen.dart';
import 'src/ui/order_screen.dart';
import 'src/ui/widgets.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final config = AppConfig.fromEnvironment();
  final state = AppState(
    config: config,
    api: ApiClient(baseUrl: config.apiBaseUrl),
    secure: SecureStore(),
    prefs: await PrefsStore.open(),
  );
  runApp(KinanShopApp(state: state));
}

class KinanShopApp extends StatelessWidget {
  const KinanShopApp({super.key, required this.state, this.home});
  final AppState state;
  final Widget? home; // tests

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: state,
      child: ListenableBuilder(
        listenable: state,
        builder: (context, _) => MaterialApp(
          title: 'KINAN Shop',
          debugShowCheckedModeBanner: false,
          locale: state.locale,
          supportedLocales: const [Locale('en'), Locale('ar')],
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          theme: ThemeData(colorSchemeSeed: const Color(0xFF0E7C66), useMaterial3: true),
          darkTheme: ThemeData(colorSchemeSeed: const Color(0xFF0E7C66), brightness: Brightness.dark, useMaterial3: true),
          home: home ?? const _Start(),
        ),
      ),
    );
  }
}

/// Loads settings + public config, then resolves any checkout attempt left uncertain by a
/// crash, a restart or a dropped connection before showing the shop.
class _Start extends StatefulWidget {
  const _Start();
  @override
  State<_Start> createState() => _StartState();
}

class _StartState extends State<_Start> {
  Object? _error;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _boot());
  }

  Future<void> _boot() async {
    final st = AppScope.read(context);
    setState(() => _error = null);
    try {
      await st.start();
    } catch (e) {
      if (mounted) setState(() => _error = e);
      return;
    }
    if (!mounted) return;
    setState(() => _ready = true);
    if (st.signedIn) {
      final r = await st.checkout.recover();
      if (!mounted || r is! CheckoutPlaced) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(
          builder: (_) => OrderScreen(orderId: r.order.id, initial: r.order, notice: S.of(context).t('recovered_previous'))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = AppScope.of(context);
    final s = S.of(context);
    if (_error != null) {
      return Scaffold(body: Column(children: [const EnvBanner(), Expanded(child: ErrorRetry(message: s.t('load_error'), onRetry: _boot))]));
    }
    if (!_ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    return st.hasDestination ? const CatalogScreen() : const DestinationScreen();
  }
}
