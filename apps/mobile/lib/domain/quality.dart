/// Which stream the listener gets: the normal one or the light "data saver" mono stream (`?quality=low`).
enum QualityPref { auto, high, low }

QualityPref qualityPrefFrom(String? s) => switch (s) {
      'high' => QualityPref.high,
      'low' => QualityPref.low,
      _ => QualityPref.auto,
    };

/// Counts stalls (the player ran out of audio and had to buffer) in a sliding window: [limit] within [window] means the network cannot keep up.
class StallTracker {
  StallTracker({this.limit = 3, this.window = const Duration(seconds: 20)});

  final int limit;
  final Duration window;
  final List<DateTime> _at = [];

  /// Records one stall; true once there were [limit] of them inside the window.
  bool record(DateTime now) {
    _at
      ..removeWhere((t) => now.difference(t) >= window)
      ..add(now);
    return _at.length >= limit;
  }

  void reset() => _at.clear();
}

/// The stream to use now. [slowConnection] is what the OS reports (data saver / cellular 2g-3g) and [stalledOnHigh] means the normal
/// stream stalled repeatedly in this session. The light stream is only possible when the station offers it.
bool useLowQuality({required QualityPref pref, required bool stationOffersLow, required bool stalledOnHigh, bool slowConnection = false}) {
  if (!stationOffersLow) return false;
  return switch (pref) {
    QualityPref.low => true,
    QualityPref.high => false,
    QualityPref.auto => stalledOnHigh || slowConnection,
  };
}
