import 'dart:async';
import 'dart:math';
import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../data/models.dart';
import '../domain/lyrics_sync.dart';
import '../domain/quality.dart';
import '../l10n/strings.dart';
import '../state/station_controller.dart';
import 'common.dart';
import 'theme.dart';

/// mm:ss of a duration in seconds ("--:--" when unknown).
String mmss(double? seconds) {
  if (seconds == null || seconds.isNaN || seconds.isInfinite) return '--:--';
  final t = seconds < 0 ? 0 : seconds.floor();
  return '${(t ~/ 60).toString().padLeft(2, '0')}:${(t % 60).toString().padLeft(2, '0')}';
}

bool _reduceMotion(BuildContext context) => MediaQuery.maybeOf(context)?.disableAnimations ?? false;

/// One station, design "Rainy Song": header, the record + what is on air, the visualizer, live synced lyrics, the tag vote and a sponsor.
/// With [locked] (opened from a station link) there is no way back to the other stations.
class PlayerScreen extends StatefulWidget {
  const PlayerScreen({super.key, required this.controller, this.locked = false, this.onChangeServer, this.onLanguage});

  final StationController controller;
  final bool locked;
  final VoidCallback? onChangeServer;

  /// Switches the app language (null = follow the phone).
  final void Function(String? code)? onLanguage;

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  StationController get c => widget.controller;
  final ScrollController _scroll = ScrollController();
  final GlobalKey _heroKey = GlobalKey();
  bool _heroVisible = true;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    // progress, countdowns and the line being sung follow the clock: four updates a second, no network
    _tick = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (mounted) setState(() {});
    });
  }

  void _onScroll() {
    final box = _heroKey.currentContext?.findRenderObject() as RenderBox?;
    final visible = _scroll.offset < (box?.size.height ?? 400) * 0.8;
    if (visible != _heroVisible) setState(() => _heroVisible = visible);
  }

  @override
  void dispose() {
    _tick?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final size = MediaQuery.sizeOf(context);
        final phone = size.width < 600;
        final side = (size.width * 0.04).clamp(16.0, 40.0);
        final gap = (size.width * 0.05).clamp(28.0, 56.0);
        final cur = c.current;
        final isAd = cur?.isAd == true;
        final onAir = cur?.onAir == true;
        final hasVote = c.vote.open || (c.vote.status == 'PLAYING' && c.vote.winner != null);
        return Scaffold(
          backgroundColor: Rs.bg,
          body: Stack(children: [
            const Positioned.fill(child: _Backdrop()),
            if (!_reduceMotion(context)) const Positioned.fill(child: IgnorePointer(child: _Rain())),
            SafeArea(
              bottom: false,
              child: c.notFound
                  ? Center(child: Text(context.tr('player.notFound'), style: Rs.sansText(16)))
                  : SingleChildScrollView(
                      controller: _scroll,
                      padding: EdgeInsets.fromLTRB(side, 24, side, phone ? 104 : 56),
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 1240),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                            _Header(controller: c, locked: widget.locked, phone: phone, onChangeServer: widget.onChangeServer, onLanguage: widget.onLanguage),
                            for (final m in c.messages) Padding(padding: const EdgeInsets.only(top: 16), child: _MessageBanner(m)),
                            SizedBox(height: gap),
                            _Hero(key: _heroKey, controller: c, wide: size.width >= 900, phone: phone),
                            SizedBox(height: gap),
                            _Visualizer(playing: c.sounding),
                            if (c.showLyrics && !isAd) ...[SizedBox(height: gap), _LyricsCard(controller: c, side: side, viewportHeight: phone ? size.height * 0.45 : 300)],
                            if (hasVote || c.sponsors.isNotEmpty) ...[SizedBox(height: gap), _VoteAndSponsor(controller: c, wide: size.width >= 760, showVote: hasVote)],
                          ]),
                        ),
                      ),
                    ),
            ),
            if (phone && !_heroVisible && (onAir || isAd)) Positioned(left: 12, right: 12, bottom: 12, child: SafeArea(top: false, child: _MiniPlayer(controller: c))),
          ]),
        );
      },
    );
  }
}

class _Backdrop extends StatelessWidget {
  const _Backdrop();

  @override
  Widget build(BuildContext context) => const DecoratedBox(
        decoration: BoxDecoration(gradient: RadialGradient(center: Alignment(-0.7, -1.2), radius: 1.3, colors: [Rs.glow, Rs.bg], stops: [0, 0.6])),
      );
}

// ---------------------------------------------------------------- rain

class _Drop {
  _Drop(Random r)
      : x = r.nextDouble(),
        length = 40 + r.nextDouble() * 80,
        period = 1.2 + r.nextDouble() * 1.8,
        delay = r.nextDouble() * 3;

  final double x;
  final double length;
  final double period;
  final double delay;
}

/// 40 thin falling lines (not interactive; off with "reduce motion").
class _Rain extends StatefulWidget {
  const _Rain();

  @override
  State<_Rain> createState() => _RainState();
}

class _RainState extends State<_Rain> with SingleTickerProviderStateMixin {
  final ValueNotifier<double> _t = ValueNotifier(0);
  final List<_Drop> _drops = List.generate(40, (_) => _Drop(Random()));
  late final Ticker _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker((e) => _t.value = e.inMicroseconds / 1e6)..start();
  }

  @override
  void dispose() {
    _ticker.dispose();
    _t.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CustomPaint(painter: _RainPainter(_drops, _t));
}

class _RainPainter extends CustomPainter {
  _RainPainter(this.drops, this.t) : super(repaint: t);

  final List<_Drop> drops;
  final ValueNotifier<double> t;

  @override
  void paint(Canvas canvas, Size size) {
    for (final d in drops) {
      final phase = ((t.value + d.delay) % d.period) / d.period;
      final opacity = phase < 0.1 ? phase / 0.1 : 1 - (phase - 0.1) / 0.9;
      final y = -0.2 * size.height + phase * 1.4 * size.height;
      final x = d.x * size.width;
      final rect = Rect.fromLTWH(x, y, 1, d.length);
      final paint = Paint()
        ..shader = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Rs.tint(0.18 * opacity)]).createShader(rect);
      canvas.drawRect(rect, paint);
    }
  }

  @override
  bool shouldRepaint(_RainPainter old) => false;
}

// ---------------------------------------------------------------- header

enum _Air { on, off, reconnecting }

class _Header extends StatelessWidget {
  const _Header({required this.controller, required this.locked, required this.phone, this.onChangeServer, this.onLanguage});

  final StationController controller;
  final bool locked;
  final bool phone;
  final VoidCallback? onChangeServer;
  final void Function(String? code)? onLanguage;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final cur = c.current;
    final air = c.reconnecting ? _Air.reconnecting : (cur != null && (cur.onAir || cur.isAd)) ? _Air.on : _Air.off;
    final canPop = !locked && Navigator.of(context).canPop();
    return Row(children: [
      if (canPop) const Padding(padding: EdgeInsetsDirectional.only(end: 4), child: BackButton(color: Rs.ink)),
      const _Logo(),
      const SizedBox(width: 14),
      Flexible(child: Text(c.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: Rs.sansText(17, weight: FontWeight.w700))),
      const SizedBox(width: 14),
      _OnAirPill(air),
      const Spacer(),
      if (!phone) ...[
        TextButton(onPressed: () => openExternal(c.api.absolute('/partner')), child: Text(context.tr('player.advertise'), style: Rs.sansText(13, color: Rs.muted))),
        if (c.offersLow) Padding(padding: const EdgeInsetsDirectional.only(start: 8), child: _QualityMenu(controller: c)),
        if (onLanguage != null) Padding(padding: const EdgeInsetsDirectional.only(start: 8), child: _LanguageMenu(onLanguage: onLanguage!)),
      ] else
        _MoreMenu(controller: c, onLanguage: onLanguage),
      if (locked && onChangeServer != null) IconButton(tooltip: context.tr('stations.changeServer'), icon: const Icon(Icons.dns_outlined, color: Rs.muted), onPressed: onChangeServer),
    ]);
  }
}

class _Logo extends StatelessWidget {
  const _Logo();

  @override
  Widget build(BuildContext context) => Container(
        width: 30,
        height: 30,
        alignment: Alignment.center,
        decoration: const BoxDecoration(color: Rs.acc, shape: BoxShape.circle),
        child: Container(width: 8, height: 8, decoration: const BoxDecoration(color: Rs.bg, shape: BoxShape.circle)),
      );
}

class _Dot extends StatelessWidget {
  const _Dot(this.color, {this.ring = false});

  final Color color;
  final bool ring;

  @override
  Widget build(BuildContext context) => Container(
        width: 6,
        height: 6,
        decoration: BoxDecoration(shape: BoxShape.circle, color: ring ? null : color, border: ring ? Border.all(color: color) : null),
      );
}

/// The red "on air" dot: fades 1 -> .25 -> 1 every 1.6 s.
class _PulsingDot extends StatefulWidget {
  const _PulsingDot();

  @override
  State<_PulsingDot> createState() => _PulsingDotState();
}

class _PulsingDotState extends State<_PulsingDot> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 800), lowerBound: 0.25)..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _reduceMotion(context) ? const _Dot(Rs.live) : FadeTransition(opacity: _c, child: const _Dot(Rs.live));
}

class _OnAirPill extends StatelessWidget {
  const _OnAirPill(this.air);

  final _Air air;

  @override
  Widget build(BuildContext context) {
    final label = switch (air) {
      _Air.on => context.tr('player.onAir'),
      _Air.off => context.tr('player.offAir'),
      _Air.reconnecting => context.tr('player.reconnecting'),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(border: Border.all(color: Rs.tint(0.14)), borderRadius: BorderRadius.circular(99)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        switch (air) {
          _Air.on => const _PulsingDot(),
          _Air.off => const _Dot(Rs.muted2),
          _Air.reconnecting => const _Dot(Rs.amber),
        },
        const SizedBox(width: 7),
        Text(Rs.caps(label), style: Rs.monoText(context, 11, color: Rs.ink2, tracking: 0.08)),
      ]),
    );
  }
}

/// A dropdown-looking pill (the design's selects).
class _SelectPill extends StatelessWidget {
  const _SelectPill(this.label);

  final String label;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsetsDirectional.fromSTEB(12, 9, 10, 9),
        decoration: BoxDecoration(color: Rs.tint(0.05), border: Border.all(color: Rs.tint(0.12)), borderRadius: BorderRadius.circular(10)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(label, style: Rs.sansText(13, weight: FontWeight.w500)),
          const SizedBox(width: 6),
          const Icon(Icons.expand_more, size: 16, color: Rs.muted),
        ]),
      );
}

String _qualityName(BuildContext context, QualityPref q) => switch (q) {
      QualityPref.auto => context.tr('player.qualityAuto'),
      QualityPref.high => context.tr('player.qualityHigh'),
      QualityPref.low => context.tr('player.qualityLow'),
    };

class _QualityMenu extends StatelessWidget {
  const _QualityMenu({required this.controller});

  final StationController controller;

  @override
  Widget build(BuildContext context) => PopupMenuButton<QualityPref>(
        tooltip: context.tr('player.quality'),
        initialValue: controller.pref,
        onSelected: controller.setQuality,
        itemBuilder: (_) => [for (final q in QualityPref.values) PopupMenuItem(value: q, child: Text(_qualityName(context, q)))],
        child: _SelectPill(context.tr('player.qualityPill', {'q': _qualityName(context, controller.pref)})),
      );
}

class _LanguageMenu extends StatelessWidget {
  const _LanguageMenu({required this.onLanguage});

  final void Function(String? code) onLanguage;

  @override
  Widget build(BuildContext context) {
    final lang = Localizations.localeOf(context).languageCode;
    return PopupMenuButton<String>(
      tooltip: context.tr('stations.language'),
      onSelected: (v) => onLanguage(v == 'auto' ? null : v),
      itemBuilder: (_) => [
        PopupMenuItem(value: 'auto', child: Text(context.tr('stations.langAuto'))),
        const PopupMenuItem(value: 'en', child: Text('English')),
        const PopupMenuItem(value: 'fa', child: Text('فارسی')),
      ],
      child: _SelectPill(lang == 'fa' ? 'فارسی' : 'English'),
    );
  }
}

/// Phones: quality, language and "advertise" behind one "⋯" button.
class _MoreMenu extends StatelessWidget {
  const _MoreMenu({required this.controller, this.onLanguage});

  final StationController controller;
  final void Function(String? code)? onLanguage;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final lang = Localizations.localeOf(context).languageCode;
    return PopupMenuButton<String>(
      tooltip: context.tr('player.menu'),
      onSelected: (v) {
        if (v.startsWith('q:')) unawaited(c.setQuality(QualityPref.values.byName(v.substring(2))));
        if (v.startsWith('lang:')) onLanguage?.call(v == 'lang:auto' ? null : v.substring(5));
        if (v == 'advertise') unawaited(openExternal(c.api.absolute('/partner')));
      },
      itemBuilder: (_) => [
        if (c.offersLow)
          for (final q in QualityPref.values) CheckedPopupMenuItem(value: 'q:${q.name}', checked: c.pref == q, child: Text(context.tr('player.qualityPill', {'q': _qualityName(context, q)}))),
        if (onLanguage != null) ...[
          if (c.offersLow) const PopupMenuDivider(),
          CheckedPopupMenuItem(value: 'lang:en', checked: lang == 'en', child: const Text('English')),
          CheckedPopupMenuItem(value: 'lang:fa', checked: lang == 'fa', child: const Text('فارسی')),
        ],
        const PopupMenuDivider(),
        PopupMenuItem(value: 'advertise', child: Text(context.tr('player.advertise'))),
      ],
      child: Container(
        width: 44,
        height: 44,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: Rs.tint(0.05), border: Border.all(color: Rs.tint(0.12)), borderRadius: BorderRadius.circular(12)),
        child: const Icon(Icons.more_horiz, color: Rs.ink),
      ),
    );
  }
}

class _MessageBanner extends StatelessWidget {
  const _MessageBanner(this.message);

  final LiveMessage message;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
        decoration: BoxDecoration(color: Rs.tint(0.035), border: Border.all(color: message.warn ? Rs.live : Rs.acc), borderRadius: BorderRadius.circular(12)),
        child: Text(message.text, style: Rs.sansText(14)),
      );
}

// ---------------------------------------------------------------- hero

class _Hero extends StatelessWidget {
  const _Hero({super.key, required this.controller, required this.wide, required this.phone});

  final StationController controller;
  final bool wide;
  final bool phone;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final cur = c.current;
    final ad = cur != null && cur.isAd ? cur.ad : null;
    final image = ad?.imageUrl;
    final vinyl = ConstrainedBox(
      constraints: BoxConstraints(maxWidth: phone ? MediaQuery.sizeOf(context).width * 0.72 : 460),
      child: _Vinyl(spinning: c.sounding, label: c.title, sub: context.tr('player.vinylSide'), imageUrl: image == null ? null : c.api.absolute(image).toString()),
    );
    final now = _NowPlaying(controller: c, phone: phone);
    if (wide) {
      return Row(children: [Expanded(child: Center(child: vinyl)), const SizedBox(width: 64), Expanded(child: now)]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Center(child: vinyl), const SizedBox(height: 32), now]);
  }
}

/// The record: spins (5 s per turn) while sound plays and stops in place when it doesn't; the label carries the station (or the ad's art).
class _Vinyl extends StatefulWidget {
  const _Vinyl({required this.spinning, required this.label, required this.sub, this.imageUrl});

  final bool spinning;
  final String label;
  final String sub;
  final String? imageUrl;

  @override
  State<_Vinyl> createState() => _VinylState();
}

class _VinylState extends State<_Vinyl> with SingleTickerProviderStateMixin {
  late final AnimationController _spin = AnimationController(vsync: this, duration: const Duration(seconds: 5));
  bool _reduce = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduce = _reduceMotion(context);
    _sync();
  }

  @override
  void didUpdateWidget(_Vinyl old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    if (widget.spinning && !_reduce) {
      if (!_spin.isAnimating) _spin.repeat();
    } else {
      _spin.stop(); // keeps the angle: the record pauses in place
    }
  }

  @override
  void dispose() {
    _spin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AspectRatio(
      aspectRatio: 1,
      child: LayoutBuilder(builder: (context, box) {
        final d = box.maxWidth;
        return Stack(alignment: Alignment.center, children: [
          Positioned.fill(
            child: Padding(
              padding: EdgeInsets.all(d * 0.06),
              child: AnimatedOpacity(
                duration: const Duration(milliseconds: 800),
                opacity: widget.spinning ? 0.35 : 0.12,
                child: ImageFiltered(
                  imageFilter: ImageFilter.blur(sigmaX: 35, sigmaY: 35, tileMode: TileMode.decal),
                  child: const DecoratedBox(decoration: BoxDecoration(color: Rs.acc, shape: BoxShape.circle)),
                ),
              ),
            ),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: const BoxDecoration(shape: BoxShape.circle, boxShadow: [BoxShadow(color: Color(0x99000000), blurRadius: 80, offset: Offset(0, 30))]),
              child: RotationTransition(
                turns: _spin,
                child: CustomPaint(
                  painter: const _RecordPainter(),
                  child: Center(child: SizedBox.square(dimension: d * 0.36, child: _Label(label: widget.label, sub: widget.sub, imageUrl: widget.imageUrl))),
                ),
              ),
            ),
          ),
        ]);
      }),
    );
  }
}

class _RecordPainter extends CustomPainter {
  const _RecordPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final r = size.width / 2;
    canvas.drawCircle(center, r, Paint()..color = const Color(0xFF111413));
    final groove = Paint()
      ..color = const Color(0xFF191D1B)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (var rr = r * 0.34; rr < r; rr += 3) {
      canvas.drawCircle(center, rr, groove);
    }
    final rect = Rect.fromCircle(center: center, radius: r);
    canvas.drawCircle(
      center,
      r,
      Paint()
        ..shader = SweepGradient(
          transform: const GradientRotation(-pi / 2 + pi / 6),
          colors: [Colors.transparent, Colors.transparent, Colors.white.withValues(alpha: 0.07), Colors.transparent, Colors.transparent, Colors.white.withValues(alpha: 0.05), Colors.transparent],
          stops: const [0, 0.12, 0.16, 0.22, 0.62, 0.66, 0.72],
        ).createShader(rect),
    );
    canvas.drawCircle(
      center,
      r - 0.5,
      Paint()
        ..color = Rs.tint(0.06)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1,
    );
  }

  @override
  bool shouldRepaint(_RecordPainter old) => false;
}

class _Label extends StatelessWidget {
  const _Label({required this.label, required this.sub, this.imageUrl});

  final String label;
  final String sub;
  final String? imageUrl;

  @override
  Widget build(BuildContext context) {
    final plain = ColoredBox(
      color: Rs.acc,
      child: LayoutBuilder(builder: (context, box) {
        final w = box.maxWidth;
        return Padding(
          padding: EdgeInsets.all(w * 0.08),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            FittedBox(fit: BoxFit.scaleDown, child: Text(label, maxLines: 1, style: Rs.serifText((w * 0.15).clamp(12.0, 26.0), color: Rs.bg))),
            const SizedBox(height: 4),
            FittedBox(fit: BoxFit.scaleDown, child: Text(Rs.caps(sub), maxLines: 1, style: Rs.monoText(context, (w * 0.06).clamp(7.0, 9.0), color: Rs.bg, tracking: 0.14))),
            const SizedBox(height: 6),
            Container(width: 12, height: 12, decoration: const BoxDecoration(color: Rs.bg, shape: BoxShape.circle)),
          ]),
        );
      }),
    );
    final url = imageUrl;
    return ClipOval(child: url == null ? plain : Image.network(url, fit: BoxFit.cover, errorBuilder: (_, _, _) => plain));
  }
}

class _NowPlaying extends StatelessWidget {
  const _NowPlaying({required this.controller, required this.phone});

  final StationController controller;
  final bool phone;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final cur = c.current;
    final ad = cur != null && cur.isAd ? cur.ad : null;
    final onAir = cur != null && cur.onAir;
    final Widget heading;
    if (ad != null) {
      heading = _Heading(eyebrow: context.tr('player.ad'), title: ad.name);
    } else if (cur != null && cur.onAir) {
      heading = _Heading(eyebrow: context.tr('player.nowPlaying'), title: cur.title ?? c.title, artist: cur.artist, album: cur.album);
    } else if (cur == null && c.error == null) {
      heading = _HeadingSkeleton(eyebrow: context.tr('player.nowPlaying'));
    } else {
      heading = _Heading(eyebrow: context.tr('player.offAir'), waiting: context.tr(c.station?.live == false ? 'player.offline' : 'player.waiting'));
    }
    final link = ad?.linkUrl;
    final error = c.error;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      heading,
      if (onAir) ...[const SizedBox(height: 28), _Progress(position: c.position ?? 0, duration: cur?.duration)],
      if (ad != null && link != null) ...[const SizedBox(height: 28), _VisitButton(label: ad.ctaLabel ?? context.tr('player.learnMore'), onTap: () => openExternal(c.api.absolute(link)))],
      const SizedBox(height: 28),
      Wrap(spacing: 20, runSpacing: 12, crossAxisAlignment: WrapCrossAlignment.center, children: [
        _PlayPill(key: const Key('play'), playing: c.playing, busy: c.reconnecting, onPressed: c.station == null ? null : () => c.togglePlay()),
        _LyricsPill(on: c.showLyrics, onPressed: () => c.toggleLyrics()),
        if (!phone) _Volume(value: c.volume, onChanged: (v) => c.setVolume(v)),
      ]),
      if (error != null && !c.playing && !c.reconnecting)
        Padding(padding: const EdgeInsets.only(top: 12), child: Text(context.tr('player.error', {'error': error}), style: Rs.sansText(14, color: Rs.live))),
      const SizedBox(height: 28),
      _Stats(controller: c),
    ]);
  }
}

class _Heading extends StatelessWidget {
  const _Heading({required this.eyebrow, this.title, this.artist, this.album, this.waiting});

  final String eyebrow;
  final String? title;
  final String? artist;
  final String? album;
  final String? waiting;

  @override
  Widget build(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    final t = title;
    final len = t?.length ?? 0;
    // the display title is huge: long ones step down so they stay within two or three lines
    final size = len > 34 ? (w * 0.048).clamp(38.0, 64.0) : len > 16 ? (w * 0.065).clamp(48.0, 88.0) : (w * 0.09).clamp(64.0, 120.0);
    final a = artist;
    final al = album;
    final wait = waiting;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(Rs.caps(eyebrow), style: Rs.monoText(context, 12, color: Rs.acc, tracking: 0.14)),
      const SizedBox(height: 12),
      if (t != null) Text(t, style: Rs.serifText(size, height: 0.95).copyWith(letterSpacing: Rs.track(context, -0.02, size))),
      if (wait != null) Text(wait, style: Rs.serifText((w * 0.05).clamp(32.0, 56.0), color: Rs.ink2)),
      if (a != null || al != null) ...[
        const SizedBox(height: 12),
        Wrap(spacing: 10, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.end, children: [
          if (a != null) Text(a, style: Rs.sansText(20, weight: FontWeight.w600)),
          if (al != null) Text(al, style: Rs.sansText(14, color: Rs.muted2)),
        ]),
      ],
    ]);
  }
}

class _HeadingSkeleton extends StatelessWidget {
  const _HeadingSkeleton({required this.eyebrow});

  final String eyebrow;

  @override
  Widget build(BuildContext context) {
    Widget bar(double widthFactor, double height) => FractionallySizedBox(
          alignment: AlignmentDirectional.centerStart,
          widthFactor: widthFactor,
          child: Container(height: height, decoration: BoxDecoration(color: Rs.tint(0.05), borderRadius: BorderRadius.circular(10))),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(Rs.caps(eyebrow), style: Rs.monoText(context, 12, color: Rs.acc, tracking: 0.14)),
      const SizedBox(height: 12),
      bar(0.7, 64),
      const SizedBox(height: 12),
      bar(0.4, 20),
    ]);
  }
}

/// Display-only on live radio: where the station's timeline is in the track.
class _Progress extends StatelessWidget {
  const _Progress({required this.position, this.duration});

  final double position;
  final double? duration;

  @override
  Widget build(BuildContext context) {
    final d = duration;
    final pct = d != null && d > 0 ? (position / d).clamp(0.0, 1.0) : 0.0;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(
        height: 12,
        child: Stack(alignment: AlignmentDirectional.centerStart, children: [
          Container(height: 4, decoration: BoxDecoration(color: Rs.tint(0.1), borderRadius: BorderRadius.circular(4))),
          FractionallySizedBox(widthFactor: pct, child: Container(height: 4, decoration: BoxDecoration(color: Rs.acc, borderRadius: BorderRadius.circular(4)))),
          Align(alignment: AlignmentDirectional(-1 + 2 * pct, 0), child: Container(width: 12, height: 12, decoration: const BoxDecoration(color: Rs.ink, shape: BoxShape.circle))),
        ]),
      ),
      const SizedBox(height: 10),
      Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        Text(mmss(position), style: Rs.monoText(context, 12, color: Rs.muted2)),
        Text(mmss(d), style: Rs.monoText(context, 12, color: Rs.muted2)),
      ]),
    ]);
  }
}

/// "Listen live" / "Pause": accent pill holding a dark disc with the icon (a ring spins around it while reconnecting).
class _PlayPill extends StatelessWidget {
  const _PlayPill({super.key, required this.playing, required this.busy, required this.onPressed, this.compact = false});

  final bool playing;
  final bool busy;
  final VoidCallback? onPressed;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final label = playing ? context.tr('player.pause') : context.tr('player.listen');
    final disc = SizedBox(
      width: 44,
      height: 44,
      child: Stack(alignment: Alignment.center, clipBehavior: Clip.none, children: [
        Container(decoration: const BoxDecoration(color: Rs.bg, shape: BoxShape.circle)),
        // media icons are not mirrored in RTL: play always points right
        Icon(playing ? Icons.pause_rounded : Icons.play_arrow_rounded, color: Rs.acc, size: 26),
        if (busy) const Positioned(left: -4, top: -4, right: -4, bottom: -4, child: CircularProgressIndicator(strokeWidth: 2, color: Rs.bg)),
      ]),
    );
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: Opacity(
        opacity: onPressed == null ? 0.5 : 1,
        child: Material(
          color: Rs.acc,
          shape: const StadiumBorder(),
          child: InkWell(
            customBorder: const StadiumBorder(),
            onTap: onPressed,
            child: SizedBox(
              height: compact ? 48 : 64,
              child: Padding(
                padding: compact ? const EdgeInsets.all(2) : const EdgeInsetsDirectional.only(start: 10, end: 28),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  disc,
                  if (!compact) ...[const SizedBox(width: 14), Text(label, style: Rs.sansText(17, color: Rs.bg, weight: FontWeight.w700))],
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LyricsPill extends StatelessWidget {
  const _LyricsPill({required this.on, required this.onPressed});

  final bool on;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final color = on ? Rs.acc : Rs.ink;
    return Semantics(
      toggled: on,
      child: Material(
        color: Colors.transparent,
        shape: StadiumBorder(side: BorderSide(color: on ? Rs.acc : Rs.tint(0.14))),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onPressed,
          child: SizedBox(
            height: 44,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Text('“', style: Rs.serifText(20, color: color)),
                const SizedBox(width: 8),
                Text(context.tr('player.lyrics'), style: Rs.sansText(14, color: color, weight: FontWeight.w600)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Desktop only: phones use the hardware volume buttons.
class _Volume extends StatelessWidget {
  const _Volume({required this.value, required this.onChanged});

  final double value;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: 200,
        child: Row(children: [
          Text(Rs.caps(context.tr('player.vol')), style: Rs.monoText(context, 11, color: Rs.muted2, tracking: 0.08)),
          Expanded(child: Slider(value: value, onChanged: onChanged, semanticFormatterCallback: (v) => '${context.tr('player.volume')} ${(v * 100).round()}%')),
        ]),
      );
}

class _Stats extends StatelessWidget {
  const _Stats({required this.controller});

  final StationController controller;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final style = Rs.monoText(context, 12);
    Widget stat(Widget dot, String text) => Row(mainAxisSize: MainAxisSize.min, children: [dot, const SizedBox(width: 8), Text(text, style: style)]);
    final listeners = c.listeners;
    final clients = c.clients;
    return Wrap(spacing: 24, runSpacing: 8, children: [
      if (listeners != null) stat(const _Dot(Rs.acc), context.tr('player.listeners', {'n': listeners})),
      if (clients != null && clients > 0) stat(const _Dot(Rs.muted, ring: true), context.tr('player.online', {'n': clients})),
      if (c.offersLow)
        Text(
          Rs.caps(c.lowActive ? context.tr('player.lowBadge') : c.pref == QualityPref.auto ? context.tr('player.qualityAutoLabel') : context.tr('player.qualityHighLabel')),
          style: style,
        ),
    ]);
  }
}

// ---------------------------------------------------------------- visualizer

/// 64 bars under the hero. The app has no access to the decoded audio, so playing shows a lively envelope; paused, a low idle wave.
class _Visualizer extends StatefulWidget {
  const _Visualizer({required this.playing});

  final bool playing;

  @override
  State<_Visualizer> createState() => _VisualizerState();
}

class _VisualizerState extends State<_Visualizer> with SingleTickerProviderStateMixin {
  static const _bars = 64;
  late final Ticker _ticker;
  List<double> _shown = List.filled(_bars, 0.06);
  List<double> _target = List.filled(_bars, 0.06);
  Duration _last = Duration.zero;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_onTick);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduce = _reduceMotion(context);
    if (!reduce && !_ticker.isActive) _ticker.start();
    if (reduce && _ticker.isActive) _ticker.stop();
  }

  void _onTick(Duration elapsed) {
    // a new target every 120 ms (like the design), eased towards on every frame
    if (elapsed - _last >= const Duration(milliseconds: 120)) {
      _last = elapsed;
      _target = vizLevels(_bars, playing: widget.playing, tMs: elapsed.inMilliseconds.toDouble());
    }
    setState(() => _shown = [for (var i = 0; i < _bars; i++) _shown[i] + (_target[i] - _shown[i]) * 0.35]);
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Container(
        height: 120,
        padding: const EdgeInsets.symmetric(horizontal: 2),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: Rs.tint(0.1)))),
        child: CustomPaint(painter: _BarsPainter(_shown), size: Size.infinite),
      );
}

class _BarsPainter extends CustomPainter {
  _BarsPainter(this.levels);

  final List<double> levels;

  @override
  void paint(Canvas canvas, Size size) {
    const gap = 3.0;
    final n = levels.length;
    final w = max(1.0, (size.width - gap * (n - 1)) / n);
    for (var i = 0; i < n; i++) {
      final v = levels[i];
      final h = max(0.03, v) * size.height;
      final rect = RRect.fromRectAndCorners(Rect.fromLTWH(i * (w + gap), size.height - h, w, h), topLeft: const Radius.circular(2), topRight: const Radius.circular(2));
      canvas.drawRRect(rect, Paint()..color = Rs.acc.withValues(alpha: (0.35 + 0.65 * v).clamp(0.0, 1.0)));
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) => !identical(old.levels, levels);
}

// ---------------------------------------------------------------- lyrics

class _LyricsCard extends StatelessWidget {
  const _LyricsCard({required this.controller, required this.side, required this.viewportHeight});

  final StationController controller;
  final double side;
  final double viewportHeight;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final l = c.lyrics;
    final cur = c.current;
    final rows = l != null && l.synced ? lyricRows(l.lines, duration: cur?.duration) : const <LyricRow>[];
    final pos = c.position;
    final active = pos == null ? -1 : activeRowIndex(rows, pos);
    final syncing = (l == null && cur?.trackId != null) || l?.status == 'PENDING' || l?.status == 'PROCESSING';
    final plain = l != null && !l.synced ? l.plain : const <String>[];
    final String? status = rows.isNotEmpty
        ? (c.sounding ? context.tr('player.lyricsLive') : context.tr('player.lyricsPaused'))
        : plain.isNotEmpty
            ? context.tr('player.lyricsPlain')
            : syncing
                ? context.tr('player.lyricsSyncing')
                : null;
    final title = cur != null && cur.onAir ? cur.title : null;
    final artist = cur?.artist;

    final Widget body;
    if (rows.isNotEmpty) {
      body = _LyricsViewport(rows: rows, active: active, positionOf: () => c.position ?? 0, height: viewportHeight);
    } else if (plain.isNotEmpty) {
      body = ConstrainedBox(
        constraints: BoxConstraints(maxHeight: viewportHeight),
        child: SingleChildScrollView(
          child: Column(children: [
            for (final p in plain) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text(p, textAlign: TextAlign.center, style: Rs.serifText(22, color: Rs.ink2, height: 1.4))),
          ]),
        ),
      );
    } else if (syncing) {
      Widget bar(double f) => FractionallySizedBox(widthFactor: f, child: Container(height: 28, decoration: BoxDecoration(color: Rs.tint(0.05), borderRadius: BorderRadius.circular(8))));
      body = Padding(padding: const EdgeInsets.symmetric(vertical: 40), child: Column(children: [bar(0.46), const SizedBox(height: 30), bar(0.62), const SizedBox(height: 30), bar(0.38)]));
    } else {
      body = Padding(padding: const EdgeInsets.symmetric(vertical: 48), child: Text(context.tr('player.noLyrics'), textAlign: TextAlign.center, style: Rs.serifText(22, color: Rs.muted2, height: 1.2)));
    }

    return Container(
      padding: EdgeInsets.symmetric(vertical: 24, horizontal: side),
      decoration: BoxDecoration(color: Rs.tint(0.025), border: Border.all(color: Rs.tint(0.08)), borderRadius: BorderRadius.circular(24)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Wrap(alignment: WrapAlignment.spaceBetween, crossAxisAlignment: WrapCrossAlignment.center, spacing: 12, runSpacing: 8, children: [
          Wrap(spacing: 14, crossAxisAlignment: WrapCrossAlignment.end, children: [
            Text(context.tr('player.lyrics'), style: Rs.serifText(30)),
            if (title != null) Text(artist != null ? '$title — $artist' : title, style: Rs.sansText(14, color: Rs.muted2)),
          ]),
          if (status != null)
            Row(mainAxisSize: MainAxisSize.min, children: [
              _Dot(rows.isNotEmpty && c.sounding ? Rs.acc : Rs.muted2),
              const SizedBox(width: 8),
              Text(Rs.caps(status), style: Rs.monoText(context, 11, tracking: 0.1)),
            ]),
        ]),
        const SizedBox(height: 8),
        body,
      ]),
    );
  }
}

/// Fixed 68 px rows; the active one is centred (eased scroll) and swept with the accent, the others fade, shrink and blur with distance.
class _LyricsViewport extends StatelessWidget {
  const _LyricsViewport({required this.rows, required this.active, required this.positionOf, required this.height});

  static const rowHeight = 68.0;

  final List<LyricRow> rows;
  final int active;
  final double Function() positionOf;
  final double height;

  @override
  Widget build(BuildContext context) {
    final fontSize = (MediaQuery.sizeOf(context).width * 0.04).clamp(26.0, 44.0);
    final target = height / 2 - max(0, active) * rowHeight - rowHeight / 2;
    return SizedBox(
      height: height,
      child: ClipRect(
        child: ShaderMask(
          blendMode: BlendMode.dstIn,
          shaderCallback: (r) => const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Colors.transparent, Colors.black, Colors.black, Colors.transparent],
            stops: [0, 0.28, 0.72, 1],
          ).createShader(r),
          child: TweenAnimationBuilder<double>(
            tween: Tween(end: target),
            duration: _reduceMotion(context) ? Duration.zero : const Duration(milliseconds: 600),
            curve: const Cubic(0.2, 0.7, 0.2, 1),
            builder: (context, offset, child) => Stack(clipBehavior: Clip.hardEdge, children: [Positioned(left: 0, right: 0, top: offset, child: child!)]),
            child: Column(children: [
              for (var i = 0; i < rows.length; i++) _LyricRowView(row: rows[i], distance: active < 0 ? i + 1 : i - active, positionOf: positionOf, fontSize: fontSize),
            ]),
          ),
        ),
      ),
    );
  }
}

class _LyricRowView extends StatelessWidget {
  const _LyricRowView({required this.row, required this.distance, required this.positionOf, required this.fontSize});

  final LyricRow row;
  final int distance;
  final double Function() positionOf;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    Widget line = Text(row.gap ? '• • •' : row.text, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: Rs.serifText(fontSize, height: 1.1));
    if (row.gap) line = Semantics(label: context.tr('player.instrumental'), excludeSemantics: true, child: line);
    if (distance == 0) {
      line = _Karaoke(row: row, positionOf: positionOf, child: line);
    } else if (distance.abs() > 2) {
      line = ImageFiltered(imageFilter: ImageFilter.blur(sigmaX: 1, sigmaY: 1), child: line);
    }
    return SizedBox(
      height: _LyricsViewport.rowHeight,
      child: Center(
        child: AnimatedOpacity(
          duration: const Duration(milliseconds: 500),
          opacity: distance == 0 ? 1 : max(0.12, 0.5 - distance.abs() * 0.12),
          child: AnimatedScale(duration: const Duration(milliseconds: 500), scale: distance == 0 ? 1 : 0.94, child: Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: line)),
        ),
      ),
    );
  }
}

/// The accent sweeps across the line being sung (right to left in Persian), redrawn every frame from the server timeline.
class _Karaoke extends StatefulWidget {
  const _Karaoke({required this.row, required this.positionOf, required this.child});

  final LyricRow row;
  final double Function() positionOf;
  final Widget child;

  @override
  State<_Karaoke> createState() => _KaraokeState();
}

class _KaraokeState extends State<_Karaoke> with SingleTickerProviderStateMixin {
  late final Ticker _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker((_) {
      if (mounted) setState(() {});
    })
      ..start();
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final fill = karaokeFill(widget.row, widget.positionOf());
    final rtl = Directionality.of(context) == TextDirection.rtl;
    final dim = Rs.tint(0.4);
    return ShaderMask(
      blendMode: BlendMode.srcIn,
      shaderCallback: (r) => LinearGradient(
        begin: rtl ? Alignment.centerRight : Alignment.centerLeft,
        end: rtl ? Alignment.centerLeft : Alignment.centerRight,
        colors: [Rs.acc, Rs.acc, dim, dim],
        stops: [0, fill, fill, 1],
      ).createShader(r),
      child: widget.child,
    );
  }
}

// ---------------------------------------------------------------- vote + sponsor

class _Card extends StatelessWidget {
  const _Card({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(color: Rs.tint(0.035), border: Border.all(color: Rs.tint(0.08)), borderRadius: BorderRadius.circular(20)),
        child: child,
      );
}

class _VoteAndSponsor extends StatelessWidget {
  const _VoteAndSponsor({required this.controller, required this.wide, required this.showVote});

  final StationController controller;
  final bool wide;
  final bool showVote;

  @override
  Widget build(BuildContext context) {
    final cards = <Widget>[if (showVote) _VoteCard(controller: controller), if (controller.sponsors.isNotEmpty) _SponsorCard(controller: controller)];
    if (wide && cards.length == 2) {
      return IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Expanded(child: cards[0]), const SizedBox(width: 20), Expanded(child: cards[1])]));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (var i = 0; i < cards.length; i++) ...[if (i > 0) const SizedBox(height: 20), cards[i]],
    ]);
  }
}

class _VoteCard extends StatelessWidget {
  const _VoteCard({required this.controller});

  final StationController controller;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final v = c.vote;
    final winner = v.winner;
    if (!v.open && v.status == 'PLAYING' && winner != null) {
      final until = v.playUntil;
      final left = until == null ? null : until.difference(c.serverNow).inMilliseconds / 1000;
      return _Card(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(Rs.caps(context.tr('player.voteChosen')), style: Rs.monoText(context, 12, color: Rs.acc, tracking: 0.14)),
          const SizedBox(height: 12),
          Text(context.tr('player.voteWinner', {'tag': '#$winner'}), style: Rs.serifText(30)),
          if (left != null) ...[const SizedBox(height: 12), Text(context.tr('player.voteTimeLeft', {'time': mmss(max(0.0, left))}), style: Rs.sansText(13, color: Rs.muted2))],
        ]),
      );
    }
    final shares = voteShares([for (final o in v.options) o.votes]);
    final total = v.options.fold(0, (a, o) => a + o.votes);
    final closes = v.closesAt;
    final left = closes == null ? null : max(0.0, closes.difference(c.serverNow).inMilliseconds / 1000);
    String votesLabel(int n) => n == 1 ? context.tr('player.oneVote') : context.tr('player.votes', {'n': n});
    return _Card(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Wrap(alignment: WrapAlignment.spaceBetween, crossAxisAlignment: WrapCrossAlignment.end, spacing: 12, runSpacing: 6, children: [
          Text(context.tr('player.vote'), style: Rs.serifText(30)),
          if (left != null) _closesIn(context, mmss(left)),
        ]),
        const SizedBox(height: 18),
        for (var i = 0; i < v.options.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: _VoteOption(
              tag: v.options[i].hashtag,
              share: shares[i],
              label: total > 0 ? context.tr('player.result', {'pct': shares[i], 'votes': votesLabel(v.options[i].votes)}) : votesLabel(0),
              mine: v.myVote == v.options[i].hashtag,
              onTap: () => c.castVote(v.options[i].hashtag),
            ),
          ),
        const SizedBox(height: 8),
        Text(v.myVote != null ? context.tr('player.voteCounted') : context.tr('player.voteHint'), style: Rs.sansText(13, color: Rs.muted2)),
      ]),
    );
  }

  /// "closes in 00:30" with the time in the accent colour, whatever the word order of the language.
  Widget _closesIn(BuildContext context, String time) {
    final parts = context.tr('player.closesIn').split('{time}');
    final style = Rs.monoText(context, 12);
    return Text.rich(TextSpan(style: style, children: [
      TextSpan(text: parts.first),
      TextSpan(text: time, style: style.copyWith(color: Rs.acc, fontWeight: FontWeight.w500)),
      if (parts.length > 1) TextSpan(text: parts[1]),
    ]));
  }
}

final _rtlScript = RegExp(r'[֐-ࣿ]');

class _VoteOption extends StatelessWidget {
  const _VoteOption({required this.tag, required this.share, required this.label, required this.mine, required this.onTap});

  final String tag;
  final int share;
  final String label;
  final bool mine;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final rtlUi = Directionality.of(context) == TextDirection.rtl;
    return Material(
      color: Rs.tint(0.03),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: mine ? Rs.acc : Rs.tint(0.1))),
      child: InkWell(
        onTap: onTap,
        child: Stack(children: [
          Positioned.fill(
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: AnimatedFractionallySizedBox(duration: const Duration(milliseconds: 400), widthFactor: share / 100, heightFactor: 1, child: ColoredBox(color: Rs.acc.withValues(alpha: 0.16))),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
            child: Row(children: [
              // a Latin tag keeps its "#" in front in a Persian UI (and a Persian one reads right to left)
              Expanded(
                child: Text('#$tag',
                    textDirection: _rtlScript.hasMatch(tag) ? TextDirection.rtl : TextDirection.ltr,
                    textAlign: rtlUi ? TextAlign.right : TextAlign.left,
                    style: Rs.sansText(15, weight: FontWeight.w600)),
              ),
              const SizedBox(width: 12),
              Text(label, style: Rs.monoText(context, 12)),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _SponsorCard extends StatelessWidget {
  const _SponsorCard({required this.controller});

  final StationController controller;

  @override
  Widget build(BuildContext context) {
    final s = controller.sponsors.first;
    final logo = s.logoUrl;
    final tagline = s.tagline;
    final placeholder = Container(
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment(-1, -1),
          end: Alignment(-0.82, -0.82),
          colors: [Color(0xFF1A1E1C), Color(0xFF1A1E1C), Color(0xFF151816), Color(0xFF151816)],
          stops: [0, 0.5, 0.5, 1],
          tileMode: TileMode.repeated,
        ),
        border: Border.all(color: Rs.tint(0.1)),
        borderRadius: BorderRadius.circular(14),
      ),
    );
    return _Card(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        Text(Rs.caps(context.tr('player.sponsor')), style: Rs.monoText(context, 11, color: Rs.muted2, tracking: 0.14)),
        const SizedBox(height: 20),
        Row(children: [
          SizedBox.square(
            dimension: 64,
            child: logo == null
                ? placeholder
                : ClipRRect(borderRadius: BorderRadius.circular(14), child: Image.network(controller.api.absolute(logo).toString(), fit: BoxFit.cover, errorBuilder: (_, _, _) => placeholder)),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(s.name, style: Rs.sansText(17, weight: FontWeight.w700)),
              if (tagline != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(tagline, style: Rs.sansText(14, color: Rs.muted))),
            ]),
          ),
        ]),
        const SizedBox(height: 20),
        _VisitButton(label: s.ctaLabel, onTap: () => openExternal(controller.api.absolute(s.url))),
      ]),
    );
  }
}

/// Full-width outline link "Visit sponsor →" (the arrow follows the reading direction).
class _VisitButton extends StatelessWidget {
  const _VisitButton({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(
          foregroundColor: Rs.ink,
          side: BorderSide(color: Rs.tint(0.14)),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
        ),
        child: Row(children: [
          Expanded(child: Text(label, style: Rs.sansText(14, weight: FontWeight.w600))),
          const Icon(Icons.arrow_forward, size: 18),
        ]),
      );
}

/// Phones: a mini player pinned to the bottom once the hero has scrolled away.
class _MiniPlayer extends StatelessWidget {
  const _MiniPlayer({required this.controller});

  final StationController controller;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final cur = c.current;
    final ad = cur != null && cur.isAd ? cur.ad : null;
    final title = ad?.name ?? cur?.title ?? c.title;
    final sub = ad != null ? context.tr('player.ad') : (cur?.artist ?? '');
    return Container(
      padding: const EdgeInsetsDirectional.fromSTEB(16, 6, 6, 6),
      decoration: BoxDecoration(
        color: const Color(0xEB121514),
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: Rs.tint(0.12)),
        boxShadow: const [BoxShadow(color: Color(0x80000000), blurRadius: 40, offset: Offset(0, 16))],
      ),
      child: Row(children: [
        Expanded(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: Rs.sansText(15, weight: FontWeight.w700)),
            if (sub.isNotEmpty) Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: Rs.sansText(13, color: Rs.muted)),
          ]),
        ),
        const SizedBox(width: 12),
        _PlayPill(key: const Key('mini-play'), playing: c.playing, busy: c.reconnecting, compact: true, onPressed: c.station == null ? null : () => c.togglePlay()),
      ]),
    );
  }
}
