import 'package:flutter_test/flutter_test.dart';
import 'package:kinan_mobile/main.dart';

void main() {
  const origin = 'https://kinan.shop';

  test('Keeps same-origin HTTPS pages in the app', () {
    expect(isKinanNavigation(Uri.parse('$origin/shop'), origin), isTrue);
    expect(isKinanNavigation(Uri.parse('$origin/seller#/add'), origin), isTrue);
  });

  test('Keeps external origins and non-HTTPS schemes out of WebView', () {
    for (final raw in [
      'http://kinan.shop/shop',
      'https://kinan.shop:8443/seller',
      'https://kinan.shop.example/seller',
      'https://user@kinan.shop/seller',
      'javascript:alert(1)',
      'file:///tmp/example.html',
    ]) {
      expect(isKinanNavigation(Uri.parse(raw), origin), isFalse, reason: raw);
    }
  });
}
