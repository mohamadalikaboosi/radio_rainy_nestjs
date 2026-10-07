import 'package:url_launcher/url_launcher.dart';

Future<void> openExternal(Uri uri) async {
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}
