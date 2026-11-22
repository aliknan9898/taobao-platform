import 'package:flutter/material.dart';

import '../api/models.dart';
import '../l10n/strings.dart';
import '../state/app_state.dart';
import 'order_screen.dart';
import 'widgets.dart';

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});
  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  List<Order>? _orders;
  Object? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final o = await AppScope.read(context).api.orders();
      if (mounted) {
        setState(() {
          _orders = o;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final st = AppScope.of(context);
    final o = _orders;
    return Scaffold(
      appBar: AppBar(title: Text(s.t('orders')), actions: [
        if (st.signedIn)
          TextButton(
            onPressed: () async {
              await st.signOut();
              if (context.mounted) Navigator.of(context).pop();
            },
            child: Text(s.t('sign_out')),
          ),
      ]),
      body: Column(children: [
        const EnvBanner(),
        Expanded(
          child: o == null
              ? (_error != null ? ErrorRetry(message: s.t('load_error'), onRetry: _load) : const Center(child: CircularProgressIndicator()))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: o.isEmpty
                      ? ListView(children: [const SizedBox(height: 80), Center(child: Text(s.t('no_orders')))])
                      : ListView.separated(
                          itemCount: o.length,
                          separatorBuilder: (_, _) => const Divider(height: 1),
                          itemBuilder: (context, i) => ListTile(
                            key: Key('order-${o[i].id}'),
                            title: Text(s.t('order', {'ref': shortRef(o[i].id)})),
                            subtitle: Text(s.status(o[i].status, o[i].statusLabel)),
                            trailing: Money(o[i].total, o[i].currency),
                            onTap: () async {
                              await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => OrderScreen(orderId: o[i].id, initial: o[i])));
                              await _load();
                            },
                          ),
                        ),
                ),
        ),
      ]),
    );
  }
}
