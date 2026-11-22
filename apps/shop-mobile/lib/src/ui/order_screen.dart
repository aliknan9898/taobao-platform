import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../l10n/strings.dart';
import '../money.dart';
import '../payment/payment.dart';
import '../state/app_state.dart';
import 'widgets.dart';

typedef Estimate = ({double subtotal, double shipping, String currency});

enum _PayState { idle, paying, confirming, cancelled, failed }

/// Order detail: final server total → explicit pay → pending until the server confirms →
/// status, tracking and history. Re-reads the order on open, on app resume and on refresh.
class OrderScreen extends StatefulWidget {
  const OrderScreen({super.key, required this.orderId, this.initial, this.estimate, this.notice});
  final String orderId;
  final Order? initial;
  final Estimate? estimate;
  final String? notice;

  @override
  State<OrderScreen> createState() => _OrderScreenState();
}

class _OrderScreenState extends State<OrderScreen> with WidgetsBindingObserver {
  Order? _o;
  Object? _error;
  _PayState _pay = _PayState.idle;
  String? _failReason;
  Timer? _poll;
  int _polls = 0;

  @override
  void initState() {
    super.initState();
    _o = widget.initial;
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  @override
  void dispose() {
    _poll?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Back from the payment sheet, a bank app or offline: the server is the source of truth.
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    final st = AppScope.read(context);
    try {
      final o = await st.api.order(widget.orderId);
      if (!mounted) return;
      setState(() {
        _o = o;
        _error = null;
        if (_pay == _PayState.confirming && !o.awaitingPayment) _pay = _PayState.idle;
      });
      if (!o.awaitingPayment) {
        _poll?.cancel();
        await st.checkout.finish(o.id); // paid or cancelled: the next basket gets a new key
      }
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  void _startPolling() {
    _poll?.cancel();
    _polls = 0;
    _poll = Timer.periodic(const Duration(seconds: 2), (t) {
      if (++_polls > 45) {
        t.cancel(); // ~90 s; the buyer can refresh, and app resume re-checks
        if (mounted) setState(() {});
        return;
      }
      _refresh();
    });
  }

  Future<PaymentGateway?> _gateway(AppState st, Order o) async {
    if (o.paymentProvider == 'demo') return MockGateway(st.api);
    final key = st.publicConfig?.stripePublishableKey;
    if (key == null) return null;
    return StripeGateway.init(key);
  }

  Future<void> _payNow() async {
    final st = AppScope.read(context);
    // Always pay what the server says right now (it may have been paid meanwhile, or cancelled).
    await _refresh();
    final o = _o;
    if (o == null || !o.awaitingPayment || !mounted) return;
    final g = await _gateway(st, o);
    if (g == null) {
      setState(() {
        _pay = _PayState.failed;
        _failReason = S.of(context).t('payment_not_configured');
      });
      return;
    }
    setState(() => _pay = _PayState.paying);
    final r = await g.pay(o);
    if (!mounted) return;
    switch (r) {
      case PaymentSubmitted():
        setState(() => _pay = _PayState.confirming);
        _startPolling();
        await _refresh();
      case PaymentCancelled():
        setState(() => _pay = _PayState.cancelled);
        await _refresh();
      case PaymentFailed(:final reason):
        setState(() {
          _pay = _PayState.failed;
          _failReason = reason;
        });
        await _refresh();
    }
  }

  Future<void> _cancel() async {
    final st = AppScope.read(context);
    try {
      final o = await st.api.cancelOrder(widget.orderId);
      if (!mounted) return;
      setState(() => _o = o);
      await st.checkout.finish(o.id);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } on NetworkUncertainException {
      await _refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final o = _o;
    return Scaffold(
      appBar: AppBar(
        title: Text(s.t('order', {'ref': shortRef(widget.orderId)})),
        actions: [IconButton(tooltip: s.t('refresh'), onPressed: _refresh, icon: const Icon(Icons.refresh))],
      ),
      body: Column(children: [
        const EnvBanner(),
        if (_pay == _PayState.paying || _pay == _PayState.confirming) const LinearProgressIndicator(),
        Expanded(
          child: o == null
              ? (_error != null ? ErrorRetry(message: s.t('load_error'), onRetry: _refresh) : const Center(child: CircularProgressIndicator()))
              : RefreshIndicator(onRefresh: _refresh, child: _body(context, s, o)),
        ),
      ]),
    );
  }

  Widget _body(BuildContext context, S s, Order o) {
    final st = AppScope.of(context);
    final e = widget.estimate;
    final estimateTotal = e == null ? null : e.subtotal + e.shipping;
    final differs = e != null && o.awaitingPayment && (o.currency != e.currency || !sameAmount(o.total, estimateTotal!));
    final mock = o.paymentProvider == 'demo';
    final amount = formatMoney(o.total, o.currency, st.lang);
    return ListView(padding: const EdgeInsets.all(16), children: [
      if (widget.notice != null) Notice(widget.notice!, kind: NoticeKind.warning),
      if (_error != null) Notice(s.t('load_error'), kind: NoticeKind.error),
      if (o.isPaid) Notice(s.t('confirmed_body', {'ref': shortRef(o.id)}), kind: NoticeKind.success),
      Text('${s.t('status')}: ${s.status(o.status, o.statusLabel)}', key: const Key('order-status'), style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 12),
      for (final l in o.lines)
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: ClipRRect(borderRadius: BorderRadius.circular(6), child: ProductImage(l.image, size: 44)),
          title: Text(l.title, maxLines: 2, overflow: TextOverflow.ellipsis),
          subtitle: Text('${l.props}${l.props.isEmpty ? '' : ' · '}× ${l.qty}'),
          trailing: Money(l.price * l.qty, o.currency),
        ),
      const Divider(),
      AmountRow(s.t('subtotal'), o.subtotal, o.currency),
      AmountRow(s.t('shipping'), o.shippingFee, o.currency),
      AmountRow(s.t('final_total'), o.total, o.currency, bold: true),
      if (o.awaitingPayment) ...[
        const SizedBox(height: 12),
        if (differs) Notice(s.t('total_changed', {'estimate': formatMoney(estimateTotal!, e!.currency, st.lang)}), kind: NoticeKind.warning),
        if (e != null && o.currency != e.currency) Notice(s.t('currency_note', {'currency': o.currency}), kind: NoticeKind.info),
        if (mock) Notice(s.t('mock_badge'), kind: NoticeKind.warning),
        if (_pay == _PayState.confirming) Notice(_poll?.isActive ?? false ? s.t('payment_pending') : s.t('still_pending'), kind: NoticeKind.info),
        if (_pay == _PayState.cancelled) Notice(s.t('payment_cancelled'), kind: NoticeKind.warning),
        if (_pay == _PayState.failed) Notice(s.t('payment_failed', {'reason': _failReason ?? ''}), kind: NoticeKind.error),
        const SizedBox(height: 8),
        FilledButton(
          key: const Key('pay'),
          onPressed: _pay == _PayState.paying || _pay == _PayState.confirming ? null : _payNow,
          child: Text(_pay == _PayState.cancelled || _pay == _PayState.failed
              ? s.t('pay_again')
              : mock
                  ? s.t('pay_mock', {'amount': amount})
                  : s.t('pay', {'amount': amount})),
        ),
        TextButton(key: const Key('cancel-order'), onPressed: _pay == _PayState.paying ? null : _cancel, child: Text(s.t('cancel_order'))),
      ],
      if (o.tracking != null || o.directTracking.isNotEmpty) ...[
        const SizedBox(height: 12),
        Text(s.t('tracking'), style: Theme.of(context).textTheme.titleSmall),
        for (final t in [if (o.tracking != null) o.tracking!, ...o.directTracking])
          ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.local_shipping_outlined), title: Text(t.carrier), subtitle: Text(t.number, textDirection: TextDirection.ltr)),
      ],
      const SizedBox(height: 12),
      Text(s.t('timeline'), style: Theme.of(context).textTheme.titleSmall),
      for (final ev in o.timeline.reversed)
        ListTile(
          dense: true,
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.circle, size: 10),
          title: Text(s.event(ev.event)),
          subtitle: Text(_date(ev.at), textDirection: TextDirection.ltr),
        ),
    ]);
  }

  String _date(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    final l = d.toLocal();
    return '${l.year}-${two(l.month)}-${two(l.day)} ${two(l.hour)}:${two(l.minute)}';
  }
}
