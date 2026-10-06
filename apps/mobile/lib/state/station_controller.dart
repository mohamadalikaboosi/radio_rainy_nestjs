import 'dart:async';

import 'package:flutter/foundation.dart';

import '../audio/radio_player.dart';
import '../core/server_address.dart';
import '../core/settings.dart';
import '../data/api_client.dart';
import '../data/models.dart';
import '../data/realtime_client.dart';
import '../domain/lyrics_sync.dart';
import '../domain/quality.dart';

typedef RealtimeFactory = RealtimeClient Function(ServerAddress address, String slug);

/// Everything the player screen shows for ONE station: what is on air, the lyrics, the vote, announcements, sponsors, the listener
/// count, and the audio. The live socket pushes the state; polling only runs while the socket is down.
class StationController extends ChangeNotifier {
  StationController({
    required this.api,
    required this.address,
    required this.slug,
    required this.player,
    required this.settings,
    RealtimeFactory? realtime,
    DateTime Function()? now,
    this.pollEvery = const Duration(seconds: 3),
    this.slowConnection = false,
  })  : _realtimeFactory = realtime ?? ((a, s) => RealtimeClient(a, s)),
        _now = now ?? DateTime.now,
        pref = settings.quality;

  final ApiClient api;
  final ServerAddress address;
  final String slug;
  final RadioPlayer player;
  final Settings settings;
  final Duration pollEvery;
  final RealtimeFactory _realtimeFactory;
  final DateTime Function() _now;
  /// The OS says the connection is slow / data saver is on: auto mode starts on the light stream.
  final bool slowConnection;

  Station? station;
  Current? current;
  DateTime _currentAt = DateTime.fromMillisecondsSinceEpoch(0);
  Lyrics? lyrics;
  VoteView vote = VoteView.none;
  List<Sponsor> sponsors = const [];
  List<LiveMessage> messages = const [];
  int? listeners;
  bool connected = false;
  bool playing = false;
  bool notFound = false;
  String? error;
  QualityPref pref;

  /// Auto mode gave up on the normal stream (it stalled repeatedly) for this session.
  bool stalledOnHigh = false;

  final StallTracker _stalls = StallTracker();
  RealtimeClient? _rt;
  final List<StreamSubscription<dynamic>> _subs = [];
  Timer? _poll;
  bool _disposed = false;
  String? _lyricsFor;

  bool get offersLow => station?.lowQuality ?? false;
  bool get lowActive => useLowQuality(pref: pref, stationOffersLow: offersLow, stalledOnHigh: stalledOnHigh, slowConnection: slowConnection);
  String get title => station?.title ?? slug;

  /// Seconds into the song on air, from the server's clock.
  double? get position {
    final c = current;
    if (c == null || !c.onAir || c.startedAt == null || c.serverTime == null) return null;
    return positionSeconds(startedAt: c.startedAt!, serverTime: c.serverTime!, sinceFetched: _now().difference(_currentAt), duration: c.duration);
  }

  int get activeLine {
    final p = position;
    final l = lyrics;
    return p == null || l == null || !l.synced ? -1 : activeLineIndex(l.lines, p);
  }

  Future<void> start() async {
    _subs
      ..add(player.playing.listen((p) {
        playing = p;
        _changed();
      }))
      ..add(player.errors.listen((e) {
        error = e;
        _changed();
      }))
      ..add(player.stalls.listen((_) => _onStall()))
      ..add(player.stopRequests.listen((_) {
        playing = false;
        _changed();
      }));

    try {
      final list = await api.stations();
      station = list.where((s) => s.slug == slug).firstOrNull;
      if (station == null) {
        notFound = true;
        _changed();
        return;
      }
    } catch (e) {
      error = '$e';
      _changed();
    }
    await _refreshAll();
    _rt = _realtimeFactory(address, slug)..start();
    _subs.add(_rt!.events.listen(_onEvent));
    _poll = Timer.periodic(pollEvery, (_) {
      if (!connected) unawaited(_refreshCurrent());
    });
  }

  Future<void> _refreshAll() async {
    await Future.wait([_refreshCurrent(), _refreshVote(), _refreshSponsors()]);
  }

  Future<void> _refreshCurrent() async {
    try {
      _setCurrent(await api.current(slug));
      error = null;
    } catch (e) {
      error = '$e';
      _changed();
    }
  }

  Future<void> _refreshVote() async {
    try {
      vote = await api.vote(slug, settings.voterId);
      _changed();
    } catch (_) {/* optional */}
  }

  Future<void> _refreshSponsors() async {
    try {
      sponsors = await api.sponsors(slug);
      _changed();
    } catch (_) {/* optional */}
  }

  void _onEvent(RealtimeEvent e) {
    switch (e) {
      case ConnectionEvent(:final connected):
        this.connected = connected;
      case HelloEvent():
        _setCurrent(e.current);
        vote = _keepMine(e.vote);
        messages = e.messages;
        listeners = e.listeners;
      case CurrentEvent():
        _setCurrent(e.current);
      case VoteEvent():
        vote = _keepMine(e.vote);
      case MessagesEvent():
        messages = e.messages;
      case CountsEvent():
        listeners = e.listeners;
    }
    _changed();
  }

  /// The pushed vote does not know who "I" am: keep my own choice while it is the same poll.
  VoteView _keepMine(VoteView next) => vote.pollId != null && vote.pollId == next.pollId ? next.withMyVote(vote.myVote) : next;

  void _setCurrent(Current c) {
    final changedTrack = current?.trackId != c.trackId || current?.status != c.status;
    current = c;
    _currentAt = _now();
    if (changedTrack) {
      if (c.trackId != null && c.trackId != _lyricsFor) {
        _lyricsFor = c.trackId;
        lyrics = null;
        unawaited(_loadLyrics(c.trackId!));
      } else if (c.trackId == null) {
        lyrics = null;
        _lyricsFor = null;
      }
      if (playing) unawaited(player.updateMeta(_meta()));
    }
    _changed();
  }

  Future<void> _loadLyrics(String trackId) async {
    try {
      final l = await api.lyrics(slug);
      if (_lyricsFor == trackId) {
        lyrics = l;
        _changed();
      }
    } catch (_) {/* lyrics are optional */}
  }

  NowPlayingMeta _meta() {
    final c = current;
    if (c != null && c.isAd) {
      final img = c.ad?.imageUrl;
      return NowPlayingMeta(title: c.ad!.name, artist: title, artUri: img == null ? null : api.absolute(img));
    }
    return NowPlayingMeta(title: c?.title ?? title, artist: c?.artist ?? title, album: c?.album ?? title);
  }

  // ---- playback ----

  Future<void> togglePlay() async {
    if (playing) {
      await player.stop();
      playing = false;
      _changed();
    } else {
      await _play();
    }
  }

  Future<void> _play() async {
    error = null;
    playing = true; // optimistic: the player stream corrects it
    _changed();
    await player.play(api.streamUri(slug, low: lowActive), _meta());
  }

  void _onStall() {
    if (pref != QualityPref.auto || !offersLow || stalledOnHigh) return;
    if (_stalls.record(_now())) {
      stalledOnHigh = true;
      _changed();
      if (playing) unawaited(_play()); // rejoin the live edge on the light stream
    }
  }

  Future<void> setQuality(QualityPref q) async {
    final before = lowActive;
    pref = q;
    stalledOnHigh = false;
    _stalls.reset();
    await settings.setQuality(q);
    _changed();
    if (playing && before != lowActive) await _play();
  }

  // ---- vote ----

  Future<void> castVote(String hashtag) async {
    try {
      vote = await api.castVote(slug, settings.voterId, hashtag);
      _changed();
    } catch (e) {
      error = '$e';
      _changed();
    }
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    for (final s in _subs) {
      s.cancel();
    }
    unawaited(_rt?.dispose());
    super.dispose();
  }
}
