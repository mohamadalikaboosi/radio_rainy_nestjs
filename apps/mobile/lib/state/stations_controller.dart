import 'dart:async';

import 'package:flutter/foundation.dart';

import '../data/api_client.dart';
import '../data/models.dart';

/// The list of stations with what each live one plays right now (the landing page of the web).
class StationsController extends ChangeNotifier {
  StationsController(this.api, {this.refreshEvery = const Duration(seconds: 15)});

  final ApiClient api;
  final Duration refreshEvery;

  List<Station> stations = const [];
  final Map<String, Current> nowPlaying = {};
  bool loading = true;
  String? error;
  Timer? _timer;
  bool _disposed = false;

  Future<void> start() async {
    await refresh();
    _timer = Timer.periodic(refreshEvery, (_) => unawaited(refresh()));
  }

  Future<void> refresh() async {
    try {
      final list = await api.stations();
      // on air first, then by title
      list.sort((a, b) => a.live == b.live ? a.title.toLowerCase().compareTo(b.title.toLowerCase()) : (a.live ? -1 : 1));
      stations = list;
      error = null;
      loading = false;
      _changed();
      final live = list.where((s) => s.live).take(8);
      final entries = await Future.wait(live.map((s) async {
        try {
          return MapEntry(s.slug, await api.current(s.slug));
        } catch (_) {
          return null;
        }
      }));
      nowPlaying
        ..clear()
        ..addEntries(entries.whereType<MapEntry<String, Current>>());
    } catch (e) {
      error = '$e';
      loading = false;
    }
    _changed();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
