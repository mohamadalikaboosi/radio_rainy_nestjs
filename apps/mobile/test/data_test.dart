import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:radio_rainy/core/server_address.dart';
import 'package:radio_rainy/data/api_client.dart';
import 'package:radio_rainy/data/realtime_client.dart';

import 'support/fakes.dart';

void main() {
  final address = ServerAddress.parse('https://radio.example.com')!;

  group('ApiClient', () {
    test('reads the public API and builds the stream address (data saver = ?quality=low)', () async {
      final log = <http.Request>[];
      final api = ApiClient(
        address,
        client: fakeServer({
          '/radio/stations': [
            {'publicId': 'u1', 'slug': 'a', 'title': 'A', 'live': true, 'lowQuality': true},
          ],
          '/radio/a/current': {'status': 'PLAYING', 'title': 'Song', 'artist': 'Me'},
          '/radio/a/vote': {'status': 'NONE'},
        }, log: log),
      );
      expect((await api.stations()).single.title, 'A');
      expect((await api.current('a')).title, 'Song');
      expect((await api.vote('a', 'me123456')).status, 'NONE');
      expect(log.last.url.queryParameters['voterId'], 'me123456');
      expect(api.streamUri('a').toString(), 'https://radio.example.com/radio/a/stream');
      expect(api.streamUri('a', low: true).toString(), 'https://radio.example.com/radio/a/stream?quality=low');
      expect(api.absolute('/radio/ads/x/image').toString(), 'https://radio.example.com/radio/ads/x/image');
    });

    test('a vote is a JSON POST with the voter and the tag; server errors become readable messages', () async {
      final log = <http.Request>[];
      final api = ApiClient(address, client: fakeServer({}, log: log, postAnswers: {'/radio/a/vote': {'status': 'OPEN', 'myVote': 'rock'}}));
      final v = await api.castVote('a', 'me123456', 'rock');
      expect(v.myVote, 'rock');
      expect(jsonDecode(log.single.body), {'voterId': 'me123456', 'hashtag': 'rock'});
      await expectLater(api.current('missing'), throwsA(isA<ApiException>().having((e) => e.message, 'message', 'Not found')));
    });
  });

  group('RealtimeClient', () {
    test('turns the pushed messages into events and answers nothing it does not know', () async {
      final sockets = <FakeSocket>[];
      final uris = <Uri>[];
      final rt = RealtimeClient(address, 'a', connector: (u) {
        uris.add(u);
        final s = FakeSocket();
        sockets.add(s);
        return s;
      });
      final events = <RealtimeEvent>[];
      rt.events.listen(events.add);
      rt.start();
      expect(uris.single.toString(), 'wss://radio.example.com/radio/a/ws');

      sockets.single.push({
        'type': 'hello',
        'current': {'status': 'PLAYING', 'title': 'Pushed'},
        'vote': {'status': 'NONE'},
        'messages': [
          {'id': 'm1', 'text': 'Concert at 21:00', 'level': 'WARN'},
        ],
        'listeners': 7,
        'clients': 9,
      });
      sockets.single.push({'type': 'current', 'current': {'status': 'PLAYING', 'title': 'Next'}});
      sockets.single.push({'type': 'counts', 'listeners': 8, 'clients': 10});
      sockets.single.push({'type': 'whatever'});
      await Future<void>.delayed(Duration.zero);

      expect(events.whereType<ConnectionEvent>().first.connected, isTrue);
      final hello = events.whereType<HelloEvent>().single;
      expect((hello.current.title, hello.listeners, hello.messages.single.warn), ('Pushed', 7, true));
      expect(events.whereType<CurrentEvent>().single.current.title, 'Next');
      expect(events.whereType<CountsEvent>().single.listeners, 8);
      await rt.dispose();
    });

    test('reconnects after the connection drops', () async {
      final sockets = <FakeSocket>[];
      final rt = RealtimeClient(address, 'a', maxBackoff: const Duration(milliseconds: 1000), connector: (u) {
        final s = FakeSocket();
        sockets.add(s);
        return s;
      });
      final states = <bool>[];
      rt.events.whereType<ConnectionEvent>().listen((e) => states.add(e.connected));
      rt.start();
      sockets.first.push({'type': 'hello', 'current': {'status': 'NONE'}, 'vote': {'status': 'NONE'}, 'messages': []});
      await Future<void>.delayed(Duration.zero);
      await sockets.first.close();
      await Future<void>.delayed(const Duration(milliseconds: 1300)); // back-off of the first retry is 1 s
      expect(sockets.length, 2);
      expect(states, [true, false]);
      await rt.dispose();
    });
  });
}

extension<T> on Stream<T> {
  Stream<R> whereType<R>() => where((e) => e is R).cast<R>();
}
