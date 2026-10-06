import 'dart:convert';

import 'package:http/http.dart' as http;

import '../core/server_address.dart';
import 'models.dart';

class ApiException implements Exception {
  ApiException(this.message, [this.statusCode]);

  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}

/// The public, unauthenticated radio API of a server (`/radio/...`). Nothing here needs a login.
class ApiClient {
  ApiClient(this.address, {http.Client? client}) : _http = client ?? http.Client();

  final ServerAddress address;
  final http.Client _http;
  static const _timeout = Duration(seconds: 12);

  Future<List<Station>> stations() async {
    final body = await _get('/radio/stations');
    return (body is List ? body : const []).whereType<Map<String, dynamic>>().map(Station.fromJson).toList();
  }

  Future<Current> current(String slug) async => Current.fromJson(_map(await _get('/radio/$slug/current')));

  Future<Lyrics?> lyrics(String slug) async {
    final m = _map(await _get('/radio/$slug/current/lyrics'));
    return m.isEmpty ? null : Lyrics.fromJson(m);
  }

  Future<VoteView> vote(String slug, String voterId) async => VoteView.fromJson(_map(await _get('/radio/$slug/vote', {'voterId': voterId})));

  Future<VoteView> castVote(String slug, String voterId, String hashtag) async {
    final res = await _http
        .post(address.resolve('/radio/$slug/vote'), headers: {'content-type': 'application/json'}, body: jsonEncode({'voterId': voterId, 'hashtag': hashtag}))
        .timeout(_timeout);
    return VoteView.fromJson(_map(_decode(res)));
  }

  Future<List<Sponsor>> sponsors(String slug) async {
    final body = await _get('/radio/$slug/sponsors');
    return (body is List ? body : const []).whereType<Map<String, dynamic>>().map(Sponsor.fromJson).toList();
  }

  /// The audio stream of a station. [low] asks for the light data-saver stream.
  Uri streamUri(String slug, {bool low = false}) => address.resolve('/radio/$slug/stream', low ? {'quality': 'low'} : null);

  /// Turns a server-relative path (`/radio/ads/<id>/image`) into a full address.
  Uri absolute(String path) => path.startsWith('http') ? Uri.parse(path) : address.resolve(path);

  Future<Object?> _get(String path, [Map<String, String>? query]) async => _decode(await _http.get(address.resolve(path, query)).timeout(_timeout));

  Object? _decode(http.Response res) {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      String msg = 'Server answered ${res.statusCode}';
      try {
        final j = jsonDecode(utf8.decode(res.bodyBytes));
        if (j is Map && j['message'] is String) msg = j['message'] as String;
      } catch (_) {/* keep the generic message */}
      throw ApiException(msg, res.statusCode);
    }
    if (res.bodyBytes.isEmpty) return null;
    return jsonDecode(utf8.decode(res.bodyBytes));
  }

  Map<String, dynamic> _map(Object? v) => v is Map<String, dynamic> ? v : <String, dynamic>{};

  void close() => _http.close();
}
