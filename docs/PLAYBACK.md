# Playback architecture (shared, low-latency radio)

One radio timeline per station serves every listener. Telegram is touched **once per track**, never per listener.

```
            Telegram (MTProto)
                   │   one full-speed download per track (singleflight)
                   ▼
   DiskCachingGateway ──► DiskAudioCache ──► (MinIO, optional, durable copy)
                   │        file .part → atomic rename, LRU size limit
                   │        readers "tail" the growing file (64 KiB reads, no big RAM buffers)
                   ▼
   TrackAudioPipeline  (MP3: stripped + streamed as is │ other formats: ONE ffmpeg per track → MP3)
                   │
   PrefetchedAudio (read-ahead of the first 256 KiB, readiness + sanity check)
                   ▼
   PlaybackEngine  (single writer per station, leader only)
      │   select next track `RADIO_PREFETCH_SECONDS` before the end → READY before the end
      │   pace() = one shared timeline (`RADIO_PREBUFFER_SECONDS` of lead)
      ├──► PlaybackState (Postgres radio_state: started_at, transition_seq)  ──► GET /radio/:slug/current (position = now − started_at)
      ├──► Metrics (RadioMetrics) ───────────────────────────────────────────► GET /metrics (Prometheus, token)
      ▼
   Broadcaster (one ring buffer) ──► HttpListenerSink × N  (GET /radio/:slug/stream)

   independent:  audio ──► Whisper ──► alignment ──► lyrics   (BullMQ workers; never on the playback path)
```

## What each piece owns

| Concern | Owner | Notes |
|---|---|---|
| Telegram access | `GramJsTelegramGateway` | only the engine / Whisper worker call it, never a listener request |
| Audio acquisition + cache | `DiskCachingGateway` → `DiskAudioCache` | hit: read from disk. miss: one download fills the file, even if the player leaves early |
| Download buffer | the cache file + `PrefetchedAudio` | absorbs Telegram jitter: the whole next track is normally on disk before it is needed |
| Playback buffer | `pace()` + `Timeline` | sends `RADIO_PREBUFFER_SECONDS` ahead of real time; a stall beyond that is an *underrun* (counted) and the schedule shifts instead of bursting |
| Listener output buffer | `Broadcaster` ring + `HttpListenerSink` | ring = join burst; per-listener backlog cap drops only that listener |
| Canonical clock | `radio_state.started_at` | `position = now − startedAt`, computed on read. No per-listener clock |
| Transitions | `PlaybackEngine` | prefetch → verify → switch without re-connecting anything; bytes of track B follow track A on the same timeline |

## Format strategy

Telegram tracks are mostly MP3. MP3 is streamed **as is** (ID3v2 stripped so a mid-stream tag can't glitch players). Anything else (m4a, ogg, flac…) goes through **one** ffmpeg process per *track* (not per listener) that outputs the station's standard MP3 (`RADIO_STREAM_BITRATE_KBPS`). No per-listener transcoding exists anywhere.

MP3 frames of consecutive tracks are simply concatenated on the shared timeline. This is gapless at the stream level (no silence is inserted and no connection is re-opened); the audible "gap" a player may add between two *different encodes* (encoder delay/padding, typically 20–50 ms) cannot be removed without re-encoding and is an accepted limitation.

## Streaming protocol decision

**HTTP chunked MP3 (Icecast-style).**

| Option | Latency | Verdict |
|---|---|---|
| HTTP chunked MP3 | ≈ `RADIO_PREBUFFER_SECONDS` (default 2 s) + player buffer | **chosen**: works in every browser/`<audio>`, PWA, car/phone players; one fan-out, trivial to scale and to reconnect |
| WebSocket audio | similar | needs a custom player + MSE; no benefit for radio |
| LL-HLS | 3–6 s | segmenting/ playlists/ more moving parts for higher latency |
| WebRTC | < 1 s | needs SFU/media server, NAT traversal; unnecessary for radio, poor fit for shared music |

## Audio over WebSocket (optional, per station)

The default is HTTP chunked MP3. A station can instead be switched (panel → Engagement) to **binary WebSocket frames** (`/radio/:slug/audio`). The server side is one more `ListenerSink` on the same `Broadcaster` (so still one download and one ffmpeg; the ring buffer gives the same instant start; a socket whose send queue exceeds 512 KiB is dropped like a slow HTTP listener). In the browser the frames are appended to a `MediaSource` `SourceBuffer('audio/mpeg')` (`sequence` mode), old audio is trimmed, and if more than 4 s is buffered ahead the playhead jumps to the live edge.

It is **not** recommended as the default: `<audio>` over HTTP already gives native buffering, background playback and lock-screen controls, works behind any proxy/CDN and on iPhone (which has no MSE for MP3), and WebSocket adds no latency advantage (both are TCP). The player therefore falls back to HTTP automatically when MSE/MP3 is unavailable, when the socket closes (e.g. `1013` on a non-leader instance) or an append fails, and does not retry WebSocket in that session.

The WebSocket **control channel** (`/radio/:slug/ws`) is separate and always on: it carries state, counts and announcements, never audio.

## Data-saver stream (low quality, for slow connections)

`GET /radio/:slug/stream?quality=low` (and `/radio/:slug/audio?quality=low` over WebSocket) serves a lighter mono MP3 (`RADIO_LOW_BITRATE_KBPS`, default 48 kbps vs. 128+) so playback does not stall on poor networks.

* **One ffmpeg per station, never per listener.** `LowQualityStream` re-encodes the station's normal stream once and fans it out through its own `Broadcaster` ring. It starts with the first low listener and stops with the last, so it costs nothing when nobody uses it. Listener counts, metrics and the panel include low listeners (`listenersOf`).
* **Failure:** if ffmpeg cannot start or keeps crashing, `available` turns false for 60 s; `/radio/stations` reports `lowQuality: false` and `?quality=low` is answered with the normal stream, so nobody loses audio. A crashed encoder restarts with back-off; one that falls behind (stdin backlog > 512 KiB) is restarted instead of growing memory.
* **Client:** the player shows a selector (Auto / High / Low) when the station offers it, remembered in `localStorage`. *Auto* starts on low if the browser reports `saveData` or a 2g/3g connection, and switches to low after 3 stalls (`waiting`/`stalled`) in 20 s. Changing the quality while playing rejoins the live edge on the other stream.
* Disable with `RADIO_LOW_QUALITY_ENABLED=false`.

## Telegram live stream: adaptive quality and the ad banner

The Telegram live (RTMP) is a second consumer of the same `Broadcaster`; it is one ffmpeg per station that re-encodes the radio MP3 to AAC + a picture.

* **Cheap encoder (best practice for radio on a video platform).** The video is ONE still PNG at 2-5 frames per second (`-tune stillimage,zerolatency`, 2 threads, keyframe every 2 s), read through a 4-frame queue (every queued frame is an old copy of the slide: 64 frames kept the previous title on screen for 12.8 s). The audio is decoded by a separate small ffmpeg into raw 48 kHz stereo PCM first: the tracks of a station differ in sample rate (44.1 / 48 kHz), and when the encoder decoded the MP3 itself every change rebuilt its filters and restarted the timestamps (with `aresample=first_pts=0` it even padded the whole time since the start of the live with silence at one timestamp, which threw Telegram's player off). PCM has no timestamps, so a track change is invisible to the encoder. Nothing is drawn per frame, so the encoder uses almost no CPU and the bitrate is all audio. The ffmpeg processes run at a lower CPU priority (`nice`) so they can never starve the Node process that feeds the listeners.
* **The picture is rendered outside the live encoder.** When the song or ad changes, ONE short ffmpeg job (`LiveSlide`) draws the new picture - big note, `title` + artist in the lower third, or `AD · name` + the advertiser's banner - into `slide-<channel>.png`, and the live encoder (`-f image2 -loop 1`) re-reads that file for every frame, so there is no restart. The change is applied `TELEGRAM_LIVE_TEXT_DELAY_SECONDS` (default 3) after the radio switched, to match what is heard in the stream (prebuffer + encoder queue). If the picture cannot be drawn (no `drawtext`/font) the reason is logged once (`cannot draw text on the Telegram live picture ...`), the picture goes on without text and the stream is unaffected.
* **Adaptive bitrate (conservative on purpose).** Four rungs (`live-quality.ts`): high 720p/300k+128k audio, medium 480p/200k+96k, low 360p/120k+64k, minimum 240p/60k+48k. Every change restarts ffmpeg, which is a cut for the viewers, so it acts only on clear evidence. It measures the CURRENT speed (`SpeedMeter`: media time produced / wall time over a 12 s sliding window, after a 10 s warm-up) - never ffmpeg's own `speed=`, which is an average since the process start and reads ~0.7-0.9 for a minute even on a perfect link because of the connect/probe delay (acting on it restarted a healthy stream every 20 s). It steps down only when the speed stays below 0.85 for 15 s (cooldown 60 s); a merely slow stream is lowered once per 5 min (if lowering the bitrate did not help, the bottleneck is not the bitrate), a starving one (< 0.6) keeps stepping down; two connection drops within 90 s also step down; after 2 min of perfect speed it tries one rung up (waiting longer if that failed quickly). None of this happens while the radio itself feeds the encoder slower than real time (`SourceRate`: media time of the MP3 frames received / wall time, same window; e.g. a silent transition): the encoder cannot be faster than its input, so those readings, and a drop during them, say nothing about the uplink. The measured speed is logged every 30 s with the source rate (`telegram live: encoder speed`, `source`). `TELEGRAM_LIVE_QUALITY=high|medium|low|minimum` pins one rung and never restarts. How Telegram delivers the stream to *viewers* is Telegram's own; viewers typically see it 5-15 s behind (RTMP ingest + segmenting), which no sender setting can remove.

## Failure handling

| Failure | Behaviour |
|---|---|
| Next track cannot be downloaded | detected **while the current track is still playing** (readiness check) → that track is counted as failed (disabled after 3 in a row), another is selected immediately (up to 3 tries); `radio_prefetch_failovers_total` |
| Next track is slow (`RADIO_PREFETCH_TIMEOUT_SECONDS`) | replaced by another track, **not** blamed |
| Corrupt / garbage audio (no MPEG frame in the first 64 KiB) | rejected before going on air, counted against the track |
| Telegram outage / flood wait | tracks are not penalised; the engine backs off and resumes; already cached tracks keep playing |
| Download interrupted mid-track | resume from the last received byte (`resilientDownload`), from the cache file when possible |
| Cache file corrupted/truncated | size mismatch → deleted and downloaded again; `.part` files are removed on startup |
| ffmpeg fails / missing | the affected track fails and is skipped; MP3 tracks are unaffected |
| Listener disconnects / is too slow | only its sink is removed; the shared engine never stops |
| Lyrics / Whisper slow or failed | never on the playback path (BullMQ); the track stays playable |

## Concurrency and instances

* **Single writer:** exactly one `PlaybackEngine` per station, and only on the **leader** instance (Postgres advisory lock in `PlaybackSupervisor`). Skip / play-next / queue-next / config changes arrive over Redis pub/sub and are executed *by the engine*, which serialises them (`skip()` is idempotent and guarded by the transition `seq`; a finished track and a skip at the same moment yield one transition).
* One download per track: the cache fill is a singleflight per file; a second reader joins the running download.
* **Multiple instances:** the leader is the only radio master, so there is exactly one timeline. Any instance can serve `/radio/:slug/current`, lyrics and the panel (they read Postgres). **`/radio/:slug/stream` only works on the leader** (other instances answer 503): run one app instance (the default `docker compose` setup), or route `/radio/*/stream` to the leader at your reverse proxy. Metrics are per process; scrape the leader.

## Metrics (`GET /metrics`, `METRICS_TOKEN`)

`radio_current_track`, `radio_playback_position`, `radio_listener_count`, `radio_buffer_seconds` (lead sent ahead of real time), `radio_download_speed`, `radio_track_transition_duration{stat="last|max"}`, `radio_track_transitions_total`, `radio_audible_gaps_total`, `radio_track_transition_failures`, `radio_prefetch_failovers_total`, `radio_buffer_underruns`, `radio_telegram_download_failures`, `radio_cache_hits`, `radio_cache_misses`, `radio_cache_evictions`, `radio_cache_corrupted`, `radio_cache_fill_failures`, `radio_cache_bytes`.

"Why was there a 2-second gap?" → look at `radio_audible_gaps_total` (a transition longer than the buffered lead), `radio_track_transition_duration`, `radio_buffer_underruns`, `radio_prefetch_failovers_total`, `radio_telegram_download_failures` and `radio_cache_misses` around that time. The engine also logs `audible gap between tracks` with the gap and the covered milliseconds.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RADIO_PREBUFFER_SECONDS` | 2 | lead/burst for new listeners (lower = lower latency) |
| `RADIO_BUFFER_WHOLE_TRACK` | true | the whole next track is downloaded while the current one plays; a track goes on air only when fully buffered (no stalls mid-track, steady Telegram live) |
| `RADIO_PREFETCH_SECONDS` | 90 | select + download the next track this long before the current one ends |
| `RADIO_PREFETCH_TIMEOUT_SECONDS` | 60 | wait for the prepared track's first bytes before replacing it |
| `AUDIO_CACHE_DIR` | `$TMP_DIR/audio-cache` | cache directory (a volume in Docker) |
| `AUDIO_CACHE_MAX_MB` | 1024 | size limit, LRU eviction; `0` disables |
| `AUDIO_CACHE_CONCURRENT_FILLS` | 2 | parallel Telegram downloads |
| `METRICS_TOKEN` | – | enables `/metrics` (Bearer token) |
