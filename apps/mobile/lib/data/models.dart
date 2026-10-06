/// Plain data classes of the public radio API (`/radio/...`). Parsing is forgiving: a missing field never crashes the app.
T? _as<T>(Object? v) => v is T ? v : null;
double? _num(Object? v) => v is num ? v.toDouble() : null;
DateTime? _time(Object? v) => v is String ? DateTime.tryParse(v) : null;

class Station {
  const Station({required this.slug, required this.title, required this.live, this.publicId, this.transport = 'HTTP', this.lowQuality = false});

  final String slug;
  final String title;
  final bool live;

  /// Permanent UUID address of the station.
  final String? publicId;
  final String transport;

  /// The station offers the lighter data-saver stream (`?quality=low`).
  final bool lowQuality;

  factory Station.fromJson(Map<String, dynamic> j) => Station(
        slug: _as<String>(j['slug']) ?? '',
        title: _as<String>(j['title']) ?? '',
        live: j['live'] == true,
        publicId: _as<String>(j['publicId']),
        transport: _as<String>(j['transport']) ?? 'HTTP',
        lowQuality: j['lowQuality'] == true,
      );
}

class AdOnAir {
  const AdOnAir({required this.id, required this.name, this.linkUrl, this.ctaLabel, this.imageUrl});

  final String id;
  final String name;
  final String? linkUrl;
  final String? ctaLabel;
  final String? imageUrl;

  factory AdOnAir.fromJson(Map<String, dynamic> j) => AdOnAir(
        id: _as<String>(j['id']) ?? '',
        name: _as<String>(j['name']) ?? '',
        linkUrl: _as<String>(j['linkUrl']),
        ctaLabel: _as<String>(j['ctaLabel']),
        imageUrl: _as<String>(j['imageUrl']),
      );
}

/// What is on air right now.
class Current {
  const Current({required this.status, this.trackId, this.title, this.artist, this.album, this.startedAt, this.duration, this.serverTime, this.ad});

  /// PLAYING | AD | IDLE | STOPPED | ...
  final String status;
  final String? trackId;
  final String? title;
  final String? artist;
  final String? album;
  final DateTime? startedAt;
  final double? duration;

  /// The server's clock when this was produced: positions are computed against it, never against the phone's clock.
  final DateTime? serverTime;
  final AdOnAir? ad;

  bool get onAir => status == 'PLAYING';
  bool get isAd => status == 'AD' && ad != null;

  factory Current.fromJson(Map<String, dynamic> j) => Current(
        status: _as<String>(j['status']) ?? 'NONE',
        trackId: _as<String>(j['trackId']),
        title: _as<String>(j['title']),
        artist: _as<String>(j['artist']),
        album: _as<String>(j['album']),
        startedAt: _time(j['startedAt']),
        duration: _num(j['duration']),
        serverTime: _time(j['serverTime']),
        ad: j['ad'] is Map<String, dynamic> ? AdOnAir.fromJson(j['ad'] as Map<String, dynamic>) : null,
      );
}

class LyricLine {
  const LyricLine({required this.start, required this.end, required this.text});

  final double start;
  final double end;
  final String text;

  factory LyricLine.fromJson(Map<String, dynamic> j) => LyricLine(start: _num(j['start']) ?? 0, end: _num(j['end']) ?? 0, text: _as<String>(j['text']) ?? '');
}

class Lyrics {
  const Lyrics({required this.trackId, required this.status, this.lines = const [], this.plain = const []});

  final String trackId;
  final String status;

  /// Synchronized lines (empty when there are none).
  final List<LyricLine> lines;

  /// Unsynchronized text lines (fallback).
  final List<String> plain;

  bool get synced => lines.isNotEmpty;
  bool get hasText => synced || plain.isNotEmpty;

  factory Lyrics.fromJson(Map<String, dynamic> j) => Lyrics(
        trackId: _as<String>(j['trackId']) ?? '',
        status: _as<String>(j['status']) ?? 'NONE',
        lines: (j['lines'] is List ? (j['lines'] as List) : const []).whereType<Map<String, dynamic>>().map(LyricLine.fromJson).toList(),
        plain: (j['plain'] is List ? (j['plain'] as List) : const []).whereType<String>().toList(),
      );
}

class VoteOption {
  const VoteOption({required this.hashtag, required this.votes});

  final String hashtag;
  final int votes;
}

class VoteView {
  const VoteView({required this.status, this.options = const [], this.totalVotes = 0, this.pollId, this.closesAt, this.winner, this.playUntil, this.myVote});

  /// NONE | OPEN | PLAYING
  final String status;
  final List<VoteOption> options;
  final int totalVotes;
  final String? pollId;
  final DateTime? closesAt;
  final String? winner;
  final DateTime? playUntil;
  final String? myVote;

  bool get open => status == 'OPEN' && options.isNotEmpty;

  static const none = VoteView(status: 'NONE');

  factory VoteView.fromJson(Map<String, dynamic> j) {
    final poll = j['poll'] is Map<String, dynamic> ? j['poll'] as Map<String, dynamic> : null;
    return VoteView(
      status: _as<String>(j['status']) ?? 'NONE',
      options: (poll?['options'] is List ? poll!['options'] as List : const [])
          .whereType<Map<String, dynamic>>()
          .map((o) => VoteOption(hashtag: _as<String>(o['hashtag']) ?? '', votes: (_num(o['votes']) ?? 0).toInt()))
          .toList(),
      totalVotes: (_num(poll?['totalVotes']) ?? 0).toInt(),
      pollId: _as<String>(poll?['id']),
      closesAt: _time(poll?['closesAt']),
      winner: _as<String>(j['winner']),
      playUntil: _time(j['playUntil']),
      myVote: _as<String>(j['myVote']),
    );
  }

  VoteView withMyVote(String? tag) => VoteView(status: status, options: options, totalVotes: totalVotes, pollId: pollId, closesAt: closesAt, winner: winner, playUntil: playUntil, myVote: tag);
}

class Sponsor {
  const Sponsor({required this.id, required this.name, required this.ctaLabel, required this.url, this.tagline, this.weight = 1, this.logoUrl});

  final String id;
  final String name;
  final String? tagline;
  final String ctaLabel;
  final int weight;
  final String? logoUrl;

  /// Click-through address on the server (counts the click, then redirects to the advertiser).
  final String url;

  factory Sponsor.fromJson(Map<String, dynamic> j) => Sponsor(
        id: _as<String>(j['id']) ?? '',
        name: _as<String>(j['name']) ?? '',
        tagline: _as<String>(j['tagline']),
        ctaLabel: _as<String>(j['ctaLabel']) ?? '',
        weight: (_num(j['weight']) ?? 1).toInt(),
        logoUrl: _as<String>(j['logoUrl']),
        url: _as<String>(j['url']) ?? '',
      );
}

class LiveMessage {
  const LiveMessage({required this.id, required this.text, required this.level});

  final String id;
  final String text;

  /// INFO | WARN
  final String level;

  bool get warn => level == 'WARN';

  factory LiveMessage.fromJson(Map<String, dynamic> j) => LiveMessage(id: _as<String>(j['id']) ?? '', text: _as<String>(j['text']) ?? '', level: _as<String>(j['level']) ?? 'INFO');
}
