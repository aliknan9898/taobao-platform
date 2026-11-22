import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../l10n/strings.dart';
import '../state/app_state.dart';
import 'widgets.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, required this.next});
  final Widget next;
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final s = S.of(context);
    final st = AppScope.read(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await st.signIn(_email.text, _password.text);
      if (!mounted) return;
      await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => widget.next));
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.status == 401 ? s.t('bad_login') : e.message);
    } catch (_) {
      if (mounted) setState(() => _error = s.t('load_error'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final st = AppScope.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.t('sign_in'))),
      body: Column(children: [
        const EnvBanner(),
        Expanded(
          child: AutofillGroup(
            child: ListView(padding: const EdgeInsets.all(16), children: [
              if (st.sessionExpired) Notice(s.t('session_expired'), kind: NoticeKind.warning),
              Text(s.t('sign_in_needed')),
              const SizedBox(height: 16),
              TextField(
                key: const Key('email'),
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.email],
                textDirection: TextDirection.ltr, // emails are always LTR, also in Arabic
                decoration: InputDecoration(labelText: s.t('email'), border: const OutlineInputBorder()),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('password'),
                controller: _password,
                obscureText: true,
                autofillHints: const [AutofillHints.password],
                textDirection: TextDirection.ltr,
                decoration: InputDecoration(labelText: s.t('password'), border: const OutlineInputBorder()),
                onSubmitted: (_) => _submit(),
              ),
              if (_error != null) Notice(_error!, kind: NoticeKind.error),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('sign-in'),
                onPressed: _busy ? null : _submit,
                child: _busy ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2)) : Text(s.t('sign_in')),
              ),
            ]),
          ),
        ),
      ]),
    );
  }
}
