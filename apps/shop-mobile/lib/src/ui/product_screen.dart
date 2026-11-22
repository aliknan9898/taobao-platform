import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../state/app_state.dart';
import 'widgets.dart';

class ProductScreen extends StatefulWidget {
  const ProductScreen({super.key, required this.productId});
  final String productId;
  @override
  State<ProductScreen> createState() => _ProductScreenState();
}

class _ProductScreenState extends State<ProductScreen> {
  Product? _p;
  Object? _error;
  String? _skuId;
  int _qty = 1;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final p = await AppScope.read(context).api.product(widget.productId);
      if (!mounted) return;
      setState(() {
        _p = p;
        // preselect the first in-stock option
        _skuId ??= p.skus.where((x) => x.inStock).map((x) => x.id).firstOrNull;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = AppScope.of(context);
    final s = S.of(context);
    final p = _p;
    return Scaffold(
      appBar: AppBar(title: Text(p?.titleFor(st.lang) ?? '')),
      body: Column(children: [
        const EnvBanner(),
        Expanded(
          child: p == null
              ? (_error != null
                  ? ErrorRetry(message: _error is ApiException ? (_error as ApiException).message : s.t('load_error'), onRetry: _load)
                  : const Center(child: CircularProgressIndicator()))
              : _detail(context, st, s, p),
        ),
      ]),
    );
  }

  Widget _detail(BuildContext context, AppState st, S s, Product p) {
    final sku = _skuId == null ? null : p.sku(_skuId!);
    final country = st.country ?? '';
    final deliverable = p.deliverableTo(country);
    final canAdd = sku != null && sku.inStock && deliverable;
    return ListView(padding: const EdgeInsets.all(16), children: [
      if (p.images.isNotEmpty)
        SizedBox(
          height: 260,
          child: PageView(children: [for (final i in p.images) ProductImage(i)]),
        ),
      const SizedBox(height: 12),
      Text(p.titleFor(st.lang), style: Theme.of(context).textTheme.titleLarge),
      if (p.shopName != null) Text(s.t('sold_by', {'shop': p.shopName!})),
      const SizedBox(height: 8),
      Money(sku?.price ?? p.minPrice, p.currency, style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 16),
      if (!deliverable) Notice(s.t('not_deliverable', {'country': st.countryName(country)}), kind: NoticeKind.warning),
      Text(s.t('choose_option'), style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: 6),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final x in p.skus)
          ChoiceChip(
            key: Key('sku-${x.id}'),
            label: Text(x.inStock ? x.props : '${x.props} · ${s.t('out_of_stock')}'),
            selected: x.id == _skuId,
            onSelected: x.inStock ? (_) => setState(() => _skuId = x.id) : null,
          ),
      ]),
      const SizedBox(height: 8),
      if (sku != null)
        Text(!sku.inStock ? s.t('out_of_stock') : sku.stock != null ? s.t('in_stock_n', {'n': '${sku.stock}'}) : s.t('in_stock')),
      const SizedBox(height: 12),
      Row(children: [
        Text(s.t('qty')),
        IconButton(onPressed: _qty > 1 ? () => setState(() => _qty--) : null, icon: const Icon(Icons.remove_circle_outline)),
        Text('$_qty', style: Theme.of(context).textTheme.titleMedium),
        IconButton(
          onPressed: sku != null && (sku.stock == null || _qty < sku.stock!) ? () => setState(() => _qty++) : null,
          icon: const Icon(Icons.add_circle_outline),
        ),
      ]),
      const SizedBox(height: 12),
      FilledButton.icon(
        key: const Key('add-to-cart'),
        onPressed: canAdd
            ? () async {
                st.cart.add(p, sku, _qty);
                await st.saveCart();
                if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s.t('added'))));
              }
            : null,
        icon: const Icon(Icons.add_shopping_cart),
        label: Text(s.t('add_to_cart')),
      ),
      const SizedBox(height: 16),
      if (p.descriptionFor(st.lang).isNotEmpty) Text(p.descriptionFor(st.lang)),
    ]);
  }
}
