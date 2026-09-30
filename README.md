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

## Quick start

Requirements: Node 22+, pnpm, PostgreSQL 16, Redis 7, **ffmpeg** (non-MP3 tracks + Whisper preprocessing).

```bash
pnpm install
docker compose up -d                     # postgres + redis (or use your own)
cp .env.example .env                     # then fill it in (see below)
pnpm --silent --filter @radio_rainy/api hash-password 'your-admin-password'   # -> ADMIN_PASSWORD_HASH
openssl rand -hex 32                     # -> TELEGRAM_SESSION_ENCRYPTION_KEY
openssl rand -hex 32                     # -> JWT_SECRET
pnpm --filter @radio_rainy/admin build   # builds the panel + player (served by the API)
pnpm --filter @radio_rainy/api build && set -a && . ./.env && set +a && node apps/api/dist/main.js
```

* Player: `http://localhost:3000/`  · Admin panel: `http://localhost:3000/panel`
* **Log in to Telegram from the panel** (Telegram page): phone → code → 2FA password (if any). The session is stored **encrypted (AES-256-GCM)** in the database — a session string cannot be hashed because the client needs the original; passwords (admin) are hashed with scrypt.
* Then press *Full re-sync*. Tracks, hashtags and lyrics jobs appear automatically.

### Configuration

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | ✅ | from https://my.telegram.org |
| `TELEGRAM_CHANNEL` | ✅ | `@username`, invite/`t.me` link or numeric id |
| `TELEGRAM_SESSION_ENCRYPTION_KEY` | ✅ | 64 hex chars |
| `TELEGRAM_SESSION` | – | optional bootstrap only (imported once, encrypted) |
| `DATABASE_URL`, `REDIS_URL` | ✅ | Redis: BullMQ jobs + pub/sub for admin commands |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `JWT_SECRET` | ✅ | `JWT_SECRET` ≥ 32 chars |
| `RADIO_RECENT_TRACK_WINDOW` | – | default 10 (initial value; later managed in the panel) |
| `RADIO_PREBUFFER_SECONDS` | – | default **2**. Lower = lower latency, higher = more resilient |
| `RADIO_STREAM_BITRATE_KBPS` | – | default 128 (transcoded non-MP3 + fallback rate) |
| `WHISPER_URL`, `WHISPER_MODEL`, `WHISPER_API_KEY`, `WHISPER_LANGUAGE` | – | **all optional**. Without `WHISPER_URL` AI sync is simply off (no errors); plain lyrics still work |
| `LYRICS_CACHE_TTL` | – | seconds, default 86400 |
| `QUEUE_PREFIX`, `TELEGRAM_SYNC_INTERVAL_SECONDS`, `FFMPEG_PATH`, `TMP_DIR`, `ADMIN_UI_DIR`, `LOG_LEVEL`, `PORT` | – | see `.env.example` |

The app **refuses to start** with an invalid/missing required configuration and lists every problem. Secrets are never logged (pino redaction + config redaction).

## Public API

| Endpoint | |
|---|---|
| `GET /radio/stream` | continuous `audio/mpeg`; one Telegram download per track shared by all listeners |
| `GET /radio/current` | `{status, trackId, title, artist, startedAt, duration, position, serverTime}` |
| `GET /radio/current/lyrics` | `{trackId, status: READY\|PENDING\|PROCESSING\|FAILED\|NONE\|PLAIN, lines:[{start,end,text}]}` |
| `GET /radio/current/lyrics/active` | `{index, start, end, text, position}` (`index: -1` when nothing is sung) |

## Admin API (`Authorization: Bearer <jwt>`, SUPER_ADMIN enforced server-side on every route)

`POST /admin/auth/login` · `GET /admin/dashboard` · `POST /admin/sync` · `GET /admin/tracks` (search + filters) · `GET /admin/tracks/:id` · `PATCH /admin/tracks/:id/enabled` · `POST /admin/tracks/:id/process-lyrics` · `POST /admin/tracks/:id/refresh-metadata` · `GET /admin/hashtags`, `/stats` · `GET|PUT /admin/radio/config` · `POST|PUT|DELETE /admin/radio/rules` · `POST /admin/radio/preview` · `POST /admin/radio/skip`, `/play-next` · `GET /admin/radio/history` · `GET /admin/audit` · `GET /admin/telegram/status` · `POST /admin/telegram/login/{start,code,password,cancel}` · `POST /admin/telegram/logout`

## How it works (short)

* **Selection** — `RadioRuleEngine` is a pure function `(config, rules, candidates, history, rng) → track`. Eligibility (which tracks may play) is separate from probability (weights, no duplicated tracks). Modes: `GLOBAL_RANDOM`, `HASHTAG_RANDOM` (ANY/ALL + weights), `HASHTAG_ROTATION`, `CUSTOM_RULE` (priority tiers, include/exclude). The same engine serves the live radio, `/admin/radio/preview` (deterministic per `seed`) and tests. The UI contains no selection logic.
* **Concurrency** — config writes lock the singleton row, bump `configurationVersion`, support `expectedVersion` (409 on conflict) and are audited; skip/play-next are commands executed by the single playback engine (idempotent, `transition_seq` guard); the engine runs only on the instance holding a Postgres advisory lock (leader election).
* **Streaming / latency** — Telegram chunks (128 KiB) → optional ffmpeg (non-MP3) → pacer (real-time, `RADIO_PREBUFFER_SECONDS` burst on a *continuous timeline* so latency does not grow at track changes) → broadcaster (short ring buffer for instant join, bounded per-listener backlog, slow listeners dropped). The next track is selected ~20 s before the end and its first 256 KiB prefetched → gapless transitions. Broken downloads resume from the last byte.
* **Lyrics** — Telegraph (JSON API, HTML fallback, no CSS-selector coupling) → ffmpeg 16 kHz mono → Whisper (word timestamps when available) → **monotonic word-level DP alignment** (Levenshtein similarity; handles repeated choruses, missing lines, ASR errors, multiple lines per segment) → versioned `synced_lyrics`. Jobs: `telegram-sync`, `lyrics-fetch`, `audio-transcription`, `lyrics-alignment` (BullMQ, retries + backoff, idempotent, cached). Lyrics failures never affect playback.
* **Resilience** — Telegram down / not logged in ⇒ radio state `ERROR` with backoff, tracks are *not* penalised; download failure ⇒ track skipped (`FAILED` after 3 consecutive failures, restored by the next sync); empty channel ⇒ `IDLE` (no busy loop).

## Development

```bash
scripts/dev-services.sh                  # start local postgres/redis without docker (sandboxes)
pnpm --filter @radio_rainy/api test      # 150+ tests (real Postgres + Redis; Telegram/Whisper/Telegraph are faked)
pnpm --filter @radio_rainy/admin test
pnpm typecheck && pnpm lint
pnpm --filter @radio_rainy/admin dev     # panel on :5173, proxying /admin and /radio to :3000
```

## Known limitations / operational notes

* **Not verified against the real Telegram / Whisper / ffmpeg** in CI (no credentials there): the MTProto gateway, live ffmpeg transcoder and Whisper HTTP provider are covered by unit tests and fakes; do a smoke run with your own credentials first.
* Streaming runs on the leader instance; other instances answer `503` on `/radio/stream`. Put one instance behind your CDN/reverse proxy (disable proxy buffering — `X-Accel-Buffering: no` is already set), or add a relay for large audiences.
* `position` is wall-clock based and may lead what listeners hear by up to `RADIO_PREBUFFER_SECONDS`.
* Whisper is much less accurate on *sung* audio than on speech. Alignment tolerates a lot of noise and reports `LOW_COVERAGE` instead of producing garbage; a vocal-separation preprocessing step (e.g. demucs) would be the next quality improvement.
* Using a personal Telegram account (MTProto user session) is subject to Telegram's ToS/rate limits; the client paces requests and handles FLOOD_WAIT.
* Same-priority rules form a tier; `weight` only matters inside a tier.
