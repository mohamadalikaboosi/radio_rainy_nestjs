import 'dart:async';

import 'package:audio_service/audio_service.dart';
import 'package:just_audio/just_audio.dart';

import 'radio_player.dart';

/// Background audio: lock-screen / notification / headset controls and playback with the screen off (Android, iOS, macOS).
/// It is the single place that owns the [AudioPlayer].
class RadioAudioHandler extends BaseAudioHandler {
  RadioAudioHandler({AudioPlayer? player}) : _player = player ?? AudioPlayer() {
    _player.playbackEventStream.map(_toState).listen(playbackState.add, onError: (Object e, StackTrace _) => _errors.add('$e'));
    var wasReady = false;
    _player.processingStateStream.listen((s) {
      // buffering AFTER we had been playing = the network could not keep up (not the first fill)
      if (s == ProcessingState.buffering && wasReady && _player.playing) _stalls.add(null);
      if (s == ProcessingState.ready) wasReady = true;
      if (s == ProcessingState.idle) wasReady = false;
    });
  }

  final AudioPlayer _player;
  final StreamController<void> _stalls = StreamController<void>.broadcast();
  final StreamController<String> _errors = StreamController<String>.broadcast();
  final StreamController<void> _stopRequests = StreamController<void>.broadcast();
  Uri? _last;

  Stream<bool> get playingStream => _player.playingStream;
  Stream<void> get stalls => _stalls.stream;
  Stream<String> get errors => _errors.stream;
  Stream<void> get stopRequests => _stopRequests.stream;

  Future<void> playStream(Uri uri, NowPlayingMeta meta) async {
    _last = uri;
    mediaItem.add(_item(uri, meta));
    try {
      await _player.setAudioSource(AudioSource.uri(uri));
      await _player.play();
    } catch (e) {
      _errors.add('$e');
    }
  }

  void setMeta(NowPlayingMeta meta) {
    final uri = _last;
    if (uri != null) mediaItem.add(_item(uri, meta));
  }

  MediaItem _item(Uri uri, NowPlayingMeta m) => MediaItem(id: uri.toString(), title: m.title, artist: m.artist, album: m.album, artUri: m.artUri, isLive: true);

  @override
  Future<void> play() async {
    final uri = _last;
    if (uri != null && _player.processingState == ProcessingState.idle) {
      await _player.setAudioSource(AudioSource.uri(uri)); // a paused live stream resumes at the live edge
    }
    await _player.play();
  }

  @override
  Future<void> pause() async {
    _stopRequests.add(null);
    await stop();
  }

  @override
  Future<void> stop() async {
    await _player.stop();
    await super.stop();
  }

  PlaybackState _toState(PlaybackEvent event) => PlaybackState(
        controls: [if (_player.playing) MediaControl.pause else MediaControl.play, MediaControl.stop],
        systemActions: const {MediaAction.play, MediaAction.pause, MediaAction.stop},
        androidCompactActionIndices: const [0, 1],
        processingState: const {
          ProcessingState.idle: AudioProcessingState.idle,
          ProcessingState.loading: AudioProcessingState.loading,
          ProcessingState.buffering: AudioProcessingState.buffering,
          ProcessingState.ready: AudioProcessingState.ready,
          ProcessingState.completed: AudioProcessingState.completed,
        }[_player.processingState]!,
        playing: _player.playing,
        updatePosition: _player.position,
        bufferedPosition: _player.bufferedPosition,
        speed: 1,
      );

  Future<void> dispose() async {
    await _player.dispose();
    await _stalls.close();
    await _errors.close();
    await _stopRequests.close();
  }
}

/// [RadioPlayer] backed by the background [RadioAudioHandler].
class BackgroundRadioPlayer implements RadioPlayer {
  BackgroundRadioPlayer(this._handler);

  final RadioAudioHandler _handler;

  @override
  Future<void> play(Uri stream, NowPlayingMeta meta) => _handler.playStream(stream, meta);

  @override
  Future<void> stop() => _handler.stop();

  @override
  Future<void> updateMeta(NowPlayingMeta meta) async => _handler.setMeta(meta);

  @override
  Stream<bool> get playing => _handler.playingStream;

  @override
  Stream<void> get stalls => _handler.stalls;

  @override
  Stream<String> get errors => _handler.errors;

  @override
  Stream<void> get stopRequests => _handler.stopRequests;

  @override
  Future<void> dispose() async {
    // the handler lives as long as the app: it is not disposed with a screen
  }
}
