import 'dart:convert';

import '../api/models.dart';

/// One cart line. `unitPrice`/`currency` are what the buyer last saw; the server price is
/// re-read before checkout and the line is flagged when it changed.
class CartLine {
  CartLine({
    required this.listingId,
    required this.skuId,
    required this.qty,
    required this.title,
    required this.titleAr,
    required this.props,
    required this.unitPrice,
    required this.currency,
    this.image,
    this.previousPrice,
    this.unavailable = false,
    this.undeliverable = false,
    this.maxQty,
  });

  final String listingId;
  final String skuId;
  int qty;
  String title;
  String titleAr;
  String props;
  double unitPrice;
  String currency;
  String? image;

  /// Set when revalidation found a different price; cleared once the buyer has seen it.
  double? previousPrice;
  bool unavailable;
  bool undeliverable;
  int? maxQty;

  bool get blocked => unavailable || undeliverable;
  String titleFor(String lang) => lang == 'ar' && titleAr.isNotEmpty ? titleAr : title;

  Map<String, Object> apiItem() => {'listing_id': listingId, 'mp_sku_id': skuId, 'qty': qty};

  Map<String, Object?> toJson() => {
        'listing_id': listingId, 'sku_id': skuId, 'qty': qty, 'title': title, 'title_ar': titleAr,
        'props': props, 'unit_price': unitPrice, 'currency': currency, 'image': image,
      };

  static CartLine? fromJson(Map<String, dynamic> j) {
    try {
      return CartLine(
        listingId: j['listing_id'] as String,
        skuId: j['sku_id'] as String,
        qty: (j['qty'] as num).toInt(),
        title: j['title'] as String,
        titleAr: (j['title_ar'] as String?) ?? '',
        props: (j['props'] as String?) ?? '',
        unitPrice: (j['unit_price'] as num).toDouble(),
        currency: j['currency'] as String,
        image: j['image'] as String?,
      );
    } catch (_) {
      return null;
    }
  }
}

class Cart {
  final List<CartLine> lines = [];

  bool get isEmpty => lines.isEmpty;
  int get count => lines.fold(0, (a, l) => a + l.qty);
  List<CartLine> get payable => lines.where((l) => !l.blocked).toList();
  double get subtotal => payable.fold(0.0, (a, l) => a + l.unitPrice * l.qty);
  String? get currency => lines.isEmpty ? null : lines.first.currency;
  bool get hasChanges => lines.any((l) => l.previousPrice != null || l.blocked);

  void add(Product p, Sku s, int qty) {
    for (final l in lines) {
      if (l.listingId == p.id && l.skuId == s.id) {
        l.qty += qty;
        return;
      }
    }
    lines.add(CartLine(
      listingId: p.id, skuId: s.id, qty: qty, title: p.title, titleAr: p.titleAr, props: s.props,
      unitPrice: s.price, currency: p.currency, image: p.images.isEmpty ? null : p.images.first,
    ));
  }

  void setQty(CartLine l, int qty) {
    if (qty <= 0) {
      lines.remove(l);
    } else {
      l.qty = l.maxQty != null && qty > l.maxQty! ? l.maxQty! : qty;
    }
  }

  void remove(CartLine l) => lines.remove(l);
  void clear() => lines.clear();
  void acknowledgeChanges() {
    for (final l in lines) {
      l.previousPrice = null;
    }
  }

  /// Applies fresh server data (GET /api/catalog/many + shipping quote). Returns true when
  /// anything the buyer would pay changed.
  bool revalidate(List<Product> fresh, {required String country, List<String> undeliverable = const []}) {
    final byId = {for (final p in fresh) p.id: p};
    var changed = false;
    for (final l in lines) {
      final p = byId[l.listingId];
      final s = p?.sku(l.skuId);
      final wasBlocked = l.blocked;
      l.unavailable = p == null || s == null || !s.inStock || (s.stock != null && s.stock! < 1);
      l.undeliverable = p != null && (!p.deliverableTo(country) || undeliverable.contains(l.listingId));
      if (p != null && s != null) {
        if ((s.price * 100).round() != (l.unitPrice * 100).round() || p.currency != l.currency) {
          l.previousPrice = l.unitPrice;
          l.unitPrice = s.price;
          l.currency = p.currency;
          changed = true;
        }
        l.title = p.title;
        l.titleAr = p.titleAr;
        l.maxQty = s.stock;
        if (s.stock != null && s.stock! > 0 && l.qty > s.stock!) {
          l.qty = s.stock!;
          changed = true;
        }
      }
      if (l.blocked != wasBlocked) changed = true;
    }
    return changed;
  }

  String encode() => jsonEncode([for (final l in lines) l.toJson()]);

  void load(String? raw) {
    lines.clear();
    if (raw == null) return;
    try {
      for (final j in (jsonDecode(raw) as List).whereType<Map<String, dynamic>>()) {
        final l = CartLine.fromJson(j);
        if (l != null) lines.add(l);
      }
    } catch (_) {/* corrupt cart: start empty */}
  }
}
