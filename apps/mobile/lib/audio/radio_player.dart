/// What the lock screen / notification shows.
class NowPlayingMeta {
  const NowPlayingMeta({required this.title, this.artist, this.album, this.artUri});

  final String title;
  final String? artist;
  final String? album;
  final Uri? artUri;
}

/// The audio output as the rest of the app sees it (so the controller is testable without a device).
abstract class RadioPlayer {
  /// Starts (or restarts, rejoining the live edge) playing [stream].
  Future<void> play(Uri stream, NowPlayingMeta meta);

  /// Stops and drops the stream: playing again joins the live edge instead of resuming stale buffered audio.
  Future<void> stop();

  /// Updates the lock-screen / notification text while playing.
  Future<void> updateMeta(NowPlayingMeta meta);

  /// In-app volume, 0-1 (kept across streams).
  Future<void> setVolume(double volume);

  /// true while audio is playing (or about to).
  Stream<bool> get playing;

  /// One event each time playback ran out of audio and had to buffer: the network cannot keep up.
  Stream<void> get stalls;

  /// Playback failed (stream refused, network lost...).
  Stream<String> get errors;

  /// Notification / headset buttons asked to pause or stop.
  Stream<void> get stopRequests;

  Future<void> dispose();
}
