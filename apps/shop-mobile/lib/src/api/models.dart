// Dart models for the KINAN Shop API responses used by the pilot. Shapes were verified against
// src/server.js and src/services/{catalog,orders}.js at commit 4653259 (see README "API contract").
// Every parser validates required fields and throws [FormatException] on an unexpected shape,
// so a contract change fails loudly instead of showing wrong prices.

T _req<T>(Map<String, dynamic> j, String key, String where) {
  final v = j[key];
  if (v is T) return v;
  throw FormatException('$where: "$key" missing or not ${T.toString()} (got ${v.runtimeType})');
}

T? _opt<T>(Map<String, dynamic> j, String key) {
  final v = j[key];
  return v is T ? v : null;
}

double _num(Map<String, dynamic> j, String key, String where) {
  final v = j[key];
  if (v is num && v.isFinite) return v.toDouble();
  throw FormatException('$where: "$key" missing or not a number');
}

double? _optNum(Map<String, dynamic> j, String key) {
  final v = j[key];
  return v is num && v.isFinite ? v.toDouble() : null;
}

Map<String, dynamic> asObject(Object? v, String where) {
  if (v is Map<String, dynamic>) return v;
  throw FormatException('$where: expected a JSON object');
}

List<Map<String, dynamic>> _objects(Object? v, String where) {
  if (v is! List) throw FormatException('$where: expected a list');
  return [for (final x in v) asObject(x, where)];
}

/// ISO 4217 code in upper case. The API sends lower case (`"usd"`).
String currencyCode(Object? v, String where) {
  if (v is String && RegExp(r'^[A-Za-z]{3}$').hasMatch(v)) return v.toUpperCase();
  throw FormatException('$where: invalid currency "$v"');
}

class Country {
  const Country(this.code, this.name);
  final String code;
  final String name;
}

class PublicConfig {
  PublicConfig({
    required this.baseCurrency,
    required this.paymentsMode,
    required this.stripePublishableKey,
    required this.paymentsPaused,
    required this.countries,
    required this.currencyByCountry,
  });

  final String baseCurrency;

  /// `stripe` or `demo` (demo = server-side mock payment, shown as MOCK in the app).
  final String paymentsMode;
  final String? stripePublishableKey;
  final bool paymentsPaused;
  final List<Country> countries;
  final Map<String, String> currencyByCountry;

  bool get isMockPayments => paymentsMode != 'stripe';

  factory PublicConfig.fromJson(Map<String, dynamic> j) {
    const w = 'config/public';
    final countries = <Country>[];
    final raw = j['countries'];
    if (raw is! List) throw const FormatException('$w: countries missing');
    for (final c in raw) {
      if (c is List && c.length >= 2 && c[0] is String && c[1] is String) {
        countries.add(Country(c[0] as String, c[1] as String));
      }
    }
    final cbc = <String, String>{};
    final m = j['currency_by_country'];
    if (m is Map<String, dynamic>) {
      m.forEach((k, v) {
        if (v is String) cbc[k] = v.toUpperCase();
      });
    }
    final key = _opt<String>(j, 'stripe_publishable_key');
    return PublicConfig(
      baseCurrency: currencyCode(j['currency'], w),
      paymentsMode: _req<String>(j, 'payments', w),
      // Only test-mode keys are accepted by the pilot build.
      stripePublishableKey: key != null && key.startsWith('pk_test_') ? key : null,
      paymentsPaused: j['payments_paused'] == true,
      countries: countries,
      currencyByCountry: cbc,
    );
  }
}

class Sku {
  Sku({required this.id, required this.props, required this.price, required this.inStock, this.stock});
  final String id; // public variant id (v_…)
  final String props;
  final double price;
  final bool inStock;
  final int? stock;

  factory Sku.fromJson(Map<String, dynamic> j) {
    const w = 'sku';
    return Sku(
      id: _req<String>(j, 'mp_sku_id', w),
      props: _opt<String>(j, 'props') ?? '',
      price: _num(j, 'price', w),
      inStock: j['in_stock'] == true,
      stock: _opt<num>(j, 'stock')?.toInt(),
    );
  }
}

class Product {
  Product({
    required this.id,
    required this.title,
    required this.titleAr,
    required this.description,
    required this.descriptionAr,
    required this.currency,
    required this.images,
    required this.skus,
    required this.minPrice,
    required this.shopName,
    required this.shopId,
    required this.noDelivery,
  });

  final String id;
  final String title;
  final String titleAr;
  final String description;
  final String descriptionAr;
  final String currency;
  final List<String> images;
  final List<Sku> skus;
  final double minPrice;
  final String? shopName;
  final String? shopId;

  /// Countries the supplier cannot deliver this product to (checkout refuses them).
  final List<String> noDelivery;

  String titleFor(String lang) => lang == 'ar' && titleAr.isNotEmpty ? titleAr : title;
  String descriptionFor(String lang) => lang == 'ar' && descriptionAr.isNotEmpty ? descriptionAr : description;
  bool deliverableTo(String country) => !noDelivery.contains(country);
  Sku? sku(String id) {
    for (final s in skus) {
      if (s.id == id) return s;
    }
    return null;
  }

  factory Product.fromJson(Map<String, dynamic> j) {
    const w = 'product';
    final shop = j['shop'] is Map<String, dynamic> ? j['shop'] as Map<String, dynamic> : null;
    final skus = _objects(j['skus'], '$w.skus').map(Sku.fromJson).toList();
    return Product(
      id: _req<String>(j, 'id', w),
      title: _req<String>(j, 'title', w),
      titleAr: _opt<String>(j, 'title_ar') ?? '',
      description: _opt<String>(j, 'description') ?? '',
      descriptionAr: _opt<String>(j, 'description_ar') ?? '',
      currency: currencyCode(j['currency'], w),
      images: [for (final x in (j['images'] is List ? j['images'] as List : const <Object?>[])) if (x is String) x],
      skus: skus,
      minPrice: _optNum(j, 'min_price') ?? (skus.isEmpty ? 0 : skus.map((s) => s.price).reduce((a, b) => a < b ? a : b)),
      shopName: shop == null ? null : _opt<String>(shop, 'name'),
      shopId: shop == null ? null : _opt<String>(shop, 'id'),
      noDelivery: [for (final x in (j['no_delivery'] is List ? j['no_delivery'] as List : const <Object?>[])) if (x is String) x],
    );
  }
}

class CatalogPage {
  CatalogPage(this.items, this.total);
  final List<Product> items;
  final int total;

  factory CatalogPage.fromJson(Map<String, dynamic> j) => CatalogPage(
        _objects(j['items'], 'catalog.items').map(Product.fromJson).toList(),
        _req<num>(j, 'total', 'catalog').toInt(),
      );
}

class ShippingQuote {
  ShippingQuote({required this.fee, required this.days, required this.countryCode, required this.undeliverable, this.importFee});
  final double fee; // in PublicConfig.baseCurrency (the quote has no currency field)
  final String? days;
  final String? countryCode;
  final List<String> undeliverable; // listing ids
  final double? importFee;

  factory ShippingQuote.fromJson(Map<String, dynamic> j) {
    const w = 'shipping/quote';
    return ShippingQuote(
      fee: _num(j, 'fee', w),
      days: _opt<String>(j, 'days'),
      countryCode: _opt<String>(j, 'country_code'),
      undeliverable: [for (final x in (j['undeliverable'] is List ? j['undeliverable'] as List : const <Object?>[])) if (x is String) x],
      importFee: _optNum(j, 'import_fee'),
    );
  }
}

class User {
  User({required this.id, required this.email, required this.name, required this.role});
  final String id;
  final String? email;
  final String name;
  final String role;

  factory User.fromJson(Map<String, dynamic> j) => User(
        id: _req<String>(j, 'id', 'user'),
        email: _opt<String>(j, 'email'),
        name: _opt<String>(j, 'name') ?? '',
        role: _req<String>(j, 'role', 'user'),
      );
}

class OrderLine {
  OrderLine({required this.title, required this.props, required this.qty, required this.price, this.image, this.listingId});
  final String title;
  final String props;
  final int qty;
  final double price;
  final String? image;
  final String? listingId;

  factory OrderLine.fromJson(Map<String, dynamic> j) => OrderLine(
        title: _req<String>(j, 'title', 'order.line'),
        props: _opt<String>(j, 'props') ?? '',
        qty: _req<num>(j, 'qty', 'order.line').toInt(),
        price: _num(j, 'price', 'order.line'),
        image: _opt<String>(j, 'image'),
        listingId: _opt<String>(j, 'listing_id'),
      );
}

class Tracking {
  Tracking({required this.carrier, required this.number, this.url});
  final String carrier;
  final String number;
  final String? url;
}

class TimelineEvent {
  TimelineEvent(this.at, this.event);
  final DateTime at;
  final String event;
}

class Order {
  Order({
    required this.id,
    required this.status,
    required this.statusLabel,
    required this.currency,
    required this.subtotal,
    required this.shippingFee,
    required this.total,
    required this.lines,
    required this.paymentProvider,
    required this.clientSecret,
    required this.tracking,
    required this.directTracking,
    required this.timeline,
    required this.createdAt,
  });

  final String id;
  final String status;
  final String statusLabel;
  final String currency;
  final double subtotal;
  final double shippingFee;
  final double total;
  final List<OrderLine> lines;
  final String? paymentProvider; // stripe | demo
  final String? clientSecret; // only while pending_payment
  final Tracking? tracking;
  final List<Tracking> directTracking;
  final List<TimelineEvent> timeline;
  final DateTime createdAt;

  bool get awaitingPayment => status == 'pending_payment';
  bool get isClosed => status == 'cancelled' || status == 'refunded';
  bool get isPaid => !awaitingPayment && !isClosed;

  factory Order.fromJson(Map<String, dynamic> j) {
    const w = 'order';
    final pay = j['payment'] is Map<String, dynamic> ? j['payment'] as Map<String, dynamic> : const <String, dynamic>{};
    final t = j['tracking'] is Map<String, dynamic> ? j['tracking'] as Map<String, dynamic> : null;
    final direct = <Tracking>[];
    if (j['direct'] is List) {
      for (final d in (j['direct'] as List).whereType<Map<String, dynamic>>()) {
        for (final x in (d['tracking'] is List ? d['tracking'] as List : const <Object?>[]).whereType<Map<String, dynamic>>()) {
          final number = _opt<String>(x, 'number');
          if (number != null) direct.add(Tracking(carrier: _opt<String>(x, 'carrier') ?? '', number: number, url: _opt<String>(x, 'url')));
        }
      }
    }
    return Order(
      id: _req<String>(j, 'id', w),
      status: _req<String>(j, 'status', w),
      statusLabel: _opt<String>(j, 'status_label') ?? '',
      currency: currencyCode(j['currency'], w),
      subtotal: _num(j, 'subtotal', w),
      shippingFee: _optNum(j, 'shipping_fee') ?? 0,
      total: _num(j, 'total', w),
      lines: _objects(j['lines'], '$w.lines').map(OrderLine.fromJson).toList(),
      paymentProvider: _opt<String>(pay, 'provider'),
      clientSecret: _opt<String>(pay, 'client_secret'),
      tracking: t == null || _opt<String>(t, 'number') == null
          ? null
          : Tracking(carrier: _opt<String>(t, 'carrier') ?? '', number: _opt<String>(t, 'number')!, url: _opt<String>(t, 'url')),
      directTracking: direct,
      timeline: [
        for (final e in (j['timeline'] is List ? j['timeline'] as List : const <Object?>[]).whereType<Map<String, dynamic>>())
          if (e['at'] is num && e['event'] is String) TimelineEvent(DateTime.fromMillisecondsSinceEpoch((e['at'] as num).toInt()), e['event'] as String),
      ],
      createdAt: DateTime.fromMillisecondsSinceEpoch(_req<num>(j, 'created_at', w).toInt()),
    );
  }
}
