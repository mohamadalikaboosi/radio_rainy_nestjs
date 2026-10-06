import 'dart:math';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Stable hue 0-359 for a string: every track gets its own colour theme (same hash as the web player).
int hueOf(String seed) {
  var h = 2166136261;
  for (final c in seed.codeUnits) {
    h ^= c;
    h = (h * 16777619) & 0xFFFFFFFF;
  }
  return h % 360;
}

Color accent(int hue, {double lightness = 0.62}) => HSLColor.fromAHSL(1, hue.toDouble(), 0.85, lightness).toColor();

Future<void> openExternal(Uri uri) async {
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}

/// Animated bars: the equalizer of the app (a calm wave when paused).
class EqualizerBars extends StatefulWidget {
  const EqualizerBars({super.key, required this.playing, this.bars = 28, this.color = Colors.white});

  final bool playing;
  final int bars;
  final Color color;

  @override
  State<EqualizerBars> createState() => _EqualizerBarsState();
}

class _EqualizerBarsState extends State<EqualizerBars> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 3))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    return AnimatedBuilder(
      animation: _c,
      builder: (_, _) => CustomPaint(painter: _BarsPainter(_c.value * 6.2831853 * 3, widget.playing && !reduce, widget.bars, widget.color), size: const Size(double.infinity, 56)),
    );
  }
}

class _BarsPainter extends CustomPainter {
  _BarsPainter(this.phase, this.playing, this.bars, this.color);

  final double phase;
  final bool playing;
  final int bars;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color.withValues(alpha: playing ? 0.9 : 0.35);
    final w = size.width / bars;
    for (var i = 0; i < bars; i++) {
      final wave = (sin(phase + i * 0.55) + 1) / 2 * 0.6 + (sin(phase * 1.7 + i * 1.3) + 1) / 2 * 0.4;
      final level = playing ? 0.15 + 0.85 * wave : 0.1 + 0.08 * wave;
      final h = size.height * level;
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(i * w + w * 0.2, size.height - h, w * 0.6, h), const Radius.circular(3)), paint);
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) => old.phase != phase || old.playing != playing;
}
