import 'package:flutter_test/flutter_test.dart';
import 'package:radio_rainy/core/server_address.dart';
import 'package:radio_rainy/core/settings.dart';
import 'package:radio_rainy/data/api_client.dart';
import 'package:radio_rainy/data/realtime_client.dart';
import 'package:radio_rainy/domain/quality.dart';
import 'package:radio_rainy/state/station_controller.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

void main() {
  final address = ServerAddress.parse('https://radio.example.com')!;
  late FakePlayer player;
  late Settings settings;
  late FakeSocket socket;
  late DateTime clock;
  late StationController c;

  Future<StationController> make({bool lowOffered = true, Map<String, Object?> extra = const {}, bool slow = false, Duration retry = const Duration(seconds: 1)}) async {
    SharedPreferences.setMockInitialValues({});
    settings = await Settings.load();
    player = FakePlayer();
    socket = FakeSocket();
    clock = DateTime.utc(2026, 1, 1, 12, 0, 40);
    final api = ApiClient(
      address,
      client: fakeServer({
        '/radio/stations': [
          {'publicId': 'u1', 'slug': 'a', 'title': 'Rainy FM', 'live': true, 'lowQuality': lowOffered},
        ],
        '/radio/a/current': {'status': 'PLAYING', 'trackId': 't1', 'title': 'Song One', 'artist': 'Sadegh', 'startedAt': '2026-01-01T12:00:00.000Z', 'serverTime': '2026-01-01T12:00:40.000Z', 'duration': 200},
        '/radio/a/current/lyrics': {
          'trackId': 't1',
          'status': 'READY',
          'lines': [
            {'start': 10, 'end': 20, 'text': 'first'},
            {'start': 38, 'end': 45, 'text': 'second'},
          ],
        },
        '/radio/a/vote': {'status': 'OPEN', 'poll': {'id': 'p1', 'options': [{'hashtag': 'rock', 'votes': 2}, {'hashtag': 'jazz', 'votes': 1}], 'totalVotes': 3}},
        '/radio/a/sponsors': [
          {'id': 's1', 'name': 'Shop', 'ctaLabel': 'Go', 'url': '/radio/go/sponsor/s1'},
        ],
        ...extra,
      }, postAnswers: {'/radio/a/vote': {'status': 'OPEN', 'poll': {'id': 'p1', 'options': [{'hashtag': 'rock', 'votes': 3}, {'hashtag': 'jazz', 'votes': 1}], 'totalVotes': 4}, 'myVote': 'rock'}}),
    );
    return StationController(api: api, address: address, slug: 'a', player: player, settings: settings, realtime: (a, s) => RealtimeClient(a, s, connector: (_) => socket), now: () => clock, slowConnection: slow, retryBase: retry);
  }

  tearDown(() => c.dispose());

  test('loads what is on air, the lyrics, the vote and the sponsors; the lyric line follows the SERVER clock', () async {
    c = await make();
    await c.start();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(c.title, 'Rainy FM');
    expect(c.current?.title, 'Song One');
    expect(c.lyrics?.lines.length, 2);
    expect(c.vote.open, isTrue);
    expect(c.sponsors.single.name, 'Shop');
    expect(c.position, 40); // 12:00:40 server time, song started 12:00:00
    expect(c.activeLine, 1); // 'second' starts at 38 s
    clock = clock.add(const Duration(seconds: 10)); // 10 s pass on the phone
    expect(c.position, 50);
    expect(c.activeLine, -1); // past the end of 'second' (45 + grace)
  });

  test('pressing play streams the station; pressing it again stops and drops the stream', () async {
    c = await make();
    await c.start();
    await c.togglePlay();
    expect(player.played.single.uri.toString(), 'https://radio.example.com/radio/a/stream');
    expect(player.played.single.meta.title, 'Song One');
    expect(player.played.single.meta.artist, 'Sadegh');
    await Future<void>.delayed(Duration.zero);
    expect(c.playing, isTrue);
    await c.togglePlay();
    expect(player.stops, 1);
    expect(c.playing, isFalse);
  });

  test('the lock-screen stop button is reflected in the app', () async {
    c = await make();
    await c.start();
    await c.togglePlay();
    player.pressStopOnLockScreen();
    await Future<void>.delayed(Duration.zero);
    expect(c.playing, isFalse);
  });

  test('data saver: chosen quality is remembered and used; changing it while playing rejoins on the other stream', () async {
    c = await make();
    await c.start();
    await c.setQuality(QualityPref.low);
    expect(settings.quality, QualityPref.low);
    await c.togglePlay();
    expect(player.played.last.uri.queryParameters['quality'], 'low');
    await c.setQuality(QualityPref.high);
    expect(player.played.last.uri.queryParameters.containsKey('quality'), isFalse);
    expect(player.played.length, 2);
  });

  test('auto mode switches to the light stream after repeated stalls, and only when the station offers it', () async {
    c = await make();
    await c.start();
    await c.togglePlay();
    for (var i = 0; i < 3; i++) {
      player.stall();
      await Future<void>.delayed(Duration.zero);
      clock = clock.add(const Duration(seconds: 2));
    }
    expect(c.stalledOnHigh, isTrue);
    expect(player.played.last.uri.queryParameters['quality'], 'low');

    c.dispose();
    c = await make(lowOffered: false);
    await c.start();
    await c.togglePlay();
    for (var i = 0; i < 5; i++) {
      player.stall();
      await Future<void>.delayed(Duration.zero);
    }
    expect(c.stalledOnHigh, isFalse);
    expect(player.played.length, 1);
  });

  test('a slow connection (OS data saver) starts auto mode on the light stream', () async {
    c = await make(slow: true);
    await c.start();
    await c.togglePlay();
    expect(player.played.single.uri.queryParameters['quality'], 'low');
  });

  test('pushed updates replace polling: a new song, announcements, counts and the vote (keeping MY choice for the same poll)', () async {
    c = await make();
    await c.start();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await c.castVote('rock');
    expect(c.vote.myVote, 'rock');

    socket.push({'type': 'hello', 'current': {'status': 'PLAYING', 'trackId': 't1', 'title': 'Song One'}, 'vote': {'status': 'OPEN', 'poll': {'id': 'p1', 'options': [{'hashtag': 'rock', 'votes': 5}], 'totalVotes': 5}}, 'messages': [], 'listeners': 3});
    socket.push({'type': 'messages', 'messages': [{'id': 'm1', 'text': 'Hello', 'level': 'INFO'}]});
    socket.push({'type': 'counts', 'listeners': 4, 'clients': 6});
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(c.connected, isTrue);
    expect(c.messages.single.text, 'Hello');
    expect(c.listeners, 4);
    expect(c.clients, 6); // "6 online"
    expect(c.vote.options.single.votes, 5);
    expect(c.vote.myVote, 'rock'); // same poll: my vote survives the push

    socket.push({'type': 'vote', 'vote': {'status': 'OPEN', 'poll': {'id': 'p2', 'options': [{'hashtag': 'jazz', 'votes': 0}], 'totalVotes': 0}}});
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(c.vote.myVote, isNull); // a new poll: nothing chosen yet

    await c.togglePlay();
    socket.push({'type': 'current', 'current': {'status': 'PLAYING', 'trackId': 't2', 'title': 'Song Two', 'artist': 'Other'}});
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(c.current?.title, 'Song Two');
    expect(player.metas.last.title, 'Song Two'); // the lock screen follows the song
  });

  test('a stream that drops by itself is reconnected until it plays again; pressing stop while it waits gives up', () async {
    c = await make(retry: const Duration(milliseconds: 10));
    await c.start();
    await c.togglePlay();
    await Future<void>.delayed(Duration.zero);
    player.fail('connection reset');
    await Future<void>.delayed(Duration.zero);
    expect(c.reconnecting, isTrue); // "Reconnecting…" instead of "on air"
    expect(c.playing, isTrue); // still wants to listen: the button says "pause"
    expect(c.sounding, isFalse);
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(player.played, hasLength(2)); // retried on a fresh live connection
    expect(c.reconnecting, isFalse);

    player.fail('again');
    await Future<void>.delayed(Duration.zero);
    expect(c.reconnecting, isTrue);
    await c.togglePlay(); // the listener stops while it waits
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(player.played, hasLength(2)); // no retry after stop
    expect(c.reconnecting, isFalse);
    expect(c.playing, isFalse);
  });

  test('the lyrics card and the in-app volume are remembered', () async {
    c = await make();
    await c.start();
    expect(c.showLyrics, isTrue);
    await c.toggleLyrics();
    expect(c.showLyrics, isFalse);
    expect(settings.showLyrics, isFalse);
    await c.setVolume(0.4);
    expect(player.volume, 0.4);
    expect(settings.volume, 0.4);
  });

  test('an unknown station is reported, nothing plays', () async {
    c = await make(extra: {'/radio/stations': <Object>[]});
    await c.start();
    expect(c.notFound, isTrue);
  });
}
