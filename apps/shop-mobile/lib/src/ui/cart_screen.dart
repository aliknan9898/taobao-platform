import 'package:flutter/material.dart';

import '../api/models.dart';
import '../l10n/strings.dart';
import '../money.dart';
import '../state/app_state.dart';
import 'checkout_screen.dart';
import 'sign_in_screen.dart';
import 'widgets.dart';

class CartScreen extends StatefulWidget {
  const CartScreen({super.key});
  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  bool _checking = false;
  bool _changed = false;
  Object? _error;
  ShippingQuote? _quote;
  String? _checkedFor;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final c = AppScope.of(context).country;
    if (c != null && c != _checkedFor) {
      _checkedFor = c;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _revalidate();
      });
    }
  }

  /// Re-reads price, stock and eligibility for the current destination (also after it changes).
  Future<void> _revalidate() async {
    final st = AppScope.read(context);
    final country = st.country;
    if (country == null || st.cart.isEmpty) return;
    setState(() {
      _checking = true;
      _error = null;
    });
    try {
      final fresh = await st.api.products(st.cart.lines.map((l) => l.listingId).toSet().toList());
      ShippingQuote? q;
      var changed = st.cart.revalidate(fresh, country: country);
      if (st.cart.payable.isNotEmpty) {
        q = await st.api.shippingQuote(country, [for (final l in st.cart.payable) l.apiItem()]);
        if (q.undeliverable.isNotEmpty) changed = st.cart.revalidate(fresh, country: country, undeliverable: q.undeliverable) || changed;
      }
      await st.saveCart();
      if (!mounted) return;
      setState(() {
        _quote = q;
        _changed = changed || st.cart.hasChanges;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = AppScope.of(context);
    final s = S.of(context);
    final cart = st.cart;
    final base = st.publicConfig?.baseCurrency ?? cart.currency ?? 'USD';
    final blocked = cart.lines.any((l) => l.blocked);
    return Scaffold(
      appBar: AppBar(title: Text(s.t('cart'))),
      body: Column(children: [
        const EnvBanner(),
        if (_checking) const LinearProgressIndicator(),
        Expanded(
          child: cart.isEmpty
              ? Center(child: Text(s.t('cart_empty')))
              : ListView(padding: const EdgeInsets.all(12), children: [
                  if (_changed) Notice(s.t('cart_updated'), kind: NoticeKind.warning),
                  if (_error != null) Notice(s.t('load_error'), kind: NoticeKind.error, action: TextButton(onPressed: _revalidate, child: Text(s.t('retry')))),
                  for (final l in cart.lines)
                    Card(
                      key: Key('line-${l.listingId}-${l.skuId}'),
                      child: Padding(
                        padding: const EdgeInsets.all(10),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            ClipRRect(borderRadius: BorderRadius.circular(6), child: ProductImage(l.image, size: 56)),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Text(l.titleFor(st.lang), maxLines: 2, overflow: TextOverflow.ellipsis),
                                if (l.props.isNotEmpty) Text(l.props, style: Theme.of(context).textTheme.bodySmall),
                                Row(children: [
                                  if (l.previousPrice != null) ...[Money(l.previousPrice!, l.currency, strike: true), const SizedBox(width: 6)],
                                  Money(l.unitPrice, l.currency, style: Theme.of(context).textTheme.titleSmall),
                                ]),
                              ]),
                            ),
                          ]),
                          if (l.previousPrice != null)
                            Notice(s.t('price_changed', {'old': formatMoney(l.previousPrice!, l.currency, st.lang), 'new': formatMoney(l.unitPrice, l.currency, st.lang)}), kind: NoticeKind.warning),
                          if (l.unavailable) Notice(s.t('now_unavailable'), kind: NoticeKind.error),
                          if (l.undeliverable) Notice(s.t('not_deliverable', {'country': st.countryName(st.country ?? '')}), kind: NoticeKind.error),
                          Row(children: [
                            IconButton(
                              onPressed: () async {
                                cart.setQty(l, l.qty - 1);
                                await st.saveCart();
                                await _revalidate();
                              },
                              icon: const Icon(Icons.remove_circle_outline),
                            ),
                            Text('${l.qty}'),
                            IconButton(
                              onPressed: l.blocked || (l.maxQty != null && l.qty >= l.maxQty!)
                                  ? null
                                  : () async {
                                      cart.setQty(l, l.qty + 1);
                                      await st.saveCart();
                                      await _revalidate();
                                    },
                              icon: const Icon(Icons.add_circle_outline),
                            ),
                            const Spacer(),
                            TextButton.icon(
                              onPressed: () async {
                                cart.remove(l);
                                await st.saveCart();
                                await _revalidate();
                              },
                              icon: const Icon(Icons.delete_outline),
                              label: Text(s.t('remove')),
                            ),
                          ]),
                        ]),
                      ),
                    ),
                  const SizedBox(height: 8),
                  if (cart.currency != null) AmountRow(s.t('subtotal'), cart.subtotal, cart.currency!),
                  if (_quote != null) ...[
                    AmountRow(s.t('shipping'), _quote!.fee, base),
                    if (_quote!.days != null) Text(s.t('delivery_days', {'days': _quote!.days!})),
                    if (cart.currency == base) AmountRow(s.t('estimate_total'), cart.subtotal + _quote!.fee, base, bold: true),
                  ],
                ]),
        ),
        if (!cart.isEmpty)
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  key: const Key('go-checkout'),
                  onPressed: _checking || blocked || cart.payable.isEmpty || _quote == null
                      ? null
                      : () {
                          cart.acknowledgeChanges();
                          final next = CheckoutScreen(estimateShipping: _quote!.fee, estimateCurrency: base);
                          Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => st.signedIn ? next : SignInScreen(next: next)));
                        },
                  child: Text(s.t('checkout')),
                ),
              ),
            ),
          ),
      ]),
    );
  }
}
