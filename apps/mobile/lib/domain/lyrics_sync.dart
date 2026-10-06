import '../data/models.dart';

/// Index of the line being sung at [position] seconds (-1 before the first line, or in a gap after a line).
/// Computed on the phone from the server's clock: no polling.
int activeLineIndex(List<LyricLine> lines, double position) {
  var lo = 0;
  var hi = lines.length - 1;
  var found = -1;
  while (lo <= hi) {
    final mid = (lo + hi) >> 1;
    if (lines[mid].start <= position) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return -1;
  return position < lines[found].end + 1.5 ? found : -1; // a short grace after the line ends, then the gap is empty
}

/// Seconds the track on air has been playing, measured with the SERVER's clock (so a wrong phone clock does not matter):
/// the server's "now" at the time of the response, advanced by the time that passed on this phone since.
double positionSeconds({required DateTime startedAt, required DateTime serverTime, required Duration sinceFetched, double? duration}) {
  final serverNow = serverTime.add(sinceFetched);
  final p = serverNow.difference(startedAt).inMilliseconds / 1000.0;
  final clamped = p < 0 ? 0.0 : p;
  return duration == null ? clamped : (clamped > duration ? duration : clamped);
}
