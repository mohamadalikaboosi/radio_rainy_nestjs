import 'package:flutter/material.dart';

import '../data/models.dart';
import '../l10n/strings.dart';
import '../state/stations_controller.dart';
import 'common.dart';

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
      appBar: AppBar(
        title: Text('🌧 ${context.tr('app.title')}'),
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
    final hue = hueOf(station.slug);
    final subtitle = station.live
        ? (now?.title != null ? '${now!.title}${now!.artist != null ? ' — ${now!.artist}' : ''}' : context.tr('stations.tune'))
        : context.tr('stations.offAir');
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: onTap,
        child: Ink(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(20),
            gradient: LinearGradient(colors: [accent(hue, lightness: 0.28), accent(hue + 55, lightness: 0.2)]),
          ),
          padding: const EdgeInsets.all(16),
          child: Row(children: [
            CircleAvatar(radius: 26, backgroundColor: Colors.white24, child: Icon(station.live ? Icons.graphic_eq : Icons.radio, color: Colors.white)),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(station.title, style: Theme.of(context).textTheme.titleMedium?.copyWith(color: Colors.white, fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white70)),
              ]),
            ),
            if (station.live)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(border: Border.all(color: const Color(0xFFFF4D6D)), borderRadius: BorderRadius.circular(99)),
                child: Text(context.tr('stations.onAir'), style: const TextStyle(color: Color(0xFFFF4D6D), fontSize: 11, fontWeight: FontWeight.w800)),
              ),
          ]),
        ),
      ),
    );
  }
}
