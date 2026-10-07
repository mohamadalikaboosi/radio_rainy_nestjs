# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

radio_rainy: a Telegram-powered music radio. A NestJS API reads Telegram channels as a **user** (MTProto via GramJS, not the Bot API), plays random tracks from them as continuous HTTP MP3 streams (each channel is its own station), and syncs lyrics (Telegraph → Whisper → alignment). Monorepo (pnpm workspace `apps/*`):

- `apps/api` — NestJS 11 + TypeScript, raw `pg` (no ORM), Redis/BullMQ, ffmpeg child processes.
- `apps/admin` — one React 19 + Vite SPA that is the operator panel (`/panel/*`), the advertiser/owner portal (`/partner/*`), the landing page (`/`), the public player (`/listen`, `/s/:slug`, `/:publicId`).
- `apps/mobile` — Flutter listener app (Android/iOS/macOS). It is **not** in the pnpm workspace and uses only the public `/radio/*` API.

In production the API serves the built SPA from the same process (`main.ts`). Non-API `GET`s fall back to `index.html`. If you add a new top-level API prefix, add it to `API_PREFIXES` in `apps/api/src/main.ts` **and** to the dev proxy in `apps/admin/vite.config.ts`.

## Commands

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # what CI runs (.github/workflows/ci.yml)
pnpm dev:api        # API on :3000; loads ../../.env and lets it OVERRIDE shell/IDE env vars (src/scripts/dev-env.ts)
pnpm dev:admin      # Vite on :5173, proxies /admin /portal /metrics /radio (+ws) to API_URL or :3000
docker compose up -d postgres redis   # local services (minio optional)

# single tests (no `--`: pnpm forwards it, and jest then treats -t as a file pattern)
pnpm --filter @radio_rainy/api test radio-rule-engine                    # jest, path regex
pnpm --filter @radio_rainy/api test radio-rule-engine -t "deterministic" # by test name
pnpm --filter @radio_rainy/admin test format                             # vitest, file filter

# api utilities
pnpm --silent --filter @radio_rainy/api hash-password 'pw'          # scrypt hash for ADMIN_PASSWORD_HASH
pnpm --filter @radio_rainy/api reset-admin-password admin [newPw]

# mobile
cd apps/mobile && flutter pub get && flutter analyze && flutter test
```

API tests use Jest `--runInBand` (`*.spec.ts`; e2e files are `*.e2e.spec.ts`). Integration and e2e tests need **real Postgres and Redis**: `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/radio_rainy_test`) and `TEST_REDIS_URL` (default `redis://localhost:6379/15`). docker-compose creates only the `radio_rainy` database, so create `radio_rainy_test` yourself. `freshDb()` in `apps/api/test/test-db.ts` runs `DROP SCHEMA public CASCADE` for each test file, so never point it at a database you care about. Pure domain/application specs run without services. Telegram, Whisper and Telegraph are always faked (`test/fake-telegram.ts`, `test/inline-queue.ts`, `test/engine-harness.ts`).

Lint applies only to the API (the admin `lint` script is a no-op). The rules that matter: `@typescript-eslint/no-explicit-any` is an error, and a `catch` block can't be empty (put a comment in it). The API tsconfig is strict, with `noUncheckedIndexedAccess`.

## API architecture: DDD bounded contexts + hexagonal layers

Read `docs/ARCHITECTURE.md` before adding backend code. `apps/api/src/<context>/{domain,application,infrastructure,interface}` with contexts `catalog`, `radio`, `lyrics`, `engagement`, `accounts`, `administration`, `live` and `realtime`, plus `shared/{kernel,infrastructure,interface}`.

- **`src/architecture.spec.ts` enforces the layering as a test.** `domain` and `shared/kernel` may import only other domain/kernel code, `zod` and a few pure `node:` modules (`crypto`, `path`, `events`, `stream`, `util`, `buffer`). `application` may also import `@nestjs/common` but no IO libraries (`pg`, GramJS, ioredis, `fs`, `child_process`, fetch). `interface` must not import `infrastructure` (only `shared/infrastructure/config` is allowed). Every file must sit in one of the layer folders.
- **Ports** are abstract classes in `<context>/application/ports/` and double as Nest DI tokens. Some ports use string/symbol tokens instead (`RADIO_BUS`, `TELEGRAM_GATEWAY`, `JOB_QUEUE`, `REALTIME_BUS`). Adapters in `infrastructure/` implement them (`PgTrackRepository implements TrackRepository`).
- **The composition root is the only wiring point.** `app.module.ts` handles runtime and public wiring, `admin.module.ts` the admin controllers and services. Wiring is explicit `useFactory` providers, so a new use case or adapter needs a provider entry there. Contexts reference each other only through `application`/ports or `domain`, never another context's adapters.
- Atomic use cases go through the `TransactionRunner` kernel port. Repositories receive an opaque `TxHandle`.
- **Schema migrations** are an append-only array in `apps/api/src/shared/infrastructure/database/migrations.ts` (ids `001_…`, `009_…`). They run automatically on boot under an advisory lock. Add a new entry with the next id and never edit existing ones.

## Runtime model (spans many files)

- **Single writer per station.** `PlaybackSupervisor` takes a Postgres advisory lock. Only the leader instance runs a `PlaybackEngine` per started channel and serves `/radio/:slug/stream` and the audio WebSocket; other instances answer 503. Admin commands (skip, play-next, queue-next, config-changed, stations-changed) travel over Redis pub/sub (`radio_rainy:commands`) and are executed and serialized by the engine (idempotent, guarded by `transition_seq`).
- **Track selection** is `RadioRuleEngine` (`radio/domain`), a pure seedable function. The same engine powers live playback, the admin preview and tests. The UI has no selection logic.
- **Audio path:** Telegram (one download per track, singleflight) → `DiskCachingGateway`/`DiskAudioCache` (+ optional MinIO) → `TrackAudioPipeline` (MP3 as-is; other formats get one ffmpeg per track) → pacer/`Timeline` → `Broadcaster` ring buffer → N listener sinks. The low-quality stream and the Telegram RTMP live push are additional consumers of the same `Broadcaster`. The next track is prefetched and verified before the current one ends. Details, failure handling and metrics: `docs/PLAYBACK.md`.
- **Lyrics** run as BullMQ jobs (`telegram-sync`, `lyrics-fetch`, `audio-transcription`, `lyrics-alignment`) and are never on the playback path. A lyrics failure must not affect playback.
- **Realtime:** `/radio/:slug/ws` (control channel, never audio) is fed by Redis hints on `radio_rainy:realtime`. Every instance rebuilds messages from Postgres for the sockets it holds.
- **Configuration:** env is validated by zod in `shared/infrastructure/config/app-config.ts`, and the app refuses to start on invalid config. Only `DATABASE_URL`, `REDIS_URL`, `TELEGRAM_SESSION_ENCRYPTION_KEY` (64 hex chars) and `JWT_SECRET` are required. Telegram, Whisper, LLM and MinIO settings are normally stored in the DB through the panel, encrypted with `SessionCipher`; the matching env vars are only fallbacks. Secrets must never be logged or returned by an API (pino plus config redaction).
- Stations have an immutable `channels.public_id` UUID (enforced by a DB trigger) that backs the locked `/:publicId` page.

## Frontend notes

- i18n: `apps/admin/src/i18n/locales/{en,fa}.json`. `i18n.test.tsx` fails if a non-English locale uses unknown keys or mismatched `{placeholders}`, and **if Persian is missing any English key**. So adding a string means adding it to both `en.json` and `fa.json`.
- The PWA service worker (`public/sw.js`) caches only the app shell. The stream and the API always go to the network.

## Docs and branches

- `docs/ARCHITECTURE.md` (layers and contexts) and `docs/PLAYBACK.md` (streaming) are current. `docs/DESIGN.md` is the original pre-implementation draft: it mentions Prisma and NestJS 10, which no longer match the code.
- This branch (`claude/ddd-hexagonal`) uses the DDD layout. The default branch `claude/charming-hypatia-odppr3` uses an older **flat** module layout (`src/playback`, `src/telegram`, `src/streaming`, …). When merging features from it, re-home the code into the right context and layer so `architecture.spec.ts` passes.
