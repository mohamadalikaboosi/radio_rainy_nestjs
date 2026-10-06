import 'package:flutter/widgets.dart';

/// UI texts. English is the base; Persian (RTL) is complete. A missing key falls back to English, then to the key.
class Strings {
  Strings(this.lang);

  final String lang;

  static const supported = [Locale('en'), Locale('fa')];

  static Strings of(BuildContext context) => Strings(Localizations.localeOf(context).languageCode);

  String get(String key, [Map<String, Object> vars = const {}]) {
    var s = _all[lang]?[key] ?? _all['en']![key] ?? key;
    vars.forEach((k, v) => s = s.replaceAll('{$k}', '$v'));
    return s;
  }

  static const Map<String, Map<String, String>> _all = {
    'en': {
      'app.title': 'Radio Rainy',
      'setup.title': 'Connect to a radio',
      'setup.hint': 'Server address or station link',
      'setup.help': 'Paste the address of your radio_rainy server (e.g. radio.example.com), or the link of one station.',
      'setup.connect': 'Connect',
      'setup.invalid': 'This does not look like an address.',
      'setup.unreachable': 'Cannot reach the server: {error}',
      'stations.title': 'Stations',
      'stations.empty': 'No station yet.',
      'stations.onAir': 'On air',
      'stations.offAir': 'Off air',
      'stations.tune': 'Tune in',
      'stations.changeServer': 'Change server',
      'stations.language': 'Language',
      'stations.langAuto': 'Phone language',
      'player.listen': 'Listen live',
      'player.pause': 'Stop',
      'player.offline': 'This station is not on air right now.',
      'player.notFound': 'This station does not exist.',
      'player.ad': 'Advertisement',
      'player.sponsor': 'Sponsor',
      'player.listeners': '{n} listening',
      'player.quality': 'Quality',
      'player.qualityAuto': 'Auto',
      'player.qualityHigh': 'High',
      'player.qualityLow': 'Data saver',
      'player.lowBadge': 'Data saver',
      'player.vote': 'Vote for the next mood',
      'player.votes': '{n} votes',
      'player.voteWinner': 'Now playing: {tag}',
      'player.noLyrics': 'No lyrics for this song.',
      'player.error': 'Playback problem: {error}',
      'common.retry': 'Retry',
    },
    'fa': {
      'app.title': 'رادیو رینی',
      'setup.title': 'اتصال به رادیو',
      'setup.hint': 'آدرس سرور یا لینک ایستگاه',
      'setup.help': 'آدرس سرور radio_rainy (مثلاً radio.example.com) یا لینک یک ایستگاه را وارد کن.',
      'setup.connect': 'اتصال',
      'setup.invalid': 'این شبیه یک آدرس نیست.',
      'setup.unreachable': 'به سرور وصل نشد: {error}',
      'stations.title': 'ایستگاه‌ها',
      'stations.empty': 'هنوز ایستگاهی نیست.',
      'stations.onAir': 'روی آنتن',
      'stations.offAir': 'خاموش',
      'stations.tune': 'گوش بده',
      'stations.changeServer': 'تغییر سرور',
      'stations.language': 'زبان',
      'stations.langAuto': 'زبان گوشی',
      'player.listen': 'پخش زنده',
      'player.pause': 'توقف',
      'player.offline': 'این ایستگاه الان روی آنتن نیست.',
      'player.notFound': 'این ایستگاه وجود ندارد.',
      'player.ad': 'تبلیغ',
      'player.sponsor': 'حامی',
      'player.listeners': '{n} شنونده',
      'player.quality': 'کیفیت',
      'player.qualityAuto': 'خودکار',
      'player.qualityHigh': 'بالا',
      'player.qualityLow': 'کم‌حجم',
      'player.lowBadge': 'کم‌حجم',
      'player.vote': 'رأی برای حال‌وهوای بعدی',
      'player.votes': '{n} رأی',
      'player.voteWinner': 'در حال پخش: {tag}',
      'player.noLyrics': 'برای این آهنگ متنی نیست.',
      'player.error': 'مشکل در پخش: {error}',
      'common.retry': 'تلاش دوباره',
    },
  };
}

extension StringsContext on BuildContext {
  String tr(String key, [Map<String, Object> vars = const {}]) => Strings.of(this).get(key, vars);
}
