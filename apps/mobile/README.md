# radio_rainy mobile (Flutter): Android · iOS · macOS

The listener app of radio_rainy: pick a station (or open one station's own link), listen live with the screen off, see the synchronized lyrics,
announcements, the tag vote, sponsors and ads. It talks to the public API of your server (`/radio/...`), nothing here needs a login.
The operator panel and the advertiser portal stay on the web (`/panel`, `/partner`).

## What it does

* **Server**: first start asks for the address of your server (`radio.example.com`, `http://192.168.1.20:3000`, ...) or pastes a **station link**
  (`https://host/<uuid>` or `https://host/s/<slug>`). A station link opens that ONE station, locked (no way to other stations), like the web page.
* **Stations**: all stations, on-air first, with what each plays now; pull to refresh.
* **Player**: big play button; background playback with lock-screen / notification / headset controls and the current song as metadata
  (`audio_service` + `just_audio`; a paused live stream resumes at the live edge); synchronized lyrics highlighted from the *server's* clock; live
  announcements, listener count, vote and sponsors/ads pushed over the WebSocket (`/radio/<slug>/ws`, with reconnect; polling only while it is down).
* **Data saver**: Auto / High / Low. Low uses the station's light stream (`?quality=low`); *Auto* switches to it after 3 stalls in 20 s or when the OS
  reports a slow connection.
* **English and Persian (RTL)**, remembered.

## Run

```bash
cd apps/mobile
flutter pub get
flutter run                 # a connected device / emulator (android, ios, macos)
flutter test && flutter analyze
```

Android emulator → host machine is `http://10.0.2.2:3000`. A real phone on the same Wi-Fi: `http://<your-PC-LAN-ip>:3000`.
**Debug** builds may use plain `http` (Android `usesCleartextTraffic` in `src/debug`, iOS `NSAllowsLocalNetworking`); **release** builds on Android
require `https` (put the server behind a TLS reverse proxy). The app only ever uses the public API of the server you enter.

## Build for release

| Platform | Command | Needs |
|---|---|---|
| Android | `flutter build apk --release` / `flutter build appbundle` | Android SDK, a signing key (`android/key.properties`) for the Play Store |
| iOS | `flutter build ios --release` (then Archive in Xcode) | macOS + Xcode, an Apple developer team (set it in `ios/Runner.xcodeproj`) |
| macOS | `flutter build macos --release` | macOS + Xcode, signing & notarization for distribution |

Application id: `app.radiorainy.radio_rainy` (change `--org` / the bundle ids before publishing). Icons come from `assets/icon*.png`
(`dart run flutter_launcher_icons` regenerates them). CI (`.github/workflows/mobile.yml`) runs analyze + tests and builds the Android APK and the
iOS/macOS apps (unsigned).

## Code map

```
lib/
  core/      ServerAddress (parse server / station links), Settings (shared_preferences)
  data/      models, ApiClient (/radio/*), RealtimeClient (WebSocket)
  domain/    lyrics sync, server-clock position, quality rules (pure, unit-tested)
  audio/     RadioPlayer port, RadioAudioHandler (audio_service + just_audio)
  state/     StationController, StationsController (ChangeNotifier)
  ui/        screens and widgets          l10n/  en + fa strings
test/        unit, controller (fake player / server / socket) and widget tests
```
The player is behind the `RadioPlayer` port, so the controller is tested without a device. Platform notes: Android (`AudioServiceActivity`,
foreground media service, notification permission), iOS (`UIBackgroundModes: audio`), macOS (`network.client` entitlement).
