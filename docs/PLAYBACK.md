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
| `RADIO_PREFETCH_SECONDS` | 30 | select + download the next track this long before the current one ends |
| `RADIO_PREFETCH_TIMEOUT_SECONDS` | 15 | wait for the prepared track's first bytes before replacing it |
| `AUDIO_CACHE_DIR` | `$TMP_DIR/audio-cache` | cache directory (a volume in Docker) |
| `AUDIO_CACHE_MAX_MB` | 1024 | size limit, LRU eviction; `0` disables |
| `AUDIO_CACHE_CONCURRENT_FILLS` | 2 | parallel Telegram downloads |
| `METRICS_TOKEN` | – | enables `/metrics` (Bearer token) |
