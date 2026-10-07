import 'package:flutter_test/flutter_test.dart';
import 'package:radio_rainy/core/server_address.dart';
import 'package:radio_rainy/domain/lyrics_sync.dart';
import 'package:radio_rainy/domain/quality.dart';
import 'package:radio_rainy/data/models.dart';

void main() {
  group('ServerAddress.parse', () {
    test('a bare host is https, a dev address is http', () {
      expect(ServerAddress.parse('radio.example.com')!.base.toString(), 'https://radio.example.com');
      expect(ServerAddress.parse('10.0.2.2:3000')!.base.toString(), 'http://10.0.2.2:3000');
      expect(ServerAddress.parse('localhost:3000')!.base.toString(), 'http://localhost:3000');
      expect(ServerAddress.parse('192.168.1.20:3000')!.base.toString(), 'http://192.168.1.20:3000');
    });

    test('a station link carries the permanent UUID (lower-cased) or the slug', () {
      final a = ServerAddress.parse('https://radio.example.com/B80AC2CC-129B-4399-AD99-49D5E8A64A49')!;
      expect(a.base.toString(), 'https://radio.example.com');
      expect(a.stationPublicId, 'b80ac2cc-129b-4399-ad99-49d5e8a64a49');
      expect(a.isStationLink, isTrue);
      final b = ServerAddress.parse('http://localhost:3000/s/rainy-postrock')!;
      expect(b.stationSlug, 'rainy-postrock');
      expect(ServerAddress.parse('radio.example.com')!.isStationLink, isFalse);
      expect(ServerAddress.parse('https://radio.example.com/panel')!.isStationLink, isFalse);
    });

    test('garbage is rejected', () {
      expect(ServerAddress.parse(''), isNull);
      expect(ServerAddress.parse('   '), isNull);
      expect(ServerAddress.parse('ftp://x.com'), isNull);
    });

    test('resolve and socket build the right addresses', () {
      final a = ServerAddress.parse('https://radio.example.com')!;
      expect(a.resolve('/radio/x/stream', {'quality': 'low'}).toString(), 'https://radio.example.com/radio/x/stream?quality=low');
      expect(a.socket('/radio/x/ws').toString(), 'wss://radio.example.com/radio/x/ws');
      expect(ServerAddress.parse('http://localhost:3000')!.socket('/radio/x/ws').toString(), 'ws://localhost:3000/radio/x/ws');
    });
  });

  group('lyrics sync', () {
    const lines = [LyricLine(start: 1, end: 3, text: 'a'), LyricLine(start: 4, end: 6, text: 'b'), LyricLine(start: 10, end: 12, text: 'c')];

    test('the active line follows the clock, with a short grace and empty gaps', () {
      expect(activeLineIndex(lines, 0.5), -1);
      expect(activeLineIndex(lines, 1), 0);
      expect(activeLineIndex(lines, 2.9), 0);
      expect(activeLineIndex(lines, 4.5), 1);
      expect(activeLineIndex(lines, 7.0), 1); // inside the 1.5 s grace after the line
      expect(activeLineIndex(lines, 8.0), -1); // the gap
      expect(activeLineIndex(lines, 11), 2);
      expect(activeLineIndex(lines, 99), -1);
      expect(activeLineIndex(const [], 5), -1);
    });

    test('lyric rows: an instrumental row for the intro, long gaps and the outro; short pauses stay as they are', () {
      const sung = [LyricLine(start: 16, end: 21, text: 'a'), LyricLine(start: 22, end: 27, text: 'b'), LyricLine(start: 46, end: 51, text: 'c')];
      final rows = lyricRows(sung, duration: 80);
      expect([for (final r in rows) r.gap ? '•' : r.text], ['•', 'a', 'b', '•', 'c', '•']);
      expect((rows[3].start, rows[3].end), (27.0, 46.0));
      expect(lyricRows(const []), isEmpty);
    });

    test('the active row is the last one that started; the karaoke fill sweeps 0 -> 1 across it', () {
      final rows = lyricRows(const [LyricLine(start: 0, end: 5, text: 'first'), LyricLine(start: 28, end: 34, text: 'second')]);
      expect([for (final r in rows) r.gap ? '•' : r.text], ['first', '•', 'second']);
      expect(activeRowIndex(rows, -1), -1);
      expect(activeRowIndex(rows, 3), 0);
      expect(activeRowIndex(rows, 10), 1); // between lines: the instrumental row
      expect(activeRowIndex(rows, 30), 2);
      const row = LyricRow(start: 10, end: 14, text: 'x');
      expect(karaokeFill(row, 9), 0);
      expect(karaokeFill(row, 11.85), closeTo(0.5, 0.01));
      expect(karaokeFill(row, 13.8), 1); // full a moment before the line ends
    });

    test('vote shares are whole percent; the idle visualizer stays low, the playing one moves', () {
      expect(voteShares([0, 0]), [0, 0]);
      expect(voteShares([5, 3]), [63, 38]);
      final idle = vizLevels(64, playing: false, tMs: 1234);
      expect(idle.every((v) => v >= 0.04 && v <= 0.07), isTrue);
      final live = vizLevels(64, playing: true, tMs: 0, rng: () => 0.5);
      expect(live.every((v) => v > 0.2 && v <= 1), isTrue);
      expect(live[14], greaterThan(live[63]));
    });

    test('the position uses the SERVER clock, so a wrong phone clock does not matter', () {
      final started = DateTime.utc(2026, 1, 1, 12, 0, 0);
      final serverNow = DateTime.utc(2026, 1, 1, 12, 1, 30); // 90 s into the song
      expect(positionSeconds(startedAt: started, serverTime: serverNow, sinceFetched: Duration.zero), 90);
      expect(positionSeconds(startedAt: started, serverTime: serverNow, sinceFetched: const Duration(seconds: 5)), 95);
      expect(positionSeconds(startedAt: started, serverTime: serverNow, sinceFetched: const Duration(seconds: 500), duration: 100), 100); // never past the end
      expect(positionSeconds(startedAt: serverNow, serverTime: started, sinceFetched: Duration.zero), 0); // never negative
    });
  });

  group('quality', () {
    test('the stall tracker trips after 3 stalls inside the window only', () {
      final t = StallTracker();
      final t0 = DateTime(2026, 1, 1, 12);
      expect(t.record(t0), isFalse);
      expect(t.record(t0.add(const Duration(seconds: 5))), isFalse);
      expect(t.record(t0.add(const Duration(seconds: 25))), isFalse); // the first expired
      expect(t.record(t0.add(const Duration(seconds: 26))), isFalse);
      expect(t.record(t0.add(const Duration(seconds: 27))), isTrue);
    });

    test('low quality only when the station offers it, honouring the choice; auto reacts to stalls / slow networks', () {
      bool low(QualityPref p, {bool offers = true, bool stalled = false, bool slow = false}) => useLowQuality(pref: p, stationOffersLow: offers, stalledOnHigh: stalled, slowConnection: slow);
      expect(low(QualityPref.low), isTrue);
      expect(low(QualityPref.low, offers: false), isFalse);
      expect(low(QualityPref.high, stalled: true, slow: true), isFalse);
      expect(low(QualityPref.auto), isFalse);
      expect(low(QualityPref.auto, stalled: true), isTrue);
      expect(low(QualityPref.auto, slow: true), isTrue);
      expect(qualityPrefFrom('low'), QualityPref.low);
      expect(qualityPrefFrom('nonsense'), QualityPref.auto);
    });
  });

  group('models', () {
    test('parse the real API shapes and survive missing fields', () {
      final s = Station.fromJson({'publicId': 'u', 'slug': 'x', 'title': 'X', 'live': true, 'transport': 'WEBSOCKET', 'lowQuality': true});
      expect((s.slug, s.live, s.lowQuality, s.publicId), ('x', true, true, 'u'));
      expect(Station.fromJson({}).live, isFalse);

      final c = Current.fromJson({
        'status': 'AD',
        'serverTime': '2026-01-01T12:00:00.000Z',
        'ad': {'id': 'a1', 'name': 'Shop', 'linkUrl': '/radio/go/ad/a1', 'ctaLabel': 'Visit', 'imageUrl': '/radio/ads/a1/image'},
      });
      expect(c.isAd, isTrue);
      expect(c.ad?.imageUrl, '/radio/ads/a1/image');
      expect(Current.fromJson({'status': 'PLAYING', 'title': 'T', 'duration': 240}).duration, 240.0);

      final l = Lyrics.fromJson({'trackId': 't', 'status': 'READY', 'lines': [{'start': 1, 'end': 2.5, 'text': 'hi'}]});
      expect(l.synced, isTrue);
      expect(Lyrics.fromJson({'trackId': 't', 'status': 'PLAIN', 'plain': ['a', 'b']}).hasText, isTrue);

      final v = VoteView.fromJson({
        'status': 'OPEN',
        'poll': {'id': 'p', 'options': [{'hashtag': 'rock', 'votes': 3}, {'hashtag': 'jazz', 'votes': 1}], 'totalVotes': 4},
        'myVote': 'rock',
      });
      expect(v.open, isTrue);
      expect(v.options.map((o) => o.hashtag), ['rock', 'jazz']);
      expect(v.withMyVote('jazz').myVote, 'jazz');
      expect(VoteView.fromJson({'status': 'NONE'}).open, isFalse);
    });
  });
}
