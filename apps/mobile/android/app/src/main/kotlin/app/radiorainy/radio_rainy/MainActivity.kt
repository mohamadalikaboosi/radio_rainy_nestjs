package app.radiorainy.radio_rainy

import com.ryanheise.audioservice.AudioServiceActivity

/** audio_service needs its own activity so the playback service and the UI share the Flutter engine. */
class MainActivity : AudioServiceActivity()
