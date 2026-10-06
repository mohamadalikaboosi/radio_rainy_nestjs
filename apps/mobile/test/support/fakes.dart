import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:radio_rainy/audio/radio_player.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// A player that records what the app asked it to do.
class FakePlayer implements RadioPlayer {
  final List<({Uri uri, NowPlayingMeta meta})> played = [];
  final List<NowPlayingMeta> metas = [];
  int stops = 0;
  final StreamController<bool> _playing = StreamController<bool>.broadcast();
  final StreamController<void> _stalls = StreamController<void>.broadcast();
  final StreamController<String> _errors = StreamController<String>.broadcast();
  final StreamController<void> _stopRequests = StreamController<void>.broadcast();

  @override
  Future<void> play(Uri stream, NowPlayingMeta meta) async {
    played.add((uri: stream, meta: meta));
    _playing.add(true);
  }

  @override
  Future<void> stop() async {
    stops++;
    _playing.add(false);
  }

  @override
  Future<void> updateMeta(NowPlayingMeta meta) async => metas.add(meta);

  void stall() => _stalls.add(null);
  void fail(String e) => _errors.add(e);
  void pressStopOnLockScreen() => _stopRequests.add(null);

  @override
  Stream<bool> get playing => _playing.stream;
  @override
  Stream<void> get stalls => _stalls.stream;
  @override
  Stream<String> get errors => _errors.stream;
  @override
  Stream<void> get stopRequests => _stopRequests.stream;

  @override
  Future<void> dispose() async {}
}

/// A server that answers the public radio API from a map of path -> JSON.
http.Client fakeServer(Map<String, Object?> routes, {List<http.Request>? log, Map<String, Object?>? postAnswers}) {
  return MockClient((req) async {
    log?.add(req);
    if (req.method == 'POST' && postAnswers != null && postAnswers.containsKey(req.url.path)) {
      return http.Response(jsonEncode(postAnswers[req.url.path]), 200, headers: {'content-type': 'application/json'});
    }
    final body = routes[req.url.path];
    if (body == null) return http.Response(jsonEncode({'message': 'Not found'}), 404);
    return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});
  });
}

/// A WebSocket the test controls: [push] sends a server message, [close] drops the connection.
class FakeSocket extends StreamChannelMixin<dynamic> implements WebSocketChannel {
  FakeSocket() : _ctl = StreamChannelController<dynamic>(sync: true);

  final StreamChannelController<dynamic> _ctl;
  final List<dynamic> sent = [];
  bool closed = false;

  void push(Map<String, Object?> message) => _ctl.foreign.sink.add(jsonEncode(message));
  Future<void> close() async {
    closed = true;
    await _ctl.foreign.sink.close();
  }

  @override
  Stream<dynamic> get stream => _ctl.local.stream;

  @override
  WebSocketSink get sink => _FakeSink(this);

  @override
  Future<void> get ready async {}

  @override
  int? get closeCode => null;
  @override
  String? get closeReason => null;
  @override
  String? get protocol => null;
}

class _FakeSink implements WebSocketSink {
  _FakeSink(this._socket);

  final FakeSocket _socket;

  @override
  void add(dynamic data) => _socket.sent.add(data);
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<dynamic> stream) async {}
  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    _socket.closed = true;
  }

  @override
  Future<void> get done async {}
}
