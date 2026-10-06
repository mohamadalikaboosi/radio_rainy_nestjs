import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/server_address.dart';
import 'models.dart';

sealed class RealtimeEvent {
  const RealtimeEvent();
}

/// Sent once after connecting: everything at once.
class HelloEvent extends RealtimeEvent {
  const HelloEvent({required this.current, required this.vote, required this.messages, this.listeners, this.clients});

  final Current current;
  final VoteView vote;
  final List<LiveMessage> messages;
  final int? listeners;
  final int? clients;
}

class CurrentEvent extends RealtimeEvent {
  const CurrentEvent(this.current);

  final Current current;
}

class VoteEvent extends RealtimeEvent {
  const VoteEvent(this.vote);

  final VoteView vote;
}

class MessagesEvent extends RealtimeEvent {
  const MessagesEvent(this.messages);

  final List<LiveMessage> messages;
}

class CountsEvent extends RealtimeEvent {
  const CountsEvent({this.listeners, this.clients});

  final int? listeners;
  final int? clients;
}

class ConnectionEvent extends RealtimeEvent {
  const ConnectionEvent(this.connected);

  final bool connected;
}

typedef SocketConnector = WebSocketChannel Function(Uri uri);

/// The live channel of one station (`/radio/<slug>/ws`): what is on air, the vote, announcements and the counts are PUSHED by the server,
/// so the app does not have to poll. Reconnects with back-off; while it is down the caller keeps working by polling.
class RealtimeClient {
  RealtimeClient(this.address, this.slug, {SocketConnector? connector, this.pingEvery = const Duration(seconds: 25), this.maxBackoff = const Duration(seconds: 30)})
      : _connector = connector ?? WebSocketChannel.connect;

  final ServerAddress address;
  final String slug;
  final Duration pingEvery;
  final Duration maxBackoff;
  final SocketConnector _connector;

  final StreamController<RealtimeEvent> _events = StreamController<RealtimeEvent>.broadcast();
  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _ping;
  Timer? _retry;
  int _attempt = 0;
  bool _closed = false;

  Stream<RealtimeEvent> get events => _events.stream;

  void start() {
    if (_closed || _channel != null) return;
    _open();
  }

  void _open() {
    if (_closed) return;
    try {
      final ch = _connector(address.socket('/radio/$slug/ws'));
      _channel = ch;
      _sub = ch.stream.listen(_onData, onDone: _onClosed, onError: (Object _) => _onClosed(), cancelOnError: true);
      _ping = Timer.periodic(pingEvery, (_) {
        try {
          ch.sink.add('ping');
        } catch (_) {/* closing */}
      });
    } catch (_) {
      _onClosed();
    }
  }

  void _onData(dynamic raw) {
    Object? j;
    try {
      j = jsonDecode(raw is String ? raw : utf8.decode(raw as List<int>));
    } catch (_) {
      return;
    }
    if (j is! Map<String, dynamic>) return;
    switch (j['type']) {
      case 'hello':
        _attempt = 0;
        _emit(const ConnectionEvent(true));
        _emit(HelloEvent(
          current: Current.fromJson(_m(j['current'])),
          vote: VoteView.fromJson(_m(j['vote'])),
          messages: _messages(j['messages']),
          listeners: _int(j['listeners']),
          clients: _int(j['clients']),
        ));
      case 'current':
        _emit(CurrentEvent(Current.fromJson(_m(j['current']))));
      case 'vote':
        _emit(VoteEvent(VoteView.fromJson(_m(j['vote']))));
      case 'messages':
        _emit(MessagesEvent(_messages(j['messages'])));
      case 'counts':
        _emit(CountsEvent(listeners: _int(j['listeners']), clients: _int(j['clients'])));
    }
  }

  void _onClosed() {
    _ping?.cancel();
    _sub?.cancel();
    _channel = null;
    _sub = null;
    _emit(const ConnectionEvent(false));
    if (_closed) return;
    final wait = Duration(milliseconds: (1000 * (1 << _attempt.clamp(0, 10))).clamp(1000, maxBackoff.inMilliseconds));
    _attempt++;
    _retry = Timer(wait, _open);
  }

  void _emit(RealtimeEvent e) {
    if (!_events.isClosed) _events.add(e);
  }

  Map<String, dynamic> _m(Object? v) => v is Map<String, dynamic> ? v : <String, dynamic>{};
  int? _int(Object? v) => v is num ? v.toInt() : null;
  List<LiveMessage> _messages(Object? v) => (v is List ? v : const []).whereType<Map<String, dynamic>>().map(LiveMessage.fromJson).toList();

  Future<void> dispose() async {
    _closed = true;
    _ping?.cancel();
    _retry?.cancel();
    await _sub?.cancel();
    await _channel?.sink.close();
    await _events.close();
  }
}
