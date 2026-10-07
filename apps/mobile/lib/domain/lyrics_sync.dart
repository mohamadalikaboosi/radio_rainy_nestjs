import 'dart:math';

import '../data/models.dart';

/// One row of the lyrics card: a sung line, or an instrumental stretch ("• • •") wherever nothing is sung for a while.
class LyricRow {
  const LyricRow({required this.start, required this.end, required this.text, this.gap = false});

  final double start;
  final double end;
  final String text;
  final bool gap;
}

/// Synchronized lines -> rows, with instrumental rows for the intro, long solos and (when the duration is known) the outro.
List<LyricRow> lyricRows(List<LyricLine> lines, {double? duration, double minGap = 6}) {
  final rows = <LyricRow>[];
  var sungUntil = 0.0;
  for (final l in lines) {
    if (l.start - sungUntil >= minGap) rows.add(LyricRow(start: sungUntil, end: l.start, text: '', gap: true));
    rows.add(LyricRow(start: l.start, end: l.end, text: l.text));
    sungUntil = max(sungUntil, l.end);
  }
  if (rows.isNotEmpty && duration != null && duration - sungUntil >= minGap) rows.add(LyricRow(start: sungUntil, end: duration, text: '', gap: true));
  return rows;
}

/// The row on air at [position] seconds: the last one that started (-1 before the first).
int activeRowIndex(List<LyricRow> rows, double position) {
  var lo = 0;
  var hi = rows.length - 1;
  var found = -1;
  while (lo <= hi) {
    final mid = (lo + hi) >> 1;
    if (rows[mid].start <= position) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/// Karaoke fill of the active row, 0-1: the accent sweeps across the line while it is sung (done a moment before it ends).
double karaokeFill(LyricRow row, double position) => ((position - row.start) / max(0.5, row.end - row.start - 0.3)).clamp(0.0, 1.0);

/// Share of the votes per option, in whole percent (0 before anybody voted).
List<int> voteShares(List<int> votes) {
  final total = votes.fold(0, (a, v) => a + v);
  return [for (final v in votes) total > 0 ? (v / total * 100).round() : 0];
}

/// Visualizer bars (0-1). The app has no access to the decoded audio, so playing shows a lively envelope (louder in the low-mid band, like
/// music); paused is a low idle wave at 4-7%. [tMs] is a clock in milliseconds.
List<double> vizLevels(int bars, {required bool playing, required double tMs, double Function()? rng}) {
  final r = rng ?? Random().nextDouble;
  return [
    for (var i = 0; i < bars; i++)
      playing ? min(1.0, (0.35 + 0.65 * exp(-pow((i - bars * 0.22) / (bars * 0.34), 2))) * (0.25 + r() * 0.75)) : 0.055 + 0.015 * sin(i / 3 + tMs / 900),
  ];
}

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
