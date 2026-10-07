import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:radio_rainy/core/server_address.dart';
import 'package:radio_rainy/core/settings.dart';
import 'package:radio_rainy/data/api_client.dart';
import 'package:radio_rainy/data/models.dart';
import 'package:radio_rainy/data/realtime_client.dart';
import 'package:radio_rainy/l10n/strings.dart';
import 'package:radio_rainy/state/station_controller.dart';
import 'package:radio_rainy/state/stations_controller.dart';
import 'package:radio_rainy/ui/player_screen.dart';
import 'package:radio_rainy/ui/setup_screen.dart';
import 'package:radio_rainy/ui/stations_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

Widget app(Widget home, {Locale locale = const Locale('en')}) => MaterialApp(
      locale: locale,
      supportedLocales: Strings.supported,
      localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
      home: home,
    );

void main() {
  final address = ServerAddress.parse('https://radio.example.com')!;

  testWidgets('setup: refuses garbage, then connects only to a real radio_rainy server', (tester) async {
    final connected = <String>[];
    await tester.pumpWidget(app(SetupScreen(onConnected: (t) async => connected.add(t))));
    await tester.enterText(find.byType(TextField), 'ftp://nope');
    await tester.tap(find.text('Connect'));
    await tester.pump();
    expect(find.text('This does not look like an address.'), findsOneWidget);
    expect(connected, isEmpty);
  });

  testWidgets('stations: on-air stations first with what they play, off-air ones marked; tapping opens the station', (tester) async {
    final api = ApiClient(
      address,
      client: fakeServer({
        '/radio/stations': [
          {'publicId': 'u2', 'slug': 'zeta', 'title': 'Zeta Off', 'live': false},
          {'publicId': 'u1', 'slug': 'alpha', 'title': 'Alpha FM', 'live': true},
        ],
        '/radio/alpha/current': {'status': 'PLAYING', 'title': 'Hamkharabeh', 'artist': 'Sadegh'},
      }),
    );
    final c = StationsController(api, refreshEvery: const Duration(hours: 1));
    await c.start();
    Station? opened;
    await tester.pumpWidget(app(StationsScreen(controller: c, onOpen: (s) => opened = s, onChangeServer: () {}, onLanguage: (_) {}, language: null)));
    await tester.pump();
    final titles = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data).whereType<String>().toList();
    expect(titles.indexOf('Alpha FM'), lessThan(titles.indexOf('Zeta Off')));
    expect(find.text('Hamkharabeh — Sadegh'), findsOneWidget);
    expect(find.text('On air'), findsOneWidget);
    expect(find.text('Off air'), findsOneWidget);
    await tester.tap(find.text('Alpha FM'));
    expect(opened?.slug, 'alpha');
    c.dispose();
  });

  Future<StationController> station(FakePlayer player, {DateTime? now}) async {
    SharedPreferences.setMockInitialValues({});
    final settings = await Settings.load();
    final api = ApiClient(
      address,
      client: fakeServer({
        '/radio/stations': [
          {'publicId': 'u1', 'slug': 'a', 'title': 'Rainy FM', 'live': true, 'lowQuality': true},
        ],
        '/radio/a/current': {'status': 'PLAYING', 'trackId': 't1', 'title': 'Song One', 'artist': 'Sadegh', 'startedAt': '2026-01-01T12:00:00.000Z', 'serverTime': '2026-01-01T12:00:12.000Z', 'duration': 200},
        '/radio/a/current/lyrics': {
          'trackId': 't1',
          'status': 'READY',
          'lines': [
            {'start': 10, 'end': 20, 'text': 'the line being sung'},
            {'start': 30, 'end': 40, 'text': 'a later line'},
          ],
        },
        '/radio/a/vote': {'status': 'OPEN', 'poll': {'id': 'p1', 'options': [{'hashtag': 'rock', 'votes': 2}], 'totalVotes': 2}},
        '/radio/a/sponsors': [
          {'id': 's1', 'name': 'Shop', 'ctaLabel': 'Visit', 'url': '/radio/go/sponsor/s1'},
        ],
      }),
    );
    return StationController(api: api, address: address, slug: 'a', player: player, settings: settings, realtime: (a, s) => RealtimeClient(a, s, connector: (_) => FakeSocket()), now: () => now ?? DateTime.utc(2026, 1, 1, 12, 0, 12));
  }

  testWidgets('player: shows the song, the lyrics (synced, karaoke row), the vote and the sponsor; play button starts the stream', (tester) async {
    tester.view.physicalSize = const Size(1000, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final player = FakePlayer();
    final c = await station(player);
    await c.start();
    await tester.pumpWidget(app(PlayerScreen(controller: c)));
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('Song One'), findsOneWidget);
    expect(find.text('Sadegh'), findsOneWidget);
    expect(find.text('ON AIR'), findsOneWidget);
    expect(find.text('NOW PLAYING'), findsOneWidget);
    expect(find.text('Song One — Sadegh'), findsOneWidget); // lyrics card header
    expect(find.text('the line being sung'), findsOneWidget);
    expect(find.text('• • •'), findsNWidgets(3)); // intro, the 10 s between the lines, the rest of the song
    expect(find.text('Shop'), findsOneWidget);
    expect(find.text('What plays next?'), findsOneWidget);
    expect(find.text('#rock'), findsOneWidget);
    expect(find.text('100% · 2 votes'), findsOneWidget);
    expect(find.byTooltip('Quality'), findsOneWidget); // the station offers the data saver
    expect(find.byType(Slider), findsOneWidget); // desktop: volume

    await tester.tap(find.byKey(const Key('play')));
    await tester.pump();
    expect(player.played, hasLength(1));
    expect(find.text('Pause'), findsOneWidget);
    c.dispose();
  });

  testWidgets('player on a phone: settings behind "⋯", no volume slider (hardware buttons), the Lyrics button hides the card', (tester) async {
    tester.view.physicalSize = const Size(390, 2600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final c = await station(FakePlayer());
    await c.start();
    await tester.pumpWidget(app(PlayerScreen(controller: c)));
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.byTooltip('Menu'), findsOneWidget);
    expect(find.byTooltip('Quality'), findsNothing);
    expect(find.byType(Slider), findsNothing);
    expect(find.text('the line being sung'), findsOneWidget);
    await tester.tap(find.text('Lyrics').first);
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('the line being sung'), findsNothing);
    expect(c.showLyrics, isFalse);
    c.dispose();
  });

  testWidgets('player: a station link opens locked (no back button); Persian is right-to-left', (tester) async {
    final c = await station(FakePlayer());
    await c.start();
    await tester.pumpWidget(app(PlayerScreen(controller: c, locked: true), locale: const Locale('fa')));
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.byType(BackButton), findsNothing);
    expect(Directionality.of(tester.element(find.byType(PlayerScreen))), TextDirection.rtl);
    expect(find.text('پخش زنده'), findsOneWidget);
    c.dispose();
  });
}
