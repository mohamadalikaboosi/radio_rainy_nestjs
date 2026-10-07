import 'package:flutter/material.dart';

import '../data/models.dart';
import '../l10n/strings.dart';
import '../state/stations_controller.dart';
import 'theme.dart';

/// The landing page of the app: every station, on-air ones first, with what each plays now.
class StationsScreen extends StatelessWidget {
  const StationsScreen({super.key, required this.controller, required this.onOpen, required this.onChangeServer, required this.onLanguage, required this.language});

  final StationsController controller;
  final void Function(Station station) onOpen;
  final VoidCallback onChangeServer;
  final void Function(String? code) onLanguage;
  final String? language;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Rs.bg,
      appBar: AppBar(
        title: Text(context.tr('app.title'), style: Rs.sansText(17, weight: FontWeight.w700)),
        actions: [
          PopupMenuButton<String>(
            tooltip: context.tr('stations.language'),
            icon: const Icon(Icons.language),
            onSelected: (v) => onLanguage(v == 'auto' ? null : v),
            itemBuilder: (_) => [
              CheckedPopupMenuItem(value: 'auto', checked: language == null, child: Text(context.tr('stations.langAuto'))),
              CheckedPopupMenuItem(value: 'en', checked: language == 'en', child: const Text('English')),
              CheckedPopupMenuItem(value: 'fa', checked: language == 'fa', child: const Text('فارسی')),
            ],
          ),
          IconButton(tooltip: context.tr('stations.changeServer'), icon: const Icon(Icons.dns_outlined), onPressed: onChangeServer),
        ],
      ),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          if (controller.loading) return const Center(child: CircularProgressIndicator());
          if (controller.stations.isEmpty) {
            return RefreshIndicator(
              onRefresh: controller.refresh,
              child: ListView(children: [
                const SizedBox(height: 120),
                Center(child: Text(controller.error ?? context.tr('stations.empty'))),
                if (controller.error != null) Center(child: TextButton(onPressed: controller.refresh, child: Text(context.tr('common.retry')))),
              ]),
            );
          }
          return RefreshIndicator(
            onRefresh: controller.refresh,
            child: ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: controller.stations.length,
              separatorBuilder: (_, _) => const SizedBox(height: 12),
              itemBuilder: (context, i) => _StationCard(station: controller.stations[i], now: controller.nowPlaying[controller.stations[i].slug], onTap: () => onOpen(controller.stations[i])),
            ),
          );
        },
      ),
    );
  }
}

class _StationCard extends StatelessWidget {
  const _StationCard({required this.station, required this.now, required this.onTap});

  final Station station;
  final Current? now;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final subtitle = station.live
        ? (now?.title != null ? '${now!.title}${now!.artist != null ? ' — ${now!.artist}' : ''}' : context.tr('stations.tune'))
        : context.tr('stations.offAir');
    return Material(
      color: Rs.tint(0.035),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20), side: BorderSide(color: Rs.tint(0.08))),
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            // the record label of the design: accent when on air
            Container(
              width: 46,
              height: 46,
              alignment: Alignment.center,
              decoration: BoxDecoration(shape: BoxShape.circle, color: station.live ? Rs.acc : Rs.tint(0.08)),
              child: Container(width: 10, height: 10, decoration: BoxDecoration(shape: BoxShape.circle, color: station.live ? Rs.bg : Rs.muted2)),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(station.title, style: Rs.sansText(17, weight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: Rs.sansText(14, color: Rs.muted)),
              ]),
            ),
            if (station.live)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(border: Border.all(color: Rs.tint(0.14)), borderRadius: BorderRadius.circular(99)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(width: 6, height: 6, decoration: const BoxDecoration(color: Rs.live, shape: BoxShape.circle)),
                  const SizedBox(width: 7),
                  Text(context.tr('stations.onAir'), style: Rs.monoText(context, 11, color: Rs.ink2, tracking: 0.08)),
                ]),
              ),
          ]),
        ),
      ),
    );
  }
}
