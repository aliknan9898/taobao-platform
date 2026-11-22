import 'package:flutter/material.dart';

import '../l10n/strings.dart';
import '../money.dart';
import '../state/app_state.dart';

/// Always-visible strip: this is a pilot on a test environment, and whether payments are mocked.
class EnvBanner extends StatelessWidget {
  const EnvBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final st = AppScope.of(context);
    final mock = st.publicConfig?.isMockPayments ?? true;
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: mock ? scheme.errorContainer : scheme.tertiaryContainer,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: Text(
            '${s.t('pilot_badge')} · ${st.config.appEnv.toUpperCase()} · ${mock ? s.t('mock_badge') : s.t('stripe_test_badge')}',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.labelSmall,
            maxLines: 2,
          ),
        ),
      ),
    );
  }
}

class Money extends StatelessWidget {
  const Money(this.amount, this.currency, {super.key, this.style, this.strike = false});
  final double amount;
  final String currency;
  final TextStyle? style;
  final bool strike;

  @override
  Widget build(BuildContext context) {
    final lang = AppScope.of(context).lang;
    final base = style ?? DefaultTextStyle.of(context).style;
    return Text(formatMoney(amount, currency, lang),
        style: strike ? base.copyWith(decoration: TextDecoration.lineThrough) : base, maxLines: 1, softWrap: false);
  }
}

class ErrorRetry extends StatelessWidget {
  const ErrorRetry({super.key, required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.wifi_off, size: 40),
          const SizedBox(height: 12),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 12),
          FilledButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: Text(s.t('retry'))),
        ]),
      ),
    );
  }
}

class Notice extends StatelessWidget {
  const Notice(this.text, {super.key, this.kind = NoticeKind.info, this.action});
  final String text;
  final NoticeKind kind;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    final (bg, icon) = switch (kind) {
      NoticeKind.info => (c.secondaryContainer, Icons.info_outline),
      NoticeKind.warning => (c.tertiaryContainer, Icons.warning_amber),
      NoticeKind.error => (c.errorContainer, Icons.error_outline),
      NoticeKind.success => (c.primaryContainer, Icons.check_circle_outline),
    };
    return Card(
      color: bg,
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon),
          const SizedBox(width: 10),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(text), if (action != null) action!])),
        ]),
      ),
    );
  }
}

enum NoticeKind { info, warning, error, success }

class ProductImage extends StatelessWidget {
  const ProductImage(this.path, {super.key, this.size});
  final String? path;
  final double? size;

  @override
  Widget build(BuildContext context) {
    final st = AppScope.of(context);
    final p = path;
    final placeholder = Container(
      width: size, height: size, color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: const Icon(Icons.image_outlined),
    );
    if (p == null || p.isEmpty || p.startsWith('data:')) return placeholder;
    return Image.network(st.config.resolve(p).toString(), width: size, height: size, fit: BoxFit.cover,
        errorBuilder: (_, _, _) => placeholder);
  }
}

/// A row of label + amount that keeps numbers readable in RTL.
class AmountRow extends StatelessWidget {
  const AmountRow(this.label, this.amount, this.currency, {super.key, this.bold = false});
  final String label;
  final double amount;
  final String currency;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final style = bold ? Theme.of(context).textTheme.titleMedium : Theme.of(context).textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [
        Expanded(child: Text(label, style: style)),
        Money(amount, currency, style: style),
      ]),
    );
  }
}

String shortRef(String orderId) => orderId.length > 8 ? orderId.substring(orderId.length - 8).toUpperCase() : orderId.toUpperCase();
