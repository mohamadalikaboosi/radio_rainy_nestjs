/// Where the radio_rainy server is, and (optionally) which single station the user pasted.
///
/// Accepted input (everything a person might paste):
///   * `radio.example.com`                → https://radio.example.com
///   * `http://192.168.1.20:3000`          → as is
///   * `https://radio.example.com/<uuid>`  → the server AND the permanent address of one station (locked mode)
///   * `https://radio.example.com/s/<slug>`→ the server and one station by its slug
class ServerAddress {
  const ServerAddress(this.base, {this.stationPublicId, this.stationSlug});

  /// `scheme://host[:port]` without a trailing slash.
  final Uri base;
  final String? stationPublicId;
  final String? stationSlug;

  bool get isStationLink => stationPublicId != null || stationSlug != null;

  static final RegExp _uuid = RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');

  /// Returns null when the text is not an address.
  static ServerAddress? parse(String input) {
    var text = input.trim();
    if (text.isEmpty) return null;
    if (!text.contains('://')) {
      // 10.0.2.2:3000 / localhost:3000 are dev servers (plain http); anything else is assumed to be https
      final hostPart = text.split('/').first.split(':').first.toLowerCase();
      final isLocal = hostPart == 'localhost' || hostPart == '10.0.2.2' || RegExp(r'^\d{1,3}(\.\d{1,3}){3}$').hasMatch(hostPart) || hostPart.endsWith('.local');
      text = '${isLocal ? 'http' : 'https'}://$text';
    }
    final uri = Uri.tryParse(text);
    if (uri == null || !(uri.scheme == 'http' || uri.scheme == 'https') || uri.host.isEmpty) return null;
    final segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
    String? publicId;
    String? slug;
    if (segments.length == 1 && _uuid.hasMatch(segments[0])) {
      publicId = segments[0].toLowerCase();
    } else if (segments.length == 2 && segments[0] == 's' && segments[1].isNotEmpty) {
      slug = segments[1];
    }
    final base = Uri(scheme: uri.scheme, host: uri.host, port: uri.hasPort ? uri.port : null);
    return ServerAddress(base, stationPublicId: publicId, stationSlug: slug);
  }

  Uri resolve(String path, [Map<String, String>? query]) {
    final p = path.startsWith('/') ? path : '/$path';
    return base.replace(path: p, queryParameters: query == null || query.isEmpty ? null : query);
  }

  /// `ws(s)://host/path` for the live channel.
  Uri socket(String path) => Uri(scheme: base.scheme == 'https' ? 'wss' : 'ws', host: base.host, port: base.hasPort ? base.port : null, path: path);

  @override
  String toString() => base.toString();
}
