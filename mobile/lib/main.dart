import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

const _configuredOrigin = String.fromEnvironment(
  'KINAN_ORIGIN',
  defaultValue: 'https://kinan.shop',
);

void main() => runApp(const KinanApp());

class KinanApp extends StatelessWidget {
  const KinanApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KINAN',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff49349a)),
      ),
      home: const KinanHome(),
    );
  }
}

enum KinanSection {
  shop('/shop'),
  seller('/seller');

  const KinanSection(this.path);
  final String path;
}

bool isKinanNavigation(Uri? uri, String origin) {
  return uri != null &&
      uri.scheme == 'https' &&
      uri.hasAuthority &&
      uri.userInfo.isEmpty &&
      uri.origin == origin;
}

class KinanHome extends StatefulWidget {
  const KinanHome({super.key});

  @override
  State<KinanHome> createState() => _KinanHomeState();
}

class _KinanHomeState extends State<KinanHome> {
  final _origin = Uri.parse(_configuredOrigin).origin;
  final _controllers = <KinanSection, WebViewController>{};
  final _failed = <KinanSection>{};
  final _progress = <KinanSection, int>{};
  KinanSection _section = KinanSection.shop;

  bool get _arabic =>
      Localizations.localeOf(context).languageCode == 'ar' ||
      WidgetsBinding.instance.platformDispatcher.locale.languageCode == 'ar';

  String _label(String en, String ar) => _arabic ? ar : en;
  Uri _entry(KinanSection section) => Uri.parse('$_origin${section.path}');

  @override
  void initState() {
    super.initState();
    _controller(_section);
  }

  WebViewController _controller(KinanSection section) {
    return _controllers.putIfAbsent(section, () {
      final controller = WebViewController();
      unawaited(_initialize(controller, section));
      return controller;
    });
  }

  Future<void> _initialize(
    WebViewController controller,
    KinanSection section,
  ) async {
    try {
      await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      await controller.setNavigationDelegate(
        NavigationDelegate(
          onProgress: (progress) {
            if (mounted) setState(() => _progress[section] = progress);
          },
          onPageStarted: (_) {
            if (mounted) setState(() => _failed.remove(section));
          },
          onWebResourceError: (error) {
            if (mounted && error.isForMainFrame == true) {
              setState(() => _failed.add(section));
            }
          },
          onNavigationRequest: (request) async {
            final uri = Uri.tryParse(request.url);
            if (isKinanNavigation(uri, _origin)) {
              return NavigationDecision.navigate;
            }
            if (request.isMainFrame &&
                uri != null &&
                (uri.scheme == 'https' ||
                    uri.scheme == 'mailto' ||
                    uri.scheme == 'tel')) {
              await _openExternal(uri);
            }
            return NavigationDecision.prevent;
          },
        ),
      );
      await controller.loadRequest(_entry(section));
    } catch (_) {
      if (mounted) setState(() => _failed.add(section));
    }
  }

  Future<void> _openExternal(Uri uri) async {
    try {
      if (await launchUrl(uri, mode: LaunchMode.externalApplication)) return;
    } catch (_) {
      // Some Android devices have no app registered for the link scheme.
    }
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            _label('Could not open this link.', 'تعذّر فتح الرابط.'),
          ),
        ),
      );
    }
  }

  Future<void> _goBack() async {
    final controller = _controller(_section);
    if (await controller.canGoBack()) {
      await controller.goBack();
    } else if (mounted && _section == KinanSection.seller) {
      setState(() => _section = KinanSection.shop);
    } else if (mounted) {
      await SystemNavigator.pop();
    }
  }

  Future<void> _browse() async {
    final current = await _controller(_section).currentUrl();
    await _openExternal(
      current == null ? _entry(_section) : Uri.parse(current),
    );
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller(_section);
    final progress = _progress[_section] ?? 0;
    final failed = _failed.contains(_section);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_goBack());
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(
            _section == KinanSection.shop ? 'KINAN Shop' : 'KINAN Seller',
          ),
          leading: IconButton(
            onPressed: _goBack,
            icon: const BackButtonIcon(),
            tooltip: _label('Go back', 'رجوع'),
          ),
          actions: [
            IconButton(
              onPressed: controller.reload,
              icon: const Icon(Icons.refresh),
              tooltip: _label('Refresh', 'تحديث'),
            ),
            IconButton(
              onPressed: _browse,
              icon: const Icon(Icons.open_in_browser),
              tooltip: _label('Open in browser', 'فتح في المتصفح'),
            ),
          ],
        ),
        body: Column(
          children: [
            if (!failed && progress < 100)
              LinearProgressIndicator(
                value: progress == 0 ? null : progress / 100,
              ),
            Expanded(
              child: failed
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              _label(
                                'Could not load KINAN. Check your connection.',
                                'تعذّر تحميل KINAN. تحقّق من الاتصال.',
                              ),
                            ),
                            const SizedBox(height: 12),
                            FilledButton(
                              onPressed: () =>
                                  controller.loadRequest(_entry(_section)),
                              child: Text(
                                _label('Try again', 'إعادة المحاولة'),
                              ),
                            ),
                          ],
                        ),
                      ),
                    )
                  : WebViewWidget(
                      key: ValueKey(_section),
                      controller: controller,
                    ),
            ),
          ],
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _section.index,
          onDestinationSelected: (index) {
            setState(() => _section = KinanSection.values[index]);
          },
          destinations: [
            NavigationDestination(
              icon: const Icon(Icons.storefront_outlined),
              label: _label('Shop', 'المتجر'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.business_center_outlined),
              label: _label('Seller', 'البائع'),
            ),
          ],
        ),
      ),
    );
  }
}
