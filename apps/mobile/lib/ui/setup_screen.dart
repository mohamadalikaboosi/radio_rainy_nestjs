import 'package:flutter/material.dart';

import '../core/server_address.dart';
import '../data/api_client.dart';
import '../l10n/strings.dart';

/// First start: where is the radio? Accepts a server address or the link of one station.
class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.onConnected, this.initial});

  /// Called with the text the user typed (kept as is, so a station link keeps its station).
  final Future<void> Function(String input) onConnected;
  final String? initial;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  late final TextEditingController _text = TextEditingController(text: widget.initial ?? '');
  String? _error;
  bool _busy = false;

  Future<void> _connect() async {
    final address = ServerAddress.parse(_text.text);
    if (address == null) {
      setState(() => _error = context.tr('setup.invalid'));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final api = ApiClient(address);
    try {
      await api.stations(); // proves it is a radio_rainy server
      await widget.onConnected(_text.text.trim());
    } catch (e) {
      if (mounted) setState(() => _error = context.tr('setup.unreachable', {'error': '$e'}));
    } finally {
      api.close();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: ListView(
              padding: const EdgeInsets.all(24),
              shrinkWrap: true,
              children: [
                const Text('🌧', style: TextStyle(fontSize: 56), textAlign: TextAlign.center),
                const SizedBox(height: 12),
                Text(context.tr('setup.title'), style: Theme.of(context).textTheme.headlineMedium, textAlign: TextAlign.center),
                const SizedBox(height: 8),
                Text(context.tr('setup.help'), textAlign: TextAlign.center),
                const SizedBox(height: 24),
                TextField(
                  controller: _text,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  textInputAction: TextInputAction.go,
                  onSubmitted: (_) => _connect(),
                  decoration: InputDecoration(labelText: context.tr('setup.hint'), border: const OutlineInputBorder(), errorText: _error, errorMaxLines: 3),
                ),
                const SizedBox(height: 16),
                FilledButton(onPressed: _busy ? null : _connect, child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : Text(context.tr('setup.connect'))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
