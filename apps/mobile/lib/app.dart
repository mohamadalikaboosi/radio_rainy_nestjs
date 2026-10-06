import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'audio/radio_player.dart';
import 'core/server_address.dart';
import 'core/settings.dart';
import 'data/api_client.dart';
import 'data/models.dart';
import 'l10n/strings.dart';
import 'state/station_controller.dart';
import 'state/stations_controller.dart';
import 'ui/player_screen.dart';
import 'ui/setup_screen.dart';
import 'ui/stations_screen.dart';

/// Wires the settings, the audio and the screens together.
class RadioApp extends StatefulWidget {
  const RadioApp({super.key, required this.settings, required this.player});

  final Settings settings;
  final RadioPlayer player;

  @override
  State<RadioApp> createState() => _RadioAppState();
}

class _RadioAppState extends State<RadioApp> {
  late String? _serverText = widget.settings.server;
  late String? _language = widget.settings.language;
  final GlobalKey<NavigatorState> _nav = GlobalKey<NavigatorState>();

  ServerAddress? get _address => _serverText == null ? null : ServerAddress.parse(_serverText!);

  Future<void> _connect(String text) async {
    await widget.settings.setServer(text);
    setState(() => _serverText = text);
  }

  Future<void> _forget() async {
    await widget.player.stop();
    await widget.settings.setServer(null);
    setState(() => _serverText = null);
  }

  Future<void> _setLanguage(String? code) async {
    await widget.settings.setLanguage(code);
    setState(() => _language = code);
  }

  @override
  Widget build(BuildContext context) {
    final address = _address;
    return MaterialApp(
      navigatorKey: _nav,
      title: 'Radio Rainy',
      debugShowCheckedModeBanner: false,
      locale: _language == null ? null : Locale(_language!),
      supportedLocales: Strings.supported,
      localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6C7BFF), brightness: Brightness.dark), useMaterial3: true, scaffoldBackgroundColor: const Color(0xFF0B0D13)),
      home: address == null
          ? SetupScreen(onConnected: _connect)
          : _Home(key: ValueKey(_serverText), address: address, settings: widget.settings, player: widget.player, language: _language, onLanguage: _setLanguage, onChangeServer: _forget),
    );
  }
}

/// A server is known: either the list of stations, or (station link) that one station only.
class _Home extends StatefulWidget {
  const _Home({super.key, required this.address, required this.settings, required this.player, required this.language, required this.onLanguage, required this.onChangeServer});

  final ServerAddress address;
  final Settings settings;
  final RadioPlayer player;
  final String? language;
  final void Function(String? code) onLanguage;
  final VoidCallback onChangeServer;

  @override
  State<_Home> createState() => _HomeState();
}

class _HomeState extends State<_Home> {
  late final ApiClient _api = ApiClient(widget.address);
  StationsController? _stations;
  Future<StationController?>? _locked;

  @override
  void initState() {
    super.initState();
    if (widget.address.isStationLink) {
      _locked = _openLocked();
    } else {
      _stations = StationsController(_api)..start();
    }
  }

  Future<StationController?> _openLocked() async {
    String? slug = widget.address.stationSlug;
    if (slug == null) {
      final list = await _api.stations();
      slug = list.where((s) => s.publicId?.toLowerCase() == widget.address.stationPublicId).firstOrNull?.slug;
    }
    return _controllerFor(slug ?? '__missing__')..start();
  }

  StationController _controllerFor(String slug) => StationController(api: _api, address: widget.address, slug: slug, player: widget.player, settings: widget.settings);

  void _open(Station s) {
    final c = _controllerFor(s.slug)..start();
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => PlayerScreen(controller: c)))
        .whenComplete(() async {
      await widget.player.stop();
      c.dispose();
    });
  }

  @override
  void dispose() {
    _stations?.dispose();
    _api.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final locked = _locked;
    if (locked != null) {
      return FutureBuilder<StationController?>(
        future: locked,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) return const Scaffold(body: Center(child: CircularProgressIndicator()));
          final c = snap.data;
          if (c == null) {
            return Scaffold(body: Center(child: Text(context.tr('player.notFound'))));
          }
          return PlayerScreen(controller: c, locked: true, onChangeServer: widget.onChangeServer);
        },
      );
    }
    return StationsScreen(controller: _stations!, onOpen: _open, onChangeServer: widget.onChangeServer, onLanguage: widget.onLanguage, language: widget.language);
  }
}
