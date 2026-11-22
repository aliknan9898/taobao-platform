import 'package:flutter/material.dart';

import '../checkout/checkout_attempt.dart';
import '../l10n/strings.dart';
import '../state/app_state.dart';
import 'order_screen.dart';
import 'sign_in_screen.dart';
import 'widgets.dart';

class CheckoutScreen extends StatefulWidget {
  const CheckoutScreen({super.key, required this.estimateShipping, required this.estimateCurrency});

  /// What the cart screen showed, to compare with the server's final total.
  final double estimateShipping;
  final String estimateCurrency;

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final _form = GlobalKey<FormState>();
  final _c = {for (final k in const ['name', 'phone', 'city', 'line1', 'line2', 'postal_code']) k: TextEditingController()};
  bool _busy = false;
  CheckoutOutcome? _last;
  String? _notice;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _recover());
  }

  @override
  void dispose() {
    for (final c in _c.values) {
      c.dispose();
    }
    super.dispose();
  }

  /// An uncertain attempt from before a crash / restart is resolved before anything else.
  Future<void> _recover() async {
    final st = AppScope.read(context);
    final pending = await st.checkout.pending();
    if (pending == null || !pending.uncertain) return;
    setState(() => _busy = true);
    final r = await st.checkout.recover();
    if (!mounted) return;
    setState(() => _busy = false);
    if (r != null) await _handle(r);
  }

  Future<void> _place() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final st = AppScope.read(context);
    final body = checkoutBody(
      items: [for (final l in st.cart.payable) l.apiItem()],
      address: {for (final e in _c.entries) e.key: e.value.text, 'country_code': st.country!},
    );
    setState(() {
      _busy = true;
      _notice = null;
    });
    final r = await st.checkout.submit(body);
    if (!mounted) return;
    setState(() => _busy = false);
    await _handle(r);
  }

  Future<void> _handle(CheckoutOutcome r) async {
    final st = AppScope.read(context);
    final s = S.of(context);
    setState(() => _last = r);
    switch (r) {
      case CheckoutPlaced(:final order, :final recoveredPrevious):
        final estimate = recoveredPrevious ? null : (subtotal: st.cart.subtotal, shipping: widget.estimateShipping, currency: widget.estimateCurrency);
        if (!recoveredPrevious) {
          st.cart.clear();
          await st.saveCart();
        }
        if (!mounted) return;
        await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
          builder: (_) => OrderScreen(
            orderId: order.id,
            initial: order,
            estimate: estimate,
            notice: recoveredPrevious ? s.t('recovered_previous') : null,
          ),
        ));
      case CheckoutUncertain():
        break; // the uncertain card below offers a retry with the same key and bytes
      case CheckoutRejected(:final error):
        if (error.isUnauthorized) {
          if (!mounted) return;
          await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
              builder: (_) => SignInScreen(next: CheckoutScreen(estimateShipping: widget.estimateShipping, estimateCurrency: widget.estimateCurrency))));
          return;
        }
        setState(() => _notice = error.status == 503 ? s.t('payments_paused') : error.message);
    }
  }

  String? _required(String? v) => (v ?? '').trim().isEmpty ? S.of(context).t('required') : null;

  @override
  Widget build(BuildContext context) {
    final st = AppScope.of(context);
    final s = S.of(context);
    final country = st.country ?? '';
    final uncertain = _last is CheckoutUncertain;
    return Scaffold(
      appBar: AppBar(title: Text(s.t('checkout'))),
      body: Column(children: [
        const EnvBanner(),
        if (_busy) const LinearProgressIndicator(),
        Expanded(
          child: Form(
            key: _form,
            child: ListView(padding: const EdgeInsets.all(16), children: [
              if (uncertain)
                Notice('${s.t('uncertain_title')}\n${s.t('uncertain_body')}',
                    kind: NoticeKind.warning,
                    action: TextButton(key: const Key('retry-checkout'), onPressed: _busy ? null : _retryUncertain, child: Text(s.t('retry')))),
              if (_notice != null) Notice(_notice!, kind: NoticeKind.error),
              Text(s.t('address'), style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              InputDecorator(decoration: InputDecoration(labelText: s.t('country'), border: const OutlineInputBorder()), child: Text('${st.countryName(country)} ($country)')),
              const SizedBox(height: 10),
              _field('name', s.t('full_name'), validator: _required, hints: const [AutofillHints.name]),
              _field('phone', s.t('phone'),
                  keyboard: TextInputType.phone,
                  ltr: true,
                  hints: const [AutofillHints.telephoneNumber],
                  validator: (v) => RegExp(r'^\+?[0-9 ()-]{6,20}$').hasMatch((v ?? '').trim()) ? null : s.t('invalid_phone')),
              _field('city', s.t('city'), validator: _required, hints: const [AutofillHints.addressCity]),
              _field('line1', s.t('line1'), validator: _required, hints: const [AutofillHints.streetAddressLine1]),
              _field('line2', s.t('line2')),
              _field('postal_code', s.t('postal_code'), ltr: true, hints: const [AutofillHints.postalCode]),
              const SizedBox(height: 8),
              Text(s.t('quote_note', {'country': st.countryName(country)}), style: Theme.of(context).textTheme.bodySmall),
            ]),
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: SizedBox(
              width: double.infinity,
              child: FilledButton(
                key: const Key('place-order'),
                onPressed: _busy || uncertain || st.cart.payable.isEmpty ? null : _place,
                child: Text(_busy ? s.t('placing') : s.t('place_order')),
              ),
            ),
          ),
        ),
      ]),
    );
  }

  /// Same key, same bytes: resubmits the saved attempt exactly (never builds a new body).
  Future<void> _retryUncertain() async {
    final st = AppScope.read(context);
    setState(() => _busy = true);
    var r = await st.checkout.recover();
    if (r == null) {
      final saved = await st.checkout.pending(); // already resolved meanwhile: read that order back
      if (saved != null) r = await st.checkout.submit(saved.body);
    }
    if (!mounted) return;
    if (r == null) {
      setState(() {
        _busy = false;
        _last = null;
      });
      return;
    }
    setState(() => _busy = false);
    await _handle(r);
  }

  Widget _field(String k, String label, {String? Function(String?)? validator, TextInputType? keyboard, bool ltr = false, List<String>? hints}) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: TextFormField(
          key: Key('addr-$k'),
          controller: _c[k],
          validator: validator,
          keyboardType: keyboard,
          autofillHints: hints,
          textDirection: ltr ? TextDirection.ltr : null,
          decoration: InputDecoration(labelText: label, border: const OutlineInputBorder()),
        ),
      );
}
