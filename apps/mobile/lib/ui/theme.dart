import 'package:flutter/material.dart';

/// Design tokens of "Rainy Song" (design_handoff_rainy_song_player): the same values as the web player.
abstract final class Rs {
  static const bg = Color(0xFF0A0C0B);
  static const glow = Color(0xFF12201A);
  static const ink = Color(0xFFECEFE9);
  static const ink2 = Color(0xFFC9CFC6);
  static const muted = Color(0xFFA7AEA4);
  static const muted2 = Color(0xFF8F978D);
  static const live = Color(0xFFFF5A4E);
  static const amber = Color(0xFFF2C46B);
  /// "Rain" accent; text on it is always [bg].
  static const acc = Color(0xFF9BE27A);

  /// Surfaces (.025 / .035 / .05) and borders (.08 / .10 / .12 / .14) are the ink colour at low opacity.
  static Color tint(double opacity) => Color.fromRGBO(236, 239, 233, opacity);

  static const serif = 'InstrumentSerif';
  static const sans = 'Manrope';
  static const mono = 'JetBrainsMono';
  /// Persian (and anything else the Latin subsets lack) falls back to Vazirmatn.
  static const fallback = ['Vazirmatn'];

  /// The design's tracking is for Latin small caps: Persian letters must stay joined, so RTL gets none.
  static double track(BuildContext context, double em, double size) => Directionality.of(context) == TextDirection.rtl ? 0 : em * size;

  static TextStyle serifText(double size, {Color color = ink, double height = 1}) =>
      TextStyle(fontFamily: serif, fontFamilyFallback: fallback, fontSize: size, height: height, color: color, fontWeight: FontWeight.w400);

  static TextStyle monoText(BuildContext context, double size, {Color color = muted, double tracking = 0, FontWeight weight = FontWeight.w400}) =>
      TextStyle(fontFamily: mono, fontFamilyFallback: fallback, fontSize: size, color: color, fontWeight: weight, letterSpacing: track(context, tracking, size));

  static TextStyle sansText(double size, {Color color = ink, FontWeight weight = FontWeight.w400}) =>
      TextStyle(fontFamily: sans, fontFamilyFallback: fallback, fontSize: size, color: color, fontWeight: weight);

  /// Upper-cases Latin labels (Persian has no case).
  static String caps(String s) => s.toUpperCase();
}

ThemeData rainyTheme() {
  const scheme = ColorScheme.dark(primary: Rs.acc, onPrimary: Rs.bg, secondary: Rs.acc, onSecondary: Rs.bg, surface: Rs.bg, onSurface: Rs.ink, error: Rs.live);
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    scaffoldBackgroundColor: Rs.bg,
    fontFamily: Rs.sans,
    fontFamilyFallback: Rs.fallback,
    appBarTheme: const AppBarTheme(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: Rs.ink, surfaceTintColor: Colors.transparent),
    popupMenuTheme: PopupMenuThemeData(color: const Color(0xFF121514), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: Rs.tint(0.12)))),
    sliderTheme: SliderThemeData(activeTrackColor: Rs.acc, thumbColor: Rs.acc, inactiveTrackColor: Rs.tint(0.14), overlayColor: Rs.acc.withValues(alpha: 0.12), trackHeight: 3),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: Rs.acc),
  );
}
