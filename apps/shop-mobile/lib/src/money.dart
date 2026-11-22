import 'package:intl/intl.dart';

/// Formats an amount with an explicit ISO currency code from the server. Uses Latin digits in both
/// languages (KINAN's web shop does too) so totals read the same on small screens in RTL and LTR,
/// and wraps the result in a Unicode isolate so the sign/code never jumps around inside Arabic text.
String formatMoney(double amount, String currency, String lang) {
  final code = currency.toUpperCase();
  final locale = lang == 'ar' ? 'ar' : 'en';
  final f = NumberFormat.currency(locale: locale, name: code, symbol: _symbol(code), decimalDigits: _decimals(code));
  // `ar` in intl may use Arabic-Indic digits for some patterns; force Latin digits explicitly.
  final s = _latinDigits(f.format(amount));
  return '⁨$s⁩'; // FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE
}

String _symbol(String code) => switch (code) {
      'USD' => 'US\$',
      'EUR' => '€',
      'GBP' => '£',
      _ => '$code ',
    };

int _decimals(String code) => switch (code) {
      'JPY' || 'KRW' => 0,
      'KWD' || 'BHD' || 'OMR' || 'JOD' || 'TND' || 'LYD' || 'IQD' => 3,
      _ => 2,
    };

String _latinDigits(String s) {
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const easternPersian = '۰۱۲۳۴۵۶۷۸۹';
  final b = StringBuffer();
  for (final ch in s.runes) {
    final c = String.fromCharCode(ch);
    final i = arabicIndic.indexOf(c);
    final j = easternPersian.indexOf(c);
    if (i >= 0) {
      b.write(i);
    } else if (j >= 0) {
      b.write(j);
    } else if (c == '٫') {
      b.write('.');
    } else if (c == '٬') {
      b.write(',');
    } else if (ch == 0x200F || ch == 0x200E || ch == 0x061C) {
      // drop RLM/LRM/ALM marks inserted by the locale pattern; the isolate handles direction
    } else {
      b.write(c);
    }
  }
  return b.toString().trim();
}

/// Rounds to cents for comparisons between what the app showed and what the server charges.
bool sameAmount(double a, double b) => (a * 100).round() == (b * 100).round();
