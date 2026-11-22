import 'package:flutter/material.dart';

import '../l10n/strings.dart';
import '../state/app_state.dart';
import 'catalog_screen.dart';
import 'widgets.dart';

class DestinationScreen extends StatefulWidget {
  const DestinationScreen({super.key, this.fromSettings = false});
  final bool fromSettings;

  @override
  State<DestinationScreen> createState() => _DestinationScreenState();
}

class _DestinationScreenState extends State<DestinationScreen> {
  String? _country;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _country ??= AppScope.read(context).country;
  }

  @override
  Widget build(BuildContext context) {
    final st = AppScope.of(context);
    final s = S.of(context);
    final countries = st.publicConfig?.countries ?? const [];
    return Scaffold(
      appBar: AppBar(title: Text(s.t('app_title')), automaticallyImplyLeading: widget.fromSettings),
      body: Column(children: [
        const EnvBanner(),
        Expanded(
          child: ListView(padding: const EdgeInsets.all(16), children: [
            Text(s.t('destination_title'), style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text(s.t('destination_hint')),
            const SizedBox(height: 24),
            Text(s.t('language'), style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'ar', label: Text('العربية')),
                ButtonSegment(value: 'en', label: Text('English')),
              ],
              selected: {st.lang},
              onSelectionChanged: (v) => st.setLanguage(v.first),
            ),
            const SizedBox(height: 24),
            DropdownButtonFormField<String>(
              key: const Key('country'),
              initialValue: _country,
              isExpanded: true,
              decoration: InputDecoration(labelText: s.t('country'), border: const OutlineInputBorder()),
              items: [for (final c in countries) DropdownMenuItem(value: c.code, child: Text('${c.name} (${c.code})'))],
              onChanged: (v) => setState(() => _country = v),
            ),
            const SizedBox(height: 24),
            FilledButton(
              key: const Key('continue'),
              onPressed: _country == null
                  ? null
                  : () async {
                      await st.setCountry(_country!);
                      if (!context.mounted) return;
                      if (widget.fromSettings) {
                        Navigator.of(context).pop(true);
                      } else {
                        await Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => const CatalogScreen()));
                      }
                    },
              child: Text(s.t('continue')),
            ),
          ]),
        ),
      ]),
    );
  }
}
