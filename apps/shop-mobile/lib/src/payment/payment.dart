import 'package:flutter/material.dart' show ThemeMode;
import 'package:flutter_stripe/flutter_stripe.dart';

import '../api/api_client.dart';
import '../api/models.dart';

sealed class PaymentResult {
  const PaymentResult();
}

/// The payment UI finished. This is NOT proof of payment: the app must wait for the server
/// (Stripe webhook → order status) before showing the order as confirmed.
class PaymentSubmitted extends PaymentResult {
  const PaymentSubmitted();
}

class PaymentCancelled extends PaymentResult {
  const PaymentCancelled();
}

class PaymentFailed extends PaymentResult {
  const PaymentFailed(this.reason);
  final String reason;
}

abstract class PaymentGateway {
  bool get isMock;
  Future<PaymentResult> pay(Order order);
}

/// Stripe PaymentSheet with the server-provided client secret (test-mode publishable key only).
class StripeGateway implements PaymentGateway {
  StripeGateway._();
  static StripeGateway? _instance;

  static Future<StripeGateway> init(String publishableKey) async {
    if (!publishableKey.startsWith('pk_test_')) {
      throw StateError('The pilot only accepts Stripe test-mode keys');
    }
    if (_instance == null) {
      Stripe.publishableKey = publishableKey;
      await Stripe.instance.applySettings();
      _instance = StripeGateway._();
    }
    return _instance!;
  }

  @override
  bool get isMock => false;

  @override
  Future<PaymentResult> pay(Order order) async {
    final secret = order.clientSecret;
    if (secret == null || secret.isEmpty) return const PaymentFailed('No payment details for this order');
    try {
      await Stripe.instance.initPaymentSheet(
        paymentSheetParameters: SetupPaymentSheetParameters(
          paymentIntentClientSecret: secret,
          merchantDisplayName: 'KINAN',
          style: ThemeMode.system,
        ),
      );
      await Stripe.instance.presentPaymentSheet();
      return const PaymentSubmitted();
    } on StripeException catch (e) {
      if (e.error.code == FailureCode.Canceled) return const PaymentCancelled();
      return PaymentFailed(e.error.localizedMessage ?? e.error.message ?? 'Payment failed');
    } catch (e) {
      return PaymentFailed('$e');
    }
  }
}

/// Demo mode: the server has no Stripe keys and exposes /demo-pay. Clearly labelled MOCK in the UI.
class MockGateway implements PaymentGateway {
  MockGateway(this.api);
  final ApiClient api;

  @override
  bool get isMock => true;

  @override
  Future<PaymentResult> pay(Order order) async {
    try {
      await api.demoPay(order.id);
      return const PaymentSubmitted();
    } on ApiException catch (e) {
      return PaymentFailed(e.message);
    } on NetworkUncertainException {
      // The status is read back from the server next, so an unknown result is handled there.
      return const PaymentSubmitted();
    }
  }
}
