# radio_rainy — Architecture & Design (v1, pre-implementation)

Status: **DRAFT — waiting for approval.** No application code exists yet.

## 0. Repository inspection

Repo is empty (no commits, no `package.json`). Greenfield decisions:

| Area | Choice | Why |
|---|---|---|
| Framework | NestJS 10 + TypeScript (`strict`, `noImplicitAny`, no `any`) | Modular DI, testable, fits the module list in the spec |
| Package manager | pnpm (workspace: `apps/api`, `apps/admin`) | Fast, strict, monorepo-friendly |
| Telegram | **GramJS** (`telegram` npm, MTProto user client) | Mature, `iterDownload` gives chunked range download; not Bot API |
| DB | PostgreSQL + Prisma | Transactions, `FOR UPDATE`, advisory locks, partial indexes |
| Jobs | BullMQ + Redis | Retries, backoff, dedupe by `jobId`, concurrency, repeatable jobs |
| ASR | Whisper-compatible HTTP server (faster-whisper-server / whisper.cpp server / OpenAI-style `/v1/audio/transcriptions`) with `timestamp_granularities=word,segment` | Keeps heavy ML out of Node process |
| Audio | `ffmpeg` (child process) for 16 kHz mono preprocessing | Standard |
| Admin UI | React + Vite SPA in `apps/admin`, talks only to `/admin/*` | Separate app, zero business logic |
| Tests | Jest (unit + integration), Testcontainers-free: integration uses fakes for Telegram/Whisper/Telegraph, real Postgres+Redis via docker-compose in CI | |
| Validation | `zod` for env config, `class-validator` for DTOs | Fail-fast at boot |
| Logging | `pino` (nestjs-pino), redaction of secrets | Structured logs |

## A. Architecture diagram

```
                       Telegram (MTProto)
                              │
                     ┌────────▼─────────┐
                     │  TelegramClient  │  auth, reconnect, FloodWait, rate limit
                     └───┬──────────┬───┘
        history/updates  │          │  iterDownload (chunks, offset)
                ┌────────▼───┐   ┌──▼──────────────┐
                │ TrackDisco │   │ TelegramMedia   │  (AudioSource impl)
                │ very+Parse │   │ Source          │
                └────┬───────┘   └──┬───────────┬──┘
   hashtags,caption  │              │           │ (2nd, independent read,
                     ▼              │           │  once per track, cached
              ┌───────────┐         │           │  on disk temp, deleted after)
              │ PostgreSQL│◄────────┘           ▼
              └─┬───▲─────┘          ┌───────────────────┐
                │   │                │ AudioPreprocessor │ ffmpeg → 16k mono wav/flac
                │   │                └─────────┬─────────┘
   RadioRuleEngine  │                          ▼
   (pure, seedable) │                ┌───────────────────┐   Telegraph ─► LyricsSource
        │           │                │ TranscriptionProv │        │
        ▼           │                │ (Whisper HTTP)    │        ▼
 RadioScheduler ──► PlaybackEngine   └─────────┬─────────┘   LyricsService (cache)
        │              │  pulls chunks                 │              │
        │              ▼                                ▼              │
        │        AudioStreamService              LyricsAlignmentService◄┘
        │   (ring buffer + pacing + fan-out)             │
        │              │                                 ▼
        │              ▼                            SyncedLyrics (DB)
        │        GET /radio/stream ──► Listeners         │
        │                                                ▼
        └──────────► RadioState ───► GET /radio/current, /current/lyrics(/active)

  Admin UI (React) ─► /admin/* (JWT, SUPER_ADMIN) ─► RadioConfigurationService
                                                     ─► RadioRuleEngine (same one)
```

Key point: **playback path and lyrics path are decoupled.** The radio only needs
`Track.status = READY` (audio). Lyrics state is a separate lifecycle and can never block/stop the stream.

### Streaming design (the tricky part)

* HTTP radio must be **real-time**, not download-speed. `PlaybackEngine` pulls chunks from
  `AudioSource` (Telegram `iterDownload`, 512 KiB chunks, backpressure-aware async iterator) and
  `AudioStreamService` **paces** output to the track's bitrate (`bytes/sec = filesize/duration`, ±small
  prebuffer burst of ~5 s so listeners start instantly).
* One producer → `Broadcaster`: keeps a small ring buffer (last ~N seconds) and per-listener
  `Writable` queues. New listener gets the ring-buffer tail then live chunks. Telegram file is
  downloaded **once per track play**, not per listener.
* Slow listener: bounded queue; when full, chunk dropped for that listener / listener disconnected
  (never blocks producer, never grows RAM).
* Listener `close`/`error` → unsubscribed in `finally` (no leaks). Test asserts subscriber count returns to 0.
* Track transition: producer ends → engine emits `TRACK_ENDED` → history row closed → scheduler picks next
  → new source attached to the **same** broadcaster, so HTTP connections stay open across tracks
  (MP3 frames concatenate fine; for non-MP3 containers, we transcode via ffmpeg to a uniform MP3 stream
  — see risk R2).
* Download error mid-track → retry from last offset once (Telegram `iterDownload` supports `offset`);
  if still failing → mark event, skip track, select another.
* Position = `now - startedAt` (wall clock, minus paused time), clamped to `duration`.

## B. Database schema (Prisma-style, PostgreSQL)

```
Track
  id UUID PK
  telegramChannelId BIGINT
  telegramMessageId INT
  title, artist?, album?  TEXT
  duration INT?                       -- seconds
  mimeType?, fileSize BIGINT?
  telegramFileReference TEXT          -- document id + access_hash (serialized); refreshed on sync
  telegramPostUrl TEXT?
  lyricsUrl TEXT?
  captionRaw TEXT?
  status  ENUM(READY, FAILED, UNAVAILABLE)   -- audio availability
  lyricsStatus ENUM(LYRICS_NONE, LYRICS_PENDING, LYRICS_PROCESSING, LYRICS_READY, LYRICS_FAILED)
  enabled BOOL default true                 -- admin toggle
  playCount INT default 0, lastPlayedAt TIMESTAMPTZ?
  deletedAt TIMESTAMPTZ?                    -- Telegram message gone
  createdAt, updatedAt
  UNIQUE(telegramChannelId, telegramMessageId)
  INDEX(status, enabled) WHERE deletedAt IS NULL   -- playable set
  INDEX(lyricsStatus), INDEX(lastPlayedAt), INDEX(artist), INDEX(album)
  GIN/trigram INDEX on (title || artist || album) for search

Lyrics
  id UUID PK, trackId UUID UNIQUE FK, sourceUrl TEXT, rawText TEXT?,
  contentHash TEXT, status ENUM(PENDING, FETCHED, FAILED), error TEXT?,
  fetchedAt, expiresAt (LYRICS_CACHE_TTL), createdAt, updatedAt
  INDEX(sourceUrl)  -- same page reused by several tracks -> one fetch

SyncedLyrics
  id UUID PK, trackId FK, version INT, lines JSONB [{start,end,text,confidence}],
  quality REAL, algorithmVersion TEXT, transcriptId?, createdAt, updatedAt
  UNIQUE(trackId, version); "current" = max(version)

Transcript
  id, trackId FK, provider, model, language, segments JSONB, words JSONB?, audioHash, createdAt
  UNIQUE(trackId, audioHash, provider, model)   -- idempotent retries, skip re-run of Whisper

PlaybackHistory
  id, trackId FK, startedAt, endedAt?, endReason ENUM(FINISHED, SKIPPED, ERROR, ADMIN)?
  INDEX(startedAt DESC), INDEX(trackId, startedAt DESC)

SyncState                      -- incremental sync
  channelId PK, lastMessageId INT, lastFullSyncAt, updatedAt

Hashtag
  id, value (display, original), normalizedValue UNIQUE, createdAt
TrackHashtag
  trackId FK, hashtagId FK, PK(trackId, hashtagId), INDEX(hashtagId)

RadioConfiguration               -- single active row (id = 1) + version
  id, mode ENUM(GLOBAL_RANDOM, HASHTAG_RANDOM, HASHTAG_ROTATION, CUSTOM_RULE),
  hashtagMatchMode ENUM(ANY, ALL), recentTrackWindow INT, enabled BOOL,
  version INT (bumped on every change), updatedBy, updatedAt
RadioHashtagSelection            -- hashtag config, separate entity
  configId FK, hashtagId FK, weight INT default 1, position INT (rotation order)
  PK(configId, hashtagId)
RadioRule
  id, name, priority INT, matchMode ENUM(ANY, ALL), weight INT, enabled BOOL, createdAt, updatedAt
  UNIQUE(priority) DEFERRABLE  -- deterministic ordering; ties impossible
RadioRuleHashtag
  ruleId FK, hashtagId FK, kind ENUM(INCLUDE, EXCLUDE), PK(ruleId, hashtagId, kind)

RadioState                       -- single row
  id=1, status ENUM(PLAYING, STOPPED, IDLE, ERROR), currentTrackId?, startedAt?,
  nextTrackId?, configurationVersion INT, transitionSeq BIGINT, updatedAt
  -- transitionSeq: optimistic concurrency token for skip / play-next

HashtagStats                     -- pre-aggregated, refreshed by job/on play (not per dashboard hit)
  hashtagId PK, trackCount, playableCount, failedLyricsCount, plays, lastPlayedAt, updatedAt

AdminUser
  id, email UNIQUE, passwordHash (argon2id), role ENUM(SUPER_ADMIN), createdAt
AuditLog
  id, at, actorId FK, action TEXT, entityType, entityId, before JSONB, after JSONB, requestId
  INDEX(at DESC), INDEX(entityType, entityId)   -- no secrets ever stored
```

Notes: Telegram stays the source of truth for content; we store metadata + file reference only, never audio.
Audio needed for Whisper is streamed to a temp file, processed, deleted.

## C. Module structure

```
apps/api/src/
  config/          zod-validated env (fails on boot), typed ConfigService
  database/        PrismaService, transactions helper, advisory-lock helper
  telegram/        TelegramClient(+Factory), FloodWaitHandler, CaptionParser, HashtagExtractor,
                   TelegramTrackDiscovery, TelegramMediaSource
  track/           TrackService, TrackRepository, HashtagService
  lyrics/          LyricsService, LyricsSource (iface), TelegraphLyricsSource, TelegraphHtmlParser, LyricsRepository
  transcription/   TranscriptionProvider (iface), WhisperTranscriptionProvider, AudioPreprocessor(ffmpeg)
  alignment/       LyricsAlignmentService, normalize.ts, similarity.ts, dpAligner.ts   (pure, no I/O)
  radio/           RadioScheduler, RadioRuleEngine (pure), TrackSelectionStrategy(s), RadioConfigurationService,
                   RadioStateService, RecentTracks, WeightedRandom, SeededRng
  playback/        PlaybackEngine (state machine), PlaybackHistoryService, AudioSource (iface)
  streaming/       AudioStreamService, Broadcaster, Pacer, RadioController(stream/current/lyrics)
  jobs/            queues, processors: telegram-sync, lyrics-fetch, audio-transcription, lyrics-alignment
  admin/           AdminAuthModule (JWT, RolesGuard), AdminControllers, AuditService, StatsService
  common/          logging, request-id, error types, redaction
apps/admin/        React SPA (Dashboard, Radio{Config,Rules,Preview,History}, Tracks, Hashtags, Lyrics, Audit)
```

Rule: no service > ~300 lines; `alignment/` and `radio/RadioRuleEngine` have **zero** framework/I-O deps.

## D. Core interfaces

```ts
interface AudioInput { trackId: string; source: () => AsyncIterable<Uint8Array>; hint?: { mime?: string; duration?: number } }
interface Transcript { language?: string; segments: TranscriptSegment[]; words?: TranscriptWord[]; provider: string; model: string }
interface TranscriptSegment { start: number; end: number; text: string }
interface TranscriptWord    { start: number; end: number; text: string; probability?: number }
interface TranscriptionProvider { transcribe(input: AudioInput, signal?: AbortSignal): Promise<Transcript> }

interface LyricsSource { fetch(url: string, signal?: AbortSignal): Promise<string> }   // returns clean plain text
interface AudioSource  { open(track: TrackRef, opts?: { offset?: number; signal?: AbortSignal }): AsyncIterable<Uint8Array> }

interface AlignedLine { start: number; end: number; text: string; confidence: number }
interface LyricsAligner { align(lyrics: string, transcript: Transcript): AlignmentResult }
type AlignmentResult = { ok: true; lines: AlignedLine[]; quality: number } | { ok: false; reason: 'EMPTY_LYRICS'|'EMPTY_TRANSCRIPT'|'LOW_COVERAGE' }

// Radio — pure
interface SelectionInput { config: RadioConfigurationSnapshot; rules: RadioRuleSnapshot[]; candidates: TrackWithHashtags[];
                           recentTrackIds: string[]; rotationCursor?: number }
interface SelectionResult { trackId: string | null; matchedRuleId?: string; reason: string; eligibleCount: number; nextCursor?: number }
class RadioRuleEngine { select(input: SelectionInput, rng: Rng): SelectionResult;
                        preview(input: SelectionInput, limit: number, seed: number): PreviewResult }  // preview loops select() with simulated history
```

### Alignment algorithm (the sensitive part — designed explicitly)

Whisper gives *what was sung + when*; the Telegraph page gives *what should be shown*. They are joined by a
separate global sequence alignment:

1. **Normalize** both sides: NFKC, lowercase, strip diacritics/punctuation, unify apostrophes/ZWNJ/Arabic-Persian
   letter variants (ي/ی, ك/ک), collapse whitespace. Keep original line text for output.
2. **Tokenize** lyrics into words with `(lineIdx, wordIdx)`; drop section markers (`[Chorus]`, `(x2)`) from matching but keep/skip in output by rule.
   ASR side: use **word timestamps** if provider returns them; otherwise split each segment's words and
   distribute times linearly across the segment (documented degraded mode, lower confidence).
3. **DP alignment** (Needleman–Wunsch/semi-global, monotonic): score matrix over `lyricsWords × asrWords`,
   match score = `2*sim − 1` where `sim` = normalized Levenshtein similarity (≥0.75 counts as a match), gap
   penalties for skipped lyric words (missing in audio) and extra ASR words (hallucination, ad-libs).
   Banded (Sakoe–Chiba, band ≈ 15% of length + slack) → O(n·band), safe for long songs.
   Monotonicity is what solves **repeated chorus / duplicated lines**: each lyric occurrence is mapped to the
   *next* unconsumed occurrence in time, never to an arbitrary earlier one.
4. **Line timing**: `start` = time of first matched word in the line, `end` = time of last matched word
   (or next line's start, whichever sensible). Multiple lines inside one Whisper segment work naturally
   because we align at word level. Lines with no matched words are **interpolated** between neighbours proportional
   to word counts, `confidence` low.
5. **Quality gate**: `quality = matchedWords / lyricsWords`. Below threshold (default 0.35) → `ok:false LOW_COVERAGE`
   → `LYRICS_FAILED` (radio unaffected). Enforce `start[i] ≤ end[i] ≤ start[i+1]`.
6. Pure function, deterministic, versioned via `algorithmVersion`.

Honest caveat: Whisper on *sung* music is noticeably worse than on speech (vocals mixed with instruments).
Mitigations: preprocessing (mono 16k, optional loudnorm), `large-v3`-class model, `language` hint, VAD off for
music, and optional **vocal separation (demucs)** as a pluggable preprocessing step in phase 2. The alignment layer is
built to tolerate 30–50% wrong ASR words.

### RadioRuleEngine semantics

* **Eligibility** and **probability** are separate steps:
  1. `eligible = enabled ∧ READY ∧ ¬deleted ∧ matches(hashtag rule)`
  2. remove tracks in `recentTrackIds` (last `recentTrackWindow`, window clamped to `eligible.length − 1`; if that empties the set, fall back to "all eligible except the current one")
  3. `pick = weightedRandom(eligible, weightOf, rng)` — cumulative-sum / Efraimidis–Spirakis, **no track duplication**. Track weight for hashtag modes = max (configurable: sum) of the weights of its matching selected hashtags.
* `GLOBAL_RANDOM`: all enabled tracks, uniform.
* `HASHTAG_RANDOM`: hashtags + `ANY|ALL` (+ optional per-hashtag weights).
* `HASHTAG_ROTATION`: ordered hashtag groups; cursor advances each selection (persisted in `RadioState`); a group with no eligible track is skipped.
* `CUSTOM_RULE`: rules sorted by `priority ASC` (unique) — **first rule that yields a non-empty eligible set wins**, deterministic;
  each rule = INCLUDE hashtags (ANY/ALL) − EXCLUDE hashtags; optional `weight` used when several rules share a "weighted group" mode (v1: priority strictly decides; weight scales pick probability of the rule's tracks in mixed evaluation — to be confirmed, see Open Questions). Last fallback = global random (toggle).
* RNG injected: `SeededRng(mulberry32)` in preview/tests, `crypto` in production. Same engine class in radio, `/admin/radio/preview`, and tests.

## E. State machines

**Track audio**: `READY → FAILED` (download error ×N) `→ READY` (successful retry/sync refresh); `READY|FAILED → UNAVAILABLE` (msg deleted in Telegram); `UNAVAILABLE → READY` (msg reappears).

**Track lyrics**: `LYRICS_NONE` (no URL) | `LYRICS_PENDING → LYRICS_PROCESSING → LYRICS_READY`; any step failure → `LYRICS_FAILED` (retryable by admin or backoff) ; `LYRICS_FAILED → LYRICS_PENDING` on reprocess.

**Radio**: `IDLE`(no playable tracks/no config) ⇄ `PLAYING` ⇄ `STOPPED`(admin) ; any → `ERROR` (Telegram down + nothing cached; recovers automatically with backoff).

**PlaybackEngine**: `IDLE → SELECTING → OPENING → STREAMING → ENDING → SELECTING…`; `OPENING/STREAMING → (error) → SKIPPING → SELECTING`.
`SELECTING` with empty set → `IDLE` and timer-based wake (event-driven on sync/config change; no busy loop).

## F. Background job design

| Queue | Trigger | Job id (idempotency) | Concurrency | Retries |
|---|---|---|---|---|
| `telegram-sync` | boot, cron (every N min), `POST /admin/sync`, new-message event | `sync:<channel>` (dedupe while active) | 1 | 5, exp. backoff, FloodWait → delay = wait seconds |
| `lyrics-fetch` | track upserted with `lyricsUrl` | `lyrics-fetch:<trackId>:<urlHash>` | 4 | 5, exp. |
| `audio-transcription` | lyrics fetched OK | `transcribe:<trackId>:<audioHash>` | 1–2 (GPU/CPU bound) | 4, long backoff |
| `lyrics-alignment` | transcript stored | `align:<trackId>:<transcriptId>:<algoVersion>` | 4 | 2 (deterministic, so failure = data problem) |

Flow: `sync → upsert Track → enqueue lyrics-fetch → enqueue audio-transcription → enqueue lyrics-alignment → SyncedLyrics(v+1) + LYRICS_READY`.
Idempotency: DB unique constraints + deterministic job ids + upserts; transcripts cached so a retry of alignment never re-runs Whisper.
Playback engine is **not** a queue job: it's an in-process singleton guarded by a Postgres advisory lock (leader election), so multiple workers/instances never run two radios.
Whisper needs the audio: `audio-transcription` streams the Telegram file via `TelegramMediaSource` → ffmpeg → temp file (bounded, deleted in `finally`) → provider.

## G. Error / retry strategy

| Failure | Behaviour |
|---|---|
| Telegram disconnected | GramJS auto-reconnect + our supervisor with backoff; radio keeps using DB tracks; already-open stream continues to buffer end; status `ERROR` only if nothing can be played |
| FloodWait(N s) | Central `FloodWaitHandler`: sleeps/delays job N s (+jitter), global limiter for Telegram calls, never spins |
| File reference expired | Refetch message by id, update `telegramFileReference`, retry once |
| Download failure mid-play | resume from offset once → else skip track, log, mark `FAILED` after N consecutive failures |
| Telegraph 404/invalid URL/network | typed errors; 404/invalid = `LYRICS_FAILED` (no retry until URL changes), network = retry with backoff |
| Empty / changed HTML | Parser is structure-agnostic (see below); empty text → `LYRICS_FAILED(EMPTY)` |
| Whisper down/timeouts | job retried with backoff; track keeps playing; `LYRICS_FAILED` after max attempts, admin can reprocess |
| Alignment low coverage | `LYRICS_FAILED(LOW_COVERAGE)`, no retry |
| Empty channel | RadioState `IDLE` + reason; wakes on sync/config event |
| Config change during playback | takes effect on next selection; `Apply Immediately` = explicit, guarded by `transitionSeq` |

Telegraph parser: fetch via Telegraph public API (`api.telegra.ph/getPage?path=…&return_content=true`) first (stable JSON node tree),
fallback to HTML parse of `<article>`→`<body>`; block-level walk (`p`, `br`, `h*`, `li`) preserving line breaks, drops title/author/footer/scripts,
decodes entities. No class-name selectors. URL validated (host allow-list `telegra.ph`/`graph.org`, https only → SSRF-safe).

Logging: pino, JSON, request/job ids, redaction of `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, auth headers, passwords.

## H. Testing strategy

* **Unit (pure)**: CaptionParser/URL/hashtag extraction (many caption shapes), Telegraph parser (fixtures incl. broken HTML), normalization, aligner (repeated chorus, mismatch, missing lines, punctuation, multi-line segment, RTL/Persian), `RadioRuleEngine` (ANY/ALL, weights distribution via seeded chi-square-ish check, recent window edge cases, rotation, priorities, exclusions, the Song A–E scenario from the spec), seeded preview determinism.
* **Service tests with fakes**: `FakeTelegramClient`, `FakeTranscriptionProvider`, `FakeLyricsSource`. Discovery idempotency (run sync 3×, same count), deleted-message detection, incremental sync.
* **Streaming**: Broadcaster with fake AudioSource — start, multiple listeners get identical bytes, source read exactly once, listener disconnect frees subscription, slow listener bounded, track transition keeps connection, download failure → skip.
* **Concurrency**: parallel skip ×N produces exactly one transition (`transitionSeq`), concurrent config updates → monotonic `configurationVersion`, two engines → only advisory-lock holder plays.
* **Integration (docker-compose Postgres + Redis)**: full flow from spec §20 with fakes at the 3 external edges; failure scenarios (Telegram down, Whisper down, Telegraph 404).
* **API/e2e**: admin auth (401/403 for non-super-admin), audit rows written, public endpoints leak nothing internal.
* CI gates: `tsc --noEmit`, eslint (`no-explicit-any`, `no-empty`), jest.

## I. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Whisper on music is inaccurate | Alignment tolerant to noise; quality gate; optional demucs; model/lang config |
| R2 | Mixed container/codec in channel (mp3/m4a/ogg/flac) breaks a continuous HTTP stream | Normalize live stream through ffmpeg to one MP3/AAC bitrate (extra CPU, once per track, not per listener) — **decision needed** |
| R3 | Telegram file download speed can be below real-time, or throttled (FloodWait on `upload.getFile`) | Prebuffer next track early; DC-aware chunk sizes; skip on stall timeout |
| R4 | User accounts on MTProto: ToS/ban risk if abused | Conservative rate limits, single session, no bulk actions |
| R5 | Position drift between server clock and client audio buffer | API returns `position` + `serverTime`; client adds its buffer latency; documented |
| R6 | Multiple instances double-play | Advisory-lock leader election + `transitionSeq` |
| R7 | Session string handling | Env only, redacted in logs, never returned by any API |

## J. Delivery plan (incremental, each step: implement → test → tsc → review)

1. Scaffold (pnpm workspace, strict TS, eslint, config, DB schema/migrations, logging, docker-compose)
2. Pure cores: alignment engine, RadioRuleEngine, WeightedRandom/SeededRng, caption/hashtag parser, Telegraph parser (+ tests)
3. Telegram client + discovery + sync job + TrackService/Hashtags
4. Lyrics/transcription/alignment jobs pipeline
5. PlaybackEngine + AudioStreamService + public radio API
6. Radio configuration, rules, preview, state/concurrency, admin API, auth, audit, stats
7. Admin UI (React)
8. Integration & failure tests, hardening, README/runbook

## K. Open questions (need your answer before I start)

1. **Codec normalization (R2)**: OK to run live stream through ffmpeg → one MP3 128k stream (recommended), or pass-through raw files (only works if the channel is all-MP3)?
2. **Whisper deployment**: which one do you have — self-hosted faster-whisper / whisper.cpp server, or OpenAI API? (I'll target an OpenAI-compatible `/v1/audio/transcriptions` endpoint by default.)
3. **Redis + Postgres** OK as required infra (docker-compose provided)?
4. **Admin auth**: seeded SUPER_ADMIN from env (`ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`) + JWT login — OK? Or you want an external IdP?
5. **Custom-rule `weight`**: I propose priority = strict order (first rule with eligible tracks wins); `weight` only applies among rules that share the same priority tier. OK?
6. Multiple weighted hashtags on one track: use **max** weight (recommended) or **sum**?

---

## Implementation notes (deviations from this design)

The design above was approved with the following answers and then implemented; where the code differs from the text above, the code wins:

* **DB access**: plain `pg` + SQL migrations (`apps/api/src/database/migrations.ts`) instead of Prisma — direct control of `FOR UPDATE`, advisory locks and partial indexes, and no engine download step.
* **Codec/latency**: MP3 is passed through (ID3 stripped, bitrate measured from size/duration); everything else is transcoded by ffmpeg to MP3 128k. Defaults tuned for low latency (2 s burst, 4 KiB slices, 128 KiB Telegram chunks, next-track prefetch, continuous pacing timeline).
* **Whisper**: optional (`WHISPER_URL` unset ⇒ feature off, no errors). OpenAI-compatible `/v1/audio/transcriptions`.
* **Infra**: Postgres + Redis; Redis is also used for pub/sub of admin commands to the leader.
* **Admin auth**: single SUPER_ADMIN from env (`ADMIN_EMAIL`, scrypt `ADMIN_PASSWORD_HASH`) + JWT (HS256, 8 h), login rate limiting. No `admin_users` table.
* **Telegram session**: created from the panel (phone/code/2FA) and stored **encrypted (AES-256-GCM)** in `telegram_session`; `TELEGRAM_SESSION` env is only an optional bootstrap.
* **Custom rules**: strict priority; rules sharing a priority form a tier where `weight` applies. Track weight across several weighted hashtags = **max**.
* **Extra**: public player page (`/`), admin panel (`/panel`) served by the API, audit log with secret scrubbing, hashtag stats table refreshed every 60 s.

### Update: multi-channel, panel-managed settings, live stream, language layer

* **Stations**: one `channels` row per Telegram channel (key = Telegram channel id). `radio_configuration`, `radio_hashtag_selection`, `radio_rules`, `radio_state` are per channel; tracks are scoped by `telegram_channel_id`. The leader's `StationManager` runs one `PlaybackEngine` + `Broadcaster` (+ optional `TelegramLiveStreamer`) per started channel and reconciles with the DB on `stations-changed`.
* **Settings**: `app_settings` (plain JSONB + one AES-256-GCM ciphertext for secrets, context-bound AAD). Telegram API id/hash, Whisper and LLM settings are edited in the panel; env is a fallback.
* **Live in Telegram**: RTMP ingest through MTProto (`phone.createGroupCall`/`getGroupCallStreamRtmpUrl`), ffmpeg publisher, backoff, status on the channel row.
* **Whisper input**: mono FLAC at a configurable sample rate (default 48 kHz).
* **Language layer**: script-based fa/en detection, per-language learned lexicon (`lexicon_entries`), optional OpenAI-compatible LLM review, retrain and JSONL export. Statistical learning only; no in-app neural fine-tuning.

