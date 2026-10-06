import 'package:audio_service/audio_service.dart';
import 'package:audio_session/audio_session.dart';
import 'package:flutter/material.dart';

import 'app.dart';
import 'audio/radio_audio_handler.dart';
import 'core/settings.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final settings = await Settings.load();
  // "music" session: other apps pause for the radio, and the radio ducks / pauses for calls and navigation prompts
  final session = await AudioSession.instance;
  await session.configure(const AudioSessionConfiguration.music());
  final handler = await AudioService.init(
    builder: RadioAudioHandler.new,
    config: const AudioServiceConfig(
      androidNotificationChannelId: 'app.radiorainy.playback',
      androidNotificationChannelName: 'Radio playback',
      androidNotificationOngoing: true,
      androidStopForegroundOnPause: true,
    ),
  );
  runApp(RadioApp(settings: settings, player: BackgroundRadioPlayer(handler)));
}
