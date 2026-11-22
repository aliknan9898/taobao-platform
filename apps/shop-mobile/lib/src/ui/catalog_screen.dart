import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../state/app_state.dart';
import 'cart_screen.dart';
import 'destination_screen.dart';
import 'orders_screen.dart';
import 'product_screen.dart';
import 'sign_in_screen.dart';
import 'widgets.dart';

class CatalogScreen extends StatefulWidget {
  const CatalogScreen({super.key});
  @override
  State<CatalogScreen> createState() => _CatalogScreenState();
}

class _CatalogScreenState extends State<CatalogScreen> {
  static const _page = 20;
  final _items = <Product>[];
  int _total = 0;
  bool _loading = false;
  Object? _error;
  String _q = '';
  String? _loadedFor;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final c = AppScope.of(context).country;
    if (c != null && c != _loadedFor) {
      _loadedFor = c; // destination changed: prices, delivery and eligibility differ
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _reload();
      });
    }
  }

  Future<void> _reload() async {
    _items.clear();
    _total = 0;
    await _more();
  }

  Future<void> _more() async {
    final st = AppScope.read(context);
    final country = st.country;
    if (_loading || country == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await st.api.catalog(country: country, limit: _page, offset: _items.length, q: _q);
      if (!mounted) return;
      if (country != st.country) return; // a newer destination is loading
      setState(() {
        _items.addAll(page.items);
        _total = page.total;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) {
        setState(() => _loading = false);
        if (st.country != country) await _reload();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final st = AppScope.of(context);
    final s = S.of(context);
    final country = st.country ?? '';
    return Scaffold(
      appBar: AppBar(
        title: Text(s.t('catalog')),
        actions: [
          TextButton.icon(
            key: const Key('change-country'),
            icon: const Icon(Icons.place_outlined),
            label: Text(country),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<bool>(builder: (_) => const DestinationScreen(fromSettings: true))),
          ),
          IconButton(
            tooltip: s.t('orders'),
            icon: const Icon(Icons.receipt_long_outlined),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
                builder: (_) => st.signedIn ? const OrdersScreen() : const SignInScreen(next: OrdersScreen()))),
          ),
          IconButton(
            key: const Key('open-cart'),
            tooltip: s.t('cart'),
            icon: Badge(isLabelVisible: st.cart.count > 0, label: Text('${st.cart.count}'), child: const Icon(Icons.shopping_cart_outlined)),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const CartScreen())),
          ),
        ],
      ),
      body: Column(children: [
        const EnvBanner(),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: TextField(
            decoration: InputDecoration(prefixIcon: const Icon(Icons.search), hintText: s.t('search'), border: const OutlineInputBorder(), isDense: true),
            textInputAction: TextInputAction.search,
            onSubmitted: (v) {
              _q = v.trim();
              _reload();
            },
          ),
        ),
        Expanded(child: _body(s, st)),
      ]),
    );
  }

  Widget _body(S s, AppState st) {
    if (_items.isEmpty && _loading) return const Center(child: CircularProgressIndicator());
    if (_items.isEmpty && _error != null) {
      return ErrorRetry(message: _error is ApiException ? (_error as ApiException).message : s.t('load_error'), onRetry: _reload);
    }
    if (_items.isEmpty) {
      return RefreshIndicator(
        onRefresh: _reload,
        child: ListView(children: [
          const SizedBox(height: 80),
          Center(child: Text(s.t('empty_catalog', {'country': st.countryName(st.country ?? '')}), textAlign: TextAlign.center)),
        ]),
      );
    }
    final hasMore = _items.length < _total;
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView.separated(
        itemCount: _items.length + (hasMore || _error != null ? 1 : 0),
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, i) {
          if (i == _items.length) {
            if (_error != null) return ErrorRetry(message: s.t('load_error'), onRetry: _more);
            if (!_loading) WidgetsBinding.instance.addPostFrameCallback((_) => _more());
            return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
          }
          final p = _items[i];
          return ListTile(
            key: Key('product-${p.id}'),
            leading: ClipRRect(borderRadius: BorderRadius.circular(6), child: ProductImage(p.images.isEmpty ? null : p.images.first, size: 56)),
            title: Text(p.titleFor(st.lang), maxLines: 2, overflow: TextOverflow.ellipsis),
            subtitle: p.shopName == null ? null : Text(s.t('sold_by', {'shop': p.shopName!}), maxLines: 1, overflow: TextOverflow.ellipsis),
            trailing: Money(p.minPrice, p.currency, style: Theme.of(context).textTheme.titleSmall),
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ProductScreen(productId: p.id))),
          );
        },
      ),
    );
  }
}
