import 'package:flutter/material.dart';

import '../data/models.dart';
import '../domain/quality.dart';
import '../l10n/strings.dart';
import '../state/station_controller.dart';
import 'common.dart';

/// One station: big play button, what is on air, synchronized lyrics, announcements, vote, sponsor / ad.
/// With [locked] (opened from a station link) there is no way back to the other stations.
class PlayerScreen extends StatefulWidget {
  const PlayerScreen({super.key, required this.controller, this.locked = false, this.onChangeServer});

  final StationController controller;
  final bool locked;
  final VoidCallback? onChangeServer;

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  StationController get c => widget.controller;
  final ScrollController _scroll = ScrollController();
  int _lastLine = -2;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _followLine(int line) {
    if (line == _lastLine || line < 0 || !_scroll.hasClients) return;
    _lastLine = line;
    final target = (line * 44.0 - 80).clamp(0.0, _scroll.position.maxScrollExtent);
    _scroll.animateTo(target, duration: const Duration(milliseconds: 350), curve: Curves.easeOut);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final cur = c.current;
        final hue = hueOf(cur?.trackId ?? cur?.title ?? c.slug);
        return Scaffold(
          extendBodyBehindAppBar: true,
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            elevation: 0,
            automaticallyImplyLeading: !widget.locked,
            title: Text('🌧 ${c.title}', style: const TextStyle(fontWeight: FontWeight.w800)),
            actions: [
              if (c.offersLow) _QualityMenu(controller: c),
              if (widget.locked && widget.onChangeServer != null) IconButton(tooltip: context.tr('stations.changeServer'), icon: const Icon(Icons.dns_outlined), onPressed: widget.onChangeServer),
            ],
          ),
          body: Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [accent(hue, lightness: 0.3), const Color(0xFF0B0D13), accent(hue + 70, lightness: 0.22)]),
            ),
            child: SafeArea(
              child: c.notFound
                  ? Center(child: Text(context.tr('player.notFound'), style: const TextStyle(color: Colors.white)))
                  : DefaultTextStyle.merge(
                      style: const TextStyle(color: Colors.white),
                      child: ListView(
                        controller: _scroll,
                        padding: const EdgeInsets.fromLTRB(20, 56, 20, 32),
                        children: [
                          for (final m in c.messages) _MessageBanner(m),
                          const SizedBox(height: 8),
                          _NowPlaying(controller: c, hue: hue),
                          const SizedBox(height: 16),
                          if (cur?.isAd == true) _AdCard(controller: c, ad: cur!.ad!) else _LyricsView(controller: c, onLine: _followLine),
                          if (c.vote.open) _VoteCard(controller: c),
                          if (c.sponsors.isNotEmpty) _SponsorCard(controller: c),
                        ],
                      ),
                    ),
            ),
          ),
        );
      },
    );
  }
}

class _NowPlaying extends StatelessWidget {
  const _NowPlaying({required this.controller, required this.hue});

  final StationController controller;
  final int hue;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    final cur = c.current;
    final onAir = cur != null && (cur.onAir || cur.isAd);
    final title = cur?.isAd == true ? cur!.ad!.name : (cur?.title ?? c.title);
    final sub = cur?.isAd == true ? context.tr('player.ad') : (cur?.artist ?? '');
    return Column(children: [
      EqualizerBars(playing: c.playing && onAir, color: accent(hue, lightness: 0.8)),
      const SizedBox(height: 18),
      Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w800)),
      if (sub.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(sub, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70, fontSize: 16))),
      const SizedBox(height: 20),
      SizedBox(
        width: 84,
        height: 84,
        child: FilledButton(
          style: FilledButton.styleFrom(shape: const CircleBorder(), padding: EdgeInsets.zero, backgroundColor: accent(hue)),
          onPressed: c.station == null ? null : c.togglePlay,
          child: Semantics(label: c.playing ? context.tr('player.pause') : context.tr('player.listen'), child: Icon(c.playing ? Icons.stop_rounded : Icons.play_arrow_rounded, size: 46, color: Colors.black87)),
        ),
      ),
      const SizedBox(height: 10),
      Text(c.playing ? context.tr('player.pause') : context.tr('player.listen'), style: const TextStyle(color: Colors.white70)),
      const SizedBox(height: 6),
      Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 4, children: [
        if (c.listeners != null) _Pill(context.tr('player.listeners', {'n': c.listeners!})),
        if (c.playing && c.lowActive) _Pill('🐢 ${context.tr('player.lowBadge')}'),
      ]),
      if (!onAir && c.station != null && !(c.station!.live)) Padding(padding: const EdgeInsets.only(top: 10), child: Text(context.tr('player.offline'), style: const TextStyle(color: Colors.white70))),
      if (c.error != null && !c.playing)
        Padding(padding: const EdgeInsets.only(top: 10), child: Text(context.tr('player.error', {'error': c.error!}), textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFFFFB4AB)))),
    ]);
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        decoration: BoxDecoration(color: Colors.white12, borderRadius: BorderRadius.circular(99)),
        child: Text(text, style: const TextStyle(fontSize: 12, color: Colors.white70)),
      );
}

class _MessageBanner extends StatelessWidget {
  const _MessageBanner(this.message);

  final LiveMessage message;

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: message.warn ? const Color(0x33FFB020) : const Color(0x22FFFFFF), borderRadius: BorderRadius.circular(14)),
        child: Row(children: [Icon(message.warn ? Icons.warning_amber_rounded : Icons.campaign_outlined, size: 20), const SizedBox(width: 10), Expanded(child: Text(message.text))]),
      );
}

/// Lyrics: the line being sung is highlighted (from the server clock) and kept in view.
class _LyricsView extends StatelessWidget {
  const _LyricsView({required this.controller, required this.onLine});

  final StationController controller;
  final void Function(int line) onLine;

  @override
  Widget build(BuildContext context) {
    final l = controller.lyrics;
    if (l == null || !l.hasText) {
      return controller.current?.onAir == true ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(context.tr('player.noLyrics'), style: const TextStyle(color: Colors.white54)))) : const SizedBox.shrink();
    }
    if (!l.synced) {
      return Column(children: [for (final line in l.plain) Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text(line, textAlign: TextAlign.center, style: const TextStyle(fontSize: 17, color: Colors.white70)))]);
    }
    // the highlighted line follows the clock: refresh twice a second without any network traffic
    return StreamBuilder<int>(
      stream: Stream.periodic(const Duration(milliseconds: 500), (i) => i),
      builder: (context, _) {
        final active = controller.activeLine;
        WidgetsBinding.instance.addPostFrameCallback((_) => onLine(active));
        return Column(children: [
          for (var i = 0; i < l.lines.length; i++)
            AnimatedDefaultTextStyle(
              duration: const Duration(milliseconds: 250),
              style: TextStyle(fontSize: i == active ? 22 : 17, fontWeight: i == active ? FontWeight.w800 : FontWeight.w400, color: i == active ? Colors.white : Colors.white38, height: 1.5),
              child: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text(l.lines[i].text, textAlign: TextAlign.center)),
            ),
        ]);
      },
    );
  }
}

class _AdCard extends StatelessWidget {
  const _AdCard({required this.controller, required this.ad});

  final StationController controller;
  final AdOnAir ad;

  @override
  Widget build(BuildContext context) {
    final c = controller;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(20)),
      child: Column(children: [
        Text(context.tr('player.ad'), style: const TextStyle(color: Colors.white54, fontSize: 12, letterSpacing: 1)),
        if (ad.imageUrl != null)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: ClipRRect(borderRadius: BorderRadius.circular(14), child: Image.network(c.api.absolute(ad.imageUrl!).toString(), fit: BoxFit.contain, errorBuilder: (_, _, _) => const SizedBox.shrink())),
          ),
        if (ad.linkUrl != null)
          Padding(padding: const EdgeInsets.only(top: 12), child: FilledButton(onPressed: () => openExternal(c.api.absolute(ad.linkUrl!)), child: Text(ad.ctaLabel ?? ad.name))),
      ]),
    );
  }
}

class _SponsorCard extends StatelessWidget {
  const _SponsorCard({required this.controller});

  final StationController controller;

  @override
  Widget build(BuildContext context) {
    final s = controller.sponsors.first;
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(20)),
        child: Row(children: [
          if (s.logoUrl != null)
            Padding(
              padding: const EdgeInsetsDirectional.only(end: 12),
              child: ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.network(controller.api.absolute(s.logoUrl!).toString(), width: 44, height: 44, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox(width: 44, height: 44))),
            ),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(context.tr('player.sponsor'), style: const TextStyle(fontSize: 11, color: Colors.white54)),
              Text(s.name, style: const TextStyle(fontWeight: FontWeight.w700)),
              if (s.tagline != null) Text(s.tagline!, style: const TextStyle(color: Colors.white70, fontSize: 13)),
            ]),
          ),
          TextButton(onPressed: () => openExternal(controller.api.absolute(s.url)), child: Text(s.ctaLabel)),
        ]),
      ),
    );
  }
}

class _VoteCard extends StatelessWidget {
  const _VoteCard({required this.controller});

  final StationController controller;

  @override
  Widget build(BuildContext context) {
    final v = controller.vote;
    final total = v.totalVotes == 0 ? 1 : v.totalVotes;
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(20)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(context.tr('player.vote'), style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          for (final o in v.options)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => controller.castVote(o.hashtag),
                child: Stack(children: [
                  ClipRRect(borderRadius: BorderRadius.circular(12), child: LinearProgressIndicator(value: o.votes / total, minHeight: 42, backgroundColor: Colors.white10, color: o.hashtag == v.myVote ? Colors.white38 : Colors.white24)),
                  Positioned.fill(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Row(children: [
                        Expanded(child: Text('#${o.hashtag}', style: TextStyle(fontWeight: o.hashtag == v.myVote ? FontWeight.w800 : FontWeight.w500))),
                        Text(context.tr('player.votes', {'n': o.votes}), style: const TextStyle(fontSize: 12, color: Colors.white70)),
                      ]),
                    ),
                  ),
                ]),
              ),
            ),
        ]),
      ),
    );
  }
}

class _QualityMenu extends StatelessWidget {
  const _QualityMenu({required this.controller});

  final StationController controller;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<QualityPref>(
      tooltip: context.tr('player.quality'),
      icon: const Icon(Icons.network_check),
      initialValue: controller.pref,
      onSelected: controller.setQuality,
      itemBuilder: (_) => [
        PopupMenuItem(value: QualityPref.auto, child: Text(context.tr('player.qualityAuto'))),
        PopupMenuItem(value: QualityPref.high, child: Text(context.tr('player.qualityHigh'))),
        PopupMenuItem(value: QualityPref.low, child: Text(context.tr('player.qualityLow'))),
      ],
    );
  }
}
