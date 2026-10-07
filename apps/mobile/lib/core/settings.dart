import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import '../domain/quality.dart';

/// Small persisted choices: the server, the quality preference, the language and an anonymous voter id.
class Settings {
  Settings(this._prefs);

  final SharedPreferences _prefs;

  static Future<Settings> load() async => Settings(await SharedPreferences.getInstance());

  String? get server => _prefs.getString('server');
  Future<void> setServer(String? v) async => v == null ? _prefs.remove('server') : _prefs.setString('server', v);

  QualityPref get quality => qualityPrefFrom(_prefs.getString('quality'));
  Future<void> setQuality(QualityPref q) => _prefs.setString('quality', q.name);

  /// The lyrics card is shown (default) or hidden.
  bool get showLyrics => _prefs.getBool('lyrics') ?? true;
  Future<void> setShowLyrics(bool v) => _prefs.setBool('lyrics', v);

  /// In-app volume 0-1 (desktop slider; phones use the hardware buttons and stay at 1).
  double get volume => (_prefs.getDouble('volume') ?? 1.0).clamp(0.0, 1.0);
  Future<void> setVolume(double v) => _prefs.setDouble('volume', v);

  /// null = follow the phone's language.
  String? get language => _prefs.getString('language');
  Future<void> setLanguage(String? v) async => v == null ? _prefs.remove('language') : _prefs.setString('language', v);

  /// Anonymous id so one listener has one vote; the server never learns who it is.
  String get voterId {
    final saved = _prefs.getString('voter');
    if (saved != null && RegExp(r'^[A-Za-z0-9_-]{8,64}$').hasMatch(saved)) return saved;
    final rnd = Random.secure();
    final fresh = List.generate(24, (_) => 'abcdefghijklmnopqrstuvwxyz0123456789'[rnd.nextInt(36)]).join();
    _prefs.setString('voter', fresh);
    return fresh;
  }
}
