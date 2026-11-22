import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kinan_shop/main.dart';
import 'package:kinan_shop/src/api/api_client.dart';
import 'package:kinan_shop/src/api/models.dart';
import 'package:kinan_shop/src/config.dart';
import 'package:kinan_shop/src/state/app_state.dart';
import 'package:kinan_shop/src/storage/stores.dart';
import 'package:kinan_shop/src/ui/catalog_screen.dart';
import 'package:kinan_shop/src/ui/destination_screen.dart';

import 'fixtures.dart';

AppState fakeState(String lang) {
  final api = ApiClient(
    baseUrl: Uri.parse('http://test'),
    client: MockClient((req) async {
      if (req.url.path == '/api/catalog') {
        expect(req.url.queryParameters['country'], 'MT');
        return http.Response.bytes(utf8.encode(catalogJson), 200, headers: {'content-type': 'application/json; charset=utf-8'});
      }
      return http.Response('{"error":"not found"}', 404);
    }),
  );
  return AppState(config: AppConfig(apiBaseUrl: Uri.parse('http://test'), appEnv: 'test'), api: api, secure: MemoryStore(), prefs: MemoryStore())
    ..lang = lang
    ..country = 'MT'
    ..publicConfig = PublicConfig.fromJson({
      'currency': 'usd',
      'payments': 'demo',
      'countries': [['MT', 'Malta'], ['SA', 'Saudi Arabia']],
    });
}

void main() {
  testWidgets('Arabic is right-to-left, English left-to-right, with the same screen', (tester) async {
    for (final (lang, dir, title) in [('ar', TextDirection.rtl, 'إلى أين نوصل طلبك؟'), ('en', TextDirection.ltr, 'Where should we deliver?')]) {
      await tester.pumpWidget(KinanShopApp(state: fakeState(lang), home: const DestinationScreen()));
      await tester.pumpAndSettle();
      expect(find.text(title), findsOneWidget);
      expect(Directionality.of(tester.element(find.text(title))), dir);
      expect(find.textContaining('MOCK').evaluate().isNotEmpty || find.textContaining('وهمي').evaluate().isNotEmpty, isTrue, 'mock payments are labelled');
    }
  });

  testWidgets('catalog loads for the destination and shows prices with explicit currency', (tester) async {
    tester.view.physicalSize = const Size(360 * 3, 640 * 3); // small phone
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(KinanShopApp(state: fakeState('ar'), home: const CatalogScreen()));
    await tester.pumpAndSettle();
    expect(find.text('مصباح'), findsOneWidget, 'Arabic title used');
    expect(find.textContaining('US\$'), findsWidgets);
    expect(tester.takeException(), isNull, 'no overflow on a small screen');
  });
}
