# radio_rainy 🌧

A Telegram-powered music radio. It reads a Telegram **channel** with the real MTProto client (GramJS — *not* the Bot API), streams random tracks continuously over HTTP to any number of listeners, and synchronizes lyrics (from Telegraph pages) with the audio using Whisper + a sequence-alignment algorithm. A **Super Admin panel** controls everything (Telegram login, hashtag-based selection modes, rules, tracks, lyrics, audit) without redeploying.

```
Telegram ─► TelegramClient ─► Track discovery ─► Postgres ◄── Admin API/UI (React)
               │                   │                 ▲
               │                   └► hashtags       │  RadioRuleEngine (pure, seedable)
               ▼                                     │  used by: live radio, admin preview, tests
        Audio pipeline ─► Pacer ─► Broadcaster ─► GET /radio/stream ─► listeners
               │
               └► (jobs) ffmpeg ─► Whisper ─► Transcript ─┐
        Telegraph ─► Lyrics ───────────────────────────────┴► Alignment ─► SyncedLyrics ─► /radio/current/lyrics(/active)
```

## Run everything with Docker

One command starts Postgres, Redis, MinIO and the app (API + admin panel + radio stream + ffmpeg):

```bash
cp .env.example .env        # fill TELEGRAM_SESSION_ENCRYPTION_KEY and JWT_SECRET (the admin login is created on first start)
docker compose up -d --build
```

Panel + stream: http://localhost:3000 (`APP_PORT` in `.env` changes the host port). Inside compose `DATABASE_URL`/`REDIS_URL` point at the containers, so you don't set them.
In the panel: Settings -> Telegram (API id/hash), log in, add a channel and start it. For MinIO use endpoint `minio`, port `9000`, key/secret `radiorainy` / `radiorainy-secret`.
Logs: `docker compose logs -f app`. Update: `git pull && docker compose up -d --build`. Data lives in the `pg-data`, `redis-data` and `minio-data` volumes.
The Telegram RTMPS live stream needs the container to reach `*.rtmp.t.me:443` (use a system-wide VPN if that host is filtered where you run it).

## Quick start

Requirements: Node 22+, pnpm, PostgreSQL 16, Redis 7, **ffmpeg** (non-MP3 tracks, Whisper preprocessing, live stream in Telegram).

```bash
pnpm install
docker compose up -d                     # postgres + redis (or use your own)
cp .env.example .env                     # fill the REQUIRED block (5 values), nothing else is needed
pnpm --silent --filter @radio_rainy/api hash-password 'your-admin-password'   # -> ADMIN_PASSWORD_HASH
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # -> TELEGRAM_SESSION_ENCRYPTION_KEY, and again for JWT_SECRET
pnpm build
node --env-file=.env apps/api/dist/main.js        # or, for development:  pnpm dev:api  +  pnpm dev:admin
```

Everything else is configured **in the admin panel** (`http://localhost:3000/panel`), no redeploy needed:

1. **Settings** → Telegram API ID + hash (from https://my.telegram.org). The hash is stored **encrypted** in the database and is write-only.
2. **Telegram** → log in: phone → code → 2FA password. The session is stored encrypted (AES-256-GCM) — a session string cannot be *hashed* because the client needs the original; admin passwords are hashed with scrypt.
3. **Channels** → add one or more channels (`@username`, `t.me` link or id). **Each channel is its own radio station** (own tracks, hashtags, rules, config, history, stream `/radio/<slug>/stream`). Press **Start** to put a station on air.
4. Optional: **Stream inside Telegram** (toggle per channel) also publishes the station to the channel's live stream / voice chat, so the music plays in Telegram too (see below).
5. Optional: **Settings** → **Audio storage (MinIO)**, Whisper (URL/model/language/sample rate) and LLM.

* **Live control** (the panel's landing page): for every station what is on air *right now* (title, artist, progress, the lyric line being sung, listeners, Telegram live status), a big **Next** button (skips safely — a stale/double click is ignored by the server), **Play a track…** (search → play now) and **Queue next…** (plays after the current track, no cut), **Peek likely next**, **Listen here** (monitor the stream in the browser) and Start/Stop.
* **Reports** (period 24h/7d/30d/90d, all channels or one): KPIs (plays, airtime, unique tracks, average/peak listeners, listener-minutes, skip and error rate), plays over time, audience over time, how plays ended, top tracks/artists/hashtags, lyrics status/language/quality/failure reasons, library health per channel, tracks needing attention, recent playback errors, **system health** (database, Telegram, job queues, integrations, audio cache, stations) and **CSV export** (plays, tracks). Every chart has a "View as table" alternative. Audience numbers come from a sample of each running station's listener count every 30 s (kept 90 days).
* Player: `http://localhost:3000/` (station picker + live synchronized lyrics) · Admin panel: `http://localhost:3000/panel`

### Configuration (environment)

Only these are **required**: `DATABASE_URL`, `REDIS_URL`, `TELEGRAM_SESSION_ENCRYPTION_KEY` (encrypts all stored secrets), `JWT_SECRET` (≥ 32 chars).

**Super Admin login.** The first start seeds the user **`admin` / `admin`** in the database (nothing is read from the env afterwards). The server refuses every request except *change password* until that default password is replaced, so the default is only ever valid for the first login. Change it later under *Account & password*. Forgot it? Reset from the server: `pnpm --filter @radio_rainy/api reset-admin-password admin [newPassword]` (Docker: `docker compose exec app node dist/scripts/reset-admin-password.js admin`); without a password a random one is printed and a change is forced at the next login. Optional: set `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` (`hash-password`) to seed a different first admin instead (no forced change).
Telegram API id/hash, Whisper and LLM settings are stored in the DB (panel); the matching `TELEGRAM_API_*` / `WHISPER_*` env vars are just an optional fallback. Tuning: `RADIO_PREBUFFER_SECONDS` (default **2**, lower = lower latency), `RADIO_STREAM_BITRATE_KBPS`, `RADIO_RECENT_TRACK_WINDOW` (default for *new* channels), `WHISPER_SAMPLE_RATE` (default **48000**), `LYRICS_CACHE_TTL`, `TELEGRAM_SYNC_INTERVAL_SECONDS`, `QUEUE_PREFIX`, `FFMPEG_PATH`, `TMP_DIR`, `ADMIN_UI_DIR`, `LOG_LEVEL`, `PORT` — see `.env.example`.

The app **refuses to start** with an invalid/missing required configuration and lists every problem. Secrets are never logged (pino redaction + config redaction) and never returned by any API.

### Audio cache in MinIO (optional)

`docker compose up -d` also starts MinIO (`localhost:9000`, console `localhost:9001`, user/password in `docker-compose.yml` — change them). In **Settings → Audio storage** enter endpoint, access/secret key and press *Test connection*; the bucket is created automatically.
When enabled, *every* audio read (radio, Telegram live stream, Whisper) goes through the cache: **hit** → streamed from MinIO (Telegram is not touched); **miss** → downloaded from Telegram **once**, streamed to the listener and written to MinIO at the same time (a skipped or failed download never leaves a partial object; the fill still completes after a skip). If MinIO is down or a read fails, playback transparently falls back to Telegram. Objects are keyed by channel + message + Telegram file identity, so an edited/replaced Telegram file is re-downloaded. Files above 64 MB are streamed without caching. Bound disk usage with a MinIO bucket lifecycle/quota. Keys are stored encrypted like every other secret. Any S3-compatible server works.

### Telegram live stream (music inside Telegram)

With *Stream inside Telegram* enabled on a started channel, the leader asks Telegram (MTProto `phone.createGroupCall` with `rtmp_stream` + `phone.getGroupCallStreamRtmpUrl`) for the channel's RTMP ingest and pushes the radio audio there with ffmpeg (MP3 in → AAC 48 kHz + a still video frame, as Telegram requires video). It reconnects with backoff and shows `LIVE` / `ERROR` (+ reason, e.g. `CHAT_ADMIN_REQUIRED`) on the Channels page.
Requirements: the logged-in account is an **admin of the channel with the "Manage Live Streams" right**, and ffmpeg is installed.

### Whisper input: 48 kHz

Every track is converted (ffmpeg) to **mono FLAC at 48 kHz** (configurable in Settings) before it is sent to Whisper. Note: Whisper models resample to 16 kHz internally, so a higher rate does not improve accuracy by itself; it is supported because it was requested and costs only bandwidth.

### Persian / English learning ("trainable" language layer)

* **Language detection** per track from the lyrics' script (Persian `fa` / English `en` / `mixed`) → the right Whisper `language` hint is sent per song.
* **Learned lexicon** (`Language` page): while aligning, the system records spelling differences between what Whisper wrote and what the official lyrics say (`cuz → because`, colloquial Persian forms, …) separately for fa/en. A pair is trusted after it is seen in 2 songs (or approved by an admin / the LLM) and then makes future alignments more accurate. **Re-train** re-aligns already transcribed songs with what has been learned, without calling Whisper again.
* **LLM review** (optional, Settings → LLM; any OpenAI-compatible endpoint such as local Ollama): approves/rejects learned spellings in bulk.
* **Dataset export** (`GET /admin/language/export`, JSONL: lyrics + ASR segments + timed lines) for fine-tuning a speech model *outside* this app.
* What this is **not**: the app does not fine-tune neural model weights itself (that needs GPUs and a training pipeline). It learns a corrections lexicon from your data and exports a training set.

## Public API

| Endpoint | |
|---|---|
| `GET /radio/stations` | started stations: `[{slug, title, live}]` |
| `GET /radio/:slug/stream` | continuous `audio/mpeg` for one station; one Telegram download per track shared by all listeners |
| `GET /radio/:slug/current` | `{status, trackId, title, artist, startedAt, duration, position, serverTime}` |
| `GET /radio/:slug/current/lyrics` | `{trackId, status: READY\|PENDING\|PROCESSING\|FAILED\|NONE\|PLAIN, lines:[{start,end,text}]}` |
| `GET /radio/:slug/current/lyrics/active` | `{index, start, end, text, position}` (`index: -1` when nothing is sung) |

| `GET /radio/:slug/sponsors` | active sponsors `[{id,name,tagline,ctaLabel,logoUrl,url}]` (`url` is a tracked redirect) |
| `GET /radio/:slug/vote?voterId=` · `POST /radio/:slug/vote {voterId,hashtag}` | the running tag vote (`NONE\|OPEN\|PLAYING`) / cast a vote |
| `GET /radio/ads/:id/image` · `/radio/sponsors/:id/logo` · `/radio/go/{ad,sponsor}/:id` | artwork and click-counting redirects |
| `WS /radio/:slug/ws` · `WS /radio/:slug/audio` | live control channel / optional WebSocket audio (see below) |
| `GET /metrics` | Prometheus metrics (needs `METRICS_TOKEN`, see `docs/PLAYBACK.md`) |

`/radio/:slug/current` returns `status: "AD"` with an `ad` object while an audio ad is on air.
The unprefixed `/radio/stream`, `/radio/current`, … remain and serve the default station (first started channel).

### Live sockets and the audio transport

* **`/radio/:slug/ws`** – a read-only WebSocket per listener: on connect a `hello` (what is on air, the vote, announcements, listener/client counts, the station's audio transport), then pushes `current` (track/ad changed), `vote`, `messages`, `counts`. The page no longer polls while it is connected (a slow safety-net poll remains) and finds the active lyric line itself from the server clock.
* **Redis pub/sub** feeds it: the leader engine, the tag vote and the announcement endpoints publish tiny "something changed" hints (`radio_rainy:realtime`); every instance builds the message from the database for the sockets *it* holds, so a listener can connect to any instance, nothing is computed for a station nobody watches, and each instance announces how many sockets it holds so `clients` is the sum over instances.
* **Announcements** – the operator (and a station owner for their station) posts a message that appears on every listener's screen immediately and expires by itself (panel → *Tag vote, transport & announcements*).
* **Audio transport (per station, panel → Engagement)**: **HTTP MP3** (default, recommended) or **WebSocket**. The WebSocket mode is `/radio/:slug/audio`: the *same* shared stream (one download, one ffmpeg) as binary frames into the browser's Media Source. Browsers without MSE for MP3 (e.g. iPhone) and any failure fall back to HTTP automatically; the HTTP URL keeps working for other apps in both modes. Only the leader instance can serve audio sockets.
* **Telegram live without pasting a link**: with no manual link saved, the station starts the channel's live stream itself over MTProto (getFullChannel → getGroupCall → createGroupCall(rtmp_stream) → getGroupCallStreamRtmpUrl) and pushes the radio to it with ffmpeg. An empty normal voice chat is replaced; one with people in it is never ended. Failures name the step and the Telegram error (e.g. `CHAT_ADMIN_REQUIRED` = the logged-in account needs the "Manage Live Streams" right).
* **Landing page** at `/` (what it is, stations on air with what they play, features, how it works, links to the advertiser portal and the panel). The full player moved to **`/listen`** (the PWA starts there).
* **Permanent station address**: every station gets a UUID when it is created (`channels.public_id`, immutable: a database trigger rejects any change) and its own page at **`/<uuid>`** (copy it in *Channels* or the owner portal). The page is locked to that station — no station picker, no other station reachable — so you can hand each station its own address; the title or slug may change, the link never does. (`/s/<slug>` still works.) The landing page lists all stations and links to these addresses.
* **Data saver (`?quality=low`)**: `/radio/:slug/stream?quality=low` (also `/audio?quality=low`) is a mono ~48 kbps MP3 for slow networks, produced by one shared ffmpeg per station that only runs while someone listens. The player has an Auto/High/Low selector (Auto drops to low on save-data / 2g-3g / repeated stalls). Falls back to the normal stream if ffmpeg is unavailable. See `docs/PLAYBACK.md`; env `RADIO_LOW_QUALITY_ENABLED`, `RADIO_LOW_BITRATE_KBPS`.

### Customer portal, campaigns and billing (free by default)

Customers sign up at **`/partner`** (separate session from the operator panel). Advertisers create campaigns (audio, optional image/link, station, dates, play cap) → **the operator approves** (*Campaign review*) → they play between tracks and show their stats. Operators can give a station to an account (*Channels → Owner*): the owner sees listeners/plays and can change the station's engagement settings and post announcements.

**Billing is OFF by default** (panel → *Billing & access*): nothing is charged, limited or blocked for money. Turn it on later and per-play / per-click prices apply against each account's credit (ledger; the operator adds credit manually, a payment gateway can be plugged in behind `addLedger`); an account without credit stops airing by itself. Also switchable there: open sign-up, mandatory approval, max campaigns per account.

### Player (PWA) and languages

The public page (`/`) is an installable PWA (manifest + service worker that caches only the app shell; the stream and API always go to the network), with lock-screen controls (Media Session), an equalizer when no synchronized lyrics exist, the ad/sponsor/vote UI and a language switcher.

**Adding a language:** copy `apps/admin/src/i18n/locales/en.json` to `<code>.json` (e.g. `ar.json`), translate the values, set `_meta.name` (shown in the switcher) and `_meta.dir` (`rtl` for Arabic/Persian/Hebrew). Nothing else to change; tests check that placeholders (`{n}`) match English and that no unknown keys are used. Missing keys fall back to English. English and Persian ship with the app; the panel's older pages still contain English-only text.

### Engagement (per station, panel → *Engagement & ads*)

* **Audio ads** – upload MP3 (other formats are transcoded by ffmpeg), optional image and link; played after every *N* tracks (0 = off), weighted, all stations or one. Listeners see the image and a button while the ad plays.
* **Sponsors** – banner with a button (link, tagline, logo, date window); views and clicks are counted.
* **Tag vote** – every *X* minutes listeners are offered a few tags; after *Y* minutes the winner plays for *Z* minutes, then the normal selection resumes.
* **Telegram live: link + key** – instead of letting the app create the live stream through your account, paste Telegram's *Server URL* and *Stream key* (like OBS) on the Channels page. The key is stored encrypted and never returned by the API.

## Admin API (`Authorization: Bearer <jwt>`, SUPER_ADMIN enforced server-side on every route)

`POST /admin/auth/login` · `GET /admin/dashboard` · **channels**: `GET|POST /admin/channels`, `DELETE /admin/channels/:cid[?deleteTracks=true]`, `POST /admin/channels/:cid/{start,stop,sync}`, `PUT /admin/channels/:cid/live` · **per-channel radio** under `/admin/channels/:cid/radio/`: `dashboard`, `config` (GET/PUT), `rules` (POST/PUT/DELETE), `preview`, `skip`, `play-next`, `queue-next`, `history` · **live & reports**: `GET /admin/live`, `GET /admin/reports?range=&channel=`, `GET /admin/reports/system`, `GET /admin/reports/export.csv?type=plays|tracks` · `GET /admin/tracks` (search + filters incl. `channel`) · `GET /admin/tracks/:id` · `PATCH /admin/tracks/:id/enabled` · `POST /admin/tracks/:id/{process-lyrics,refresh-metadata}` · `GET /admin/hashtags`, `/stats` · **settings**: `GET /admin/settings`, `PUT /admin/settings/{telegram,whisper,llm}` · **language**: `GET /admin/language/{stats,lexicon,export}`, `PATCH|DELETE /admin/language/lexicon`, `POST /admin/language/{review,retrain}` · `POST /admin/sync` · `GET /admin/audit` · `GET /admin/telegram/status` · `POST /admin/telegram/login/{start,code,password,cancel}` · `POST /admin/telegram/logout`

## How it works (short)

* **Selection** — `RadioRuleEngine` is a pure function `(config, rules, candidates, history, rng) → track`. Eligibility (which tracks may play) is separate from probability (weights, no duplicated tracks). Modes: `GLOBAL_RANDOM`, `HASHTAG_RANDOM` (ANY/ALL + weights), `HASHTAG_ROTATION`, `CUSTOM_RULE` (priority tiers, include/exclude). The same engine serves the live radio, `/admin/radio/preview` (deterministic per `seed`) and tests. The UI contains no selection logic.
* **Concurrency** — config writes lock the channel's config row, bump `configurationVersion`, support `expectedVersion` (409 on conflict) and are audited; skip/play-next are commands executed by the single playback engine (idempotent, `transition_seq` guard); the leader (Postgres advisory lock) runs one player per started channel; admin commands (skip, play-next, config-changed, stations-changed) travel over Redis pub/sub.
* **Code structure** — DDD bounded contexts (`catalog`, `radio`, `lyrics`, `engagement`, `accounts`, `administration`, `live`, `realtime`), each with `domain` / `application` (+ ports) / `infrastructure` (adapters) / `interface` layers. The dependency rules are enforced by a test: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
* **Streaming / latency** — Telegram chunks (128 KiB) → optional ffmpeg (non-MP3) → pacer (real-time, `RADIO_PREBUFFER_SECONDS` burst on a *continuous timeline* so latency does not grow at track changes) → broadcaster (short ring buffer for instant join, bounded per-listener backlog, slow listeners dropped). The next track is selected `RADIO_PREFETCH_SECONDS` (30) before the end, downloaded into the local **disk cache** and verified READY (broken/slow/corrupt ones are replaced while the current track still plays) → gapless transitions. Broken downloads resume from the last byte. Full architecture, protocol decision, failure handling and metrics: **[docs/PLAYBACK.md](docs/PLAYBACK.md)**.
* **Lyrics** — Telegraph (JSON API, HTML fallback, no CSS-selector coupling) → ffmpeg 16 kHz mono → Whisper (word timestamps when available) → **monotonic word-level DP alignment** (Levenshtein similarity; handles repeated choruses, missing lines, ASR errors, multiple lines per segment) → versioned `synced_lyrics`. Jobs: `telegram-sync`, `lyrics-fetch`, `audio-transcription`, `lyrics-alignment` (BullMQ, retries + backoff, idempotent, cached). Lyrics failures never affect playback.
* **Resilience** — Telegram down / not logged in ⇒ radio state `ERROR` with backoff, tracks are *not* penalised; download failure ⇒ track skipped (`FAILED` after 3 consecutive failures, restored by the next sync); empty channel ⇒ `IDLE` (no busy loop).

## Development

```bash
scripts/dev-services.sh                  # start local postgres/redis without docker (sandboxes)
pnpm --filter @radio_rainy/api test      # ~200 tests (real Postgres + Redis; Telegram/Whisper/Telegraph are faked)
pnpm --filter @radio_rainy/admin test
pnpm typecheck && pnpm lint
pnpm --filter @radio_rainy/admin dev     # panel on :5173, proxying /admin and /radio to :3000
```

## Known limitations / operational notes

* **Not verified against the real Telegram / Whisper / ffmpeg** in CI (no credentials there): the MTProto gateway, the Telegram live-stream (RTMP) call, the live ffmpeg transcoder and the Whisper HTTP provider are covered by unit tests and fakes; do a smoke run with your own credentials first.
* Streaming runs on the leader instance; other instances answer `503` on `/radio/:slug/stream`. Put one instance behind your CDN/reverse proxy (disable proxy buffering — `X-Accel-Buffering: no` is already set), or add a relay for large audiences.
* `position` is wall-clock based and may lead what listeners hear by up to `RADIO_PREBUFFER_SECONDS`.
* Whisper is much less accurate on *sung* audio than on speech. Alignment tolerates a lot of noise and reports `LOW_COVERAGE` instead of producing garbage; a vocal-separation preprocessing step (e.g. demucs) would be the next quality improvement.
* Using a personal Telegram account (MTProto user session) is subject to Telegram's ToS/rate limits; the client paces requests and handles FLOOD_WAIT.
* Same-priority rules form a tier; `weight` only matters inside a tier.
