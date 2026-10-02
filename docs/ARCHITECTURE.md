# Architecture: DDD bounded contexts + hexagonal (ports & adapters)

The API (`apps/api/src`) is split by **business context** (DDD bounded contexts). Inside each context the code is split by **layer**
(hexagonal architecture). Dependencies only point inwards, and a test (`src/architecture.spec.ts`) fails the build when they don't.

```
                    ┌──────────────────────── a bounded context ────────────────────────┐
  HTTP / WebSocket  │  interface   ──►   application   ──►   domain                      │
  (driving)         │  controllers        use cases           entities, value objects,   │
                    │                     + PORTS             pure rules (no IO)         │
                    │                        ▲                                           │
  Postgres, Redis,  │  infrastructure  ──────┘  implements the ports                     │
  Telegram, ffmpeg  │  ADAPTERS (driven)                                                 │
  (driven)          └────────────────────────────────────────────────────────────────────┘
```

## Layers

| Layer | Contains | May depend on | Must not depend on |
|---|---|---|---|
| `domain` | pure business rules and types: `RadioRuleEngine`, `LyricsAligner`, `Broadcaster`, `Timeline`/pacer, caption parser, campaign state machine | other domains, `shared/kernel`, `zod` | frameworks, IO, `application`, `infrastructure`, `interface` |
| `application` | use cases (`PlaybackEngine`, `RadioScheduler`, `TrackDiscovery`, `LyricsPipeline`, `TagVoteService`, auth services…) and the **ports** they need (`application/ports/*`, abstract classes) | `domain`, other contexts' `application`/ports, `shared/kernel`, `@nestjs/common`, `zod` | `pg`, GramJS, Redis/BullMQ, `fs`, `child_process`, HTTP libs, any `infrastructure`/`interface` |
| `infrastructure` | **adapters**: `Pg*Repository`, `GramJs*`, `Redis*Bus`, `BullMqJobQueue`, ffmpeg wrappers, MinIO, Whisper client, SQL read models | `application` (ports), `domain`, `shared` | `interface` |
| `interface` | driving adapters: Nest controllers, guards, the WebSocket gateway | `application` (ports, use cases), `domain`, `shared/kernel` | any `infrastructure` (except the typed env config) |
| `shared/kernel` | tiny pure helpers: password hashing, session cipher, `TokenService` / `TransactionRunner` ports, timeouts | nothing | everything else |
| `shared/infrastructure`, `shared/interface` | env config, `DatabaseService` (pg pool + migrations), `JwtTokenService`, zod pipe | kernel | contexts' interface |
| *src root* | **composition root**: `app.module.ts`, `admin.module.ts`, `main.ts` wire ports to adapters | everything | — |

A *port* is an abstract class in `application/ports/` (so it doubles as the Nest DI token). The adapter `implements` it
(`PgTrackRepository implements TrackRepository`); the composition root binds them (`{ provide: TrackRepository, useFactory: db => new PgTrackRepository(db) }`).
Use cases are therefore testable with fakes, and swapping Postgres/Redis/Telegram never touches business code.

## Bounded contexts

| Context | Responsibility | Main ports (application/ports) | Main adapters (infrastructure) |
|---|---|---|---|
| `catalog` | tracks, channels, hashtags, Telegram sync, audio storage/cache | `TrackRepository`, `ChannelRepository`, `TrackQueryRepository`, `TelegramGateway`, `TelegramConnection`, `AudioStore` | `PgTrackRepository`…, `GramJsTelegramGateway`, `TelegramClientManager`, `DiskAudioCache`, `MinioAudioStore`, `CachingTelegramGateway` |
| `radio` | what plays next, the single playback timeline, the shared stream, metrics | `RadioStateRepository`, `RadioConfigRepository`, `PlaybackHistoryRepository`, `RadioBus`, `LowQualityStream` | `Pg*Repository`, `RedisRadioBus`, `FfmpegLowQualityStream`, `FfmpegLiveTranscoder`, `PlaybackSupervisor` (leader election) |
| `lyrics` | lyrics fetch, Whisper transcription, alignment, language learning, job queues | `LyricsRepository`, `LexiconRepository`, `JobQueue`, `TranscriptionSource`, `AudioStaging`, `LlmClient`, `LanguageData` | `PgLyricsRepository`, `BullMqJobQueue`, `TelegraphLyricsSource`, `WhisperTranscriptionProvider`, `TelegramAudioStaging` |
| `engagement` | ads, sponsors, tag vote, per-station engagement settings | `AdsRepository`, `SponsorsRepository`, `TagPollRepository`, `EngagementSettingsRepository` | `Pg*Repository` |
| `accounts` | advertiser / station-owner portal, campaigns review, billing switch (off by default) | `AccountsRepository`, `PlatformSettingsRepository` | `Pg*Repository` |
| `administration` | Super Admin login, dashboard, reports, settings, audit log | `AdminUsersRepository`, `AuditService`, `SettingsService`, `ReportsService`, `StatsService`, `DashboardService`, `SystemReportService` | `Pg*` (SQL read models and settings persistence) |
| `live` | Telegram live stream (RTMP), adaptive quality (`domain/live-quality`), ad banner on the video | `TelegramLiveApi`, `RtmpPublisher` | `GramJsLiveApi`, `FfmpegRtmpPublisher`, `NowPlayingText`, `LiveSlide` |
| `realtime` | WebSocket control channel, announcements | `RealtimeBus`, `MessagesRepository` | `RedisRealtimeBus`, `PgMessagesRepository` |

Cross-context rules: a context talks to another through its `application` layer (use cases and ports) or its `domain` types, never through its
adapters. Contexts are wired together only in the composition root.

## Transactions

Use cases that must be atomic (radio configuration changes + audit) use the `TransactionRunner` port from the kernel. Repositories take an opaque
`TxHandle` and only the Postgres adapters look inside it, so no SQL leaks into the application layer.

## Pragmatic exceptions (documented on purpose)

* The `application` layer may use `@nestjs/common` (`@Injectable`, `Logger`, HTTP exceptions) — Nest is the application framework, and wrapping
  every exception would be ceremony without benefit. Everything else framework-like is forbidden there.
* `administration/infrastructure` holds SQL **read models** (reports, dashboard, stats). They are queries, not business rules, so they are adapters behind a port.
* Controllers validate input with `zod` schemas that live next to the port that uses them.

## Testing strategy

* `domain` and use cases: plain unit tests with fakes (no database).
* adapters: integration tests against real Postgres/Redis (`test/test-db.ts`), fake Telegram (`test/fake-telegram.ts`).
* the full app: e2e tests over real HTTP/WebSocket (`*.e2e.spec.ts`, `app.smoke.spec.ts`, `full-flow.e2e.spec.ts`).
* **`src/architecture.spec.ts`** enforces the dependency rules above.

## Adding a feature

1. Model the rule in `<context>/domain` (pure, unit-tested).
2. Write the use case in `<context>/application` and declare what it needs as an abstract class in `application/ports`.
3. Implement the port in `<context>/infrastructure` (adapter) and bind it in `app.module.ts` / `admin.module.ts`.
4. Expose it from `<context>/interface` (controller) calling the use case.
5. Run `pnpm test` — the architecture test tells you if a dependency points the wrong way.
