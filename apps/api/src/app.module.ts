import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { LyricsAlignmentService } from './alignment/lyrics-alignment.service';
import { APP_CONFIG, AppConfig, loadConfig } from './config/app-config';
import { DatabaseService } from './database/database.service';
import { BullMqJobQueue } from './jobs/bullmq-job-queue';
import { JOB_QUEUE } from './jobs/job-queues';
import { JobsRunner } from './jobs/jobs-runner';
import { LyricsPipeline } from './jobs/lyrics-pipeline';
import { LyricsRepository } from './lyrics/lyrics.repository';
import { LyricsService } from './lyrics/lyrics.service';
import { TelegraphLyricsSource } from './lyrics/telegraph-lyrics-source';
import { TrackAudioPipeline } from './playback/audio-pipeline';
import { FfmpegLiveTranscoder } from './playback/ffmpeg-live-transcoder';
import { PlaybackEngine } from './playback/playback-engine';
import { PlaybackHistoryRepository } from './playback/playback-history.repository';
import { PlaybackRunner } from './playback/playback-runner';
import { PlaybackSupervisor } from './playback/playback-supervisor';
import { CurrentRadioService } from './radio/current-radio.service';
import { RADIO_BUS, RadioBus, RedisRadioBus } from './radio/radio-bus';
import { RadioConfigRepository } from './radio/radio-config.repository';
import { RadioScheduler } from './radio/radio-scheduler';
import { RadioStateRepository } from './radio/radio-state.repository';
import { Broadcaster } from './streaming/broadcaster';
import { realClock } from './streaming/pacer';
import { RadioController, STREAM_OPTIONS } from './streaming/radio.controller';
import { GramJsTelegramGateway } from './telegram/gramjs.gateway';
import { SessionCipher } from './telegram/session-cipher';
import { TelegramClientManager } from './telegram/telegram-client.manager';
import { TelegramSessionStore } from './telegram/telegram-session.store';
import { TELEGRAM_GATEWAY, TelegramGateway } from './telegram/telegram.types';
import { TelegramTrackDiscovery } from './telegram/track-discovery';
import { TrackRepository } from './track/track.repository';
import { FfmpegPreprocessor } from './transcription/audio-preprocessor';
import { TrackTranscriptionService } from './transcription/track-transcription.service';
import { createTranscriptionProvider } from './transcription/transcription.factory';

/** Composition root: all wiring lives here; classes themselves only depend on interfaces/ports. */
@Global()
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        pinoHttp: {
          level: cfg.LOG_LEVEL,
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.apiHash', '*.session', '*.token'],
            censor: '[REDACTED]',
          },
          autoLogging: { ignore: (req) => (req as { url?: string }).url === '/radio/stream' },
        },
      }),
    }),
  ],
  controllers: [RadioController],
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    { provide: DatabaseService, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new DatabaseService(c) },
    { provide: TrackRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new TrackRepository(db) },
    { provide: LyricsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new LyricsRepository(db) },
    { provide: RadioConfigRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new RadioConfigRepository(db) },
    { provide: RadioStateRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new RadioStateRepository(db) },
    { provide: PlaybackHistoryRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PlaybackHistoryRepository(db) },

    { provide: SessionCipher, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new SessionCipher(c.TELEGRAM_SESSION_ENCRYPTION_KEY) },
    { provide: TelegramSessionStore, inject: [DatabaseService, SessionCipher], useFactory: (db: DatabaseService, c: SessionCipher) => new TelegramSessionStore(db, c) },
    { provide: TelegramClientManager, inject: [APP_CONFIG, TelegramSessionStore], useFactory: (c: AppConfig, s: TelegramSessionStore) => new TelegramClientManager(c, s) },
    { provide: GramJsTelegramGateway, inject: [TelegramClientManager, APP_CONFIG], useFactory: (m: TelegramClientManager, c: AppConfig) => new GramJsTelegramGateway(m, c) },
    { provide: TELEGRAM_GATEWAY, useExisting: GramJsTelegramGateway },

    { provide: BullMqJobQueue, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new BullMqJobQueue({ redisUrl: c.REDIS_URL, prefix: c.QUEUE_PREFIX }) },
    { provide: JOB_QUEUE, useExisting: BullMqJobQueue },
    { provide: RADIO_BUS, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new RedisRadioBus(c.REDIS_URL) },

    {
      provide: LyricsService,
      inject: [LyricsRepository, TrackRepository, APP_CONFIG],
      useFactory: (l: LyricsRepository, t: TrackRepository, c: AppConfig) => new LyricsService(new TelegraphLyricsSource(), l, t, c.LYRICS_CACHE_TTL),
    },
    {
      provide: TrackTranscriptionService,
      inject: [APP_CONFIG, TELEGRAM_GATEWAY, TrackRepository, LyricsRepository],
      useFactory: (c: AppConfig, gw: TelegramGateway, t: TrackRepository, l: LyricsRepository) =>
        new TrackTranscriptionService(createTranscriptionProvider(c), { provider: 'openai-compatible', model: c.WHISPER_MODEL }, gw, new FfmpegPreprocessor(c.FFMPEG_PATH), t, l, c.TMP_DIR, c.WHISPER_LANGUAGE),
    },
    { provide: LyricsAlignmentService, inject: [LyricsRepository], useFactory: (l: LyricsRepository) => new LyricsAlignmentService(l) },
    {
      provide: LyricsPipeline,
      inject: [BullMqJobQueue, LyricsService, TrackTranscriptionService, LyricsAlignmentService, TrackRepository],
      useFactory: (q: BullMqJobQueue, l: LyricsService, t: TrackTranscriptionService, a: LyricsAlignmentService, tr: TrackRepository) => new LyricsPipeline(q, l, t, a, tr),
    },
    {
      provide: TelegramTrackDiscovery,
      inject: [TELEGRAM_GATEWAY, TrackRepository, LyricsPipeline],
      useFactory: (gw: TelegramGateway, t: TrackRepository, p: LyricsPipeline) => new TelegramTrackDiscovery(gw, t, { onLyricsNeedFetch: (id) => p.start(id) }),
    },
    {
      provide: JobsRunner,
      inject: [BullMqJobQueue, LyricsPipeline, TelegramTrackDiscovery, APP_CONFIG],
      useFactory: (q: BullMqJobQueue, p: LyricsPipeline, d: TelegramTrackDiscovery, c: AppConfig) => new JobsRunner(q, p, d, c.TELEGRAM_SYNC_INTERVAL_SECONDS),
    },

    {
      provide: Broadcaster,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => new Broadcaster(Math.round(((c.RADIO_STREAM_BITRATE_KBPS * 1000) / 8) * c.RADIO_PREBUFFER_SECONDS)),
    },
    { provide: RadioScheduler, inject: [RadioConfigRepository, PlaybackHistoryRepository, RadioStateRepository], useFactory: (c: RadioConfigRepository, h: PlaybackHistoryRepository, s: RadioStateRepository) => new RadioScheduler(c, h, s) },
    {
      provide: PlaybackEngine,
      inject: [RadioScheduler, RadioStateRepository, PlaybackHistoryRepository, TrackRepository, TELEGRAM_GATEWAY, Broadcaster, APP_CONFIG],
      useFactory: (sch: RadioScheduler, st: RadioStateRepository, h: PlaybackHistoryRepository, t: TrackRepository, gw: TelegramGateway, b: Broadcaster, c: AppConfig) =>
        new PlaybackEngine({
          scheduler: sch,
          state: st,
          history: h,
          tracks: t,
          audio: new TrackAudioPipeline(gw, new FfmpegLiveTranscoder(c.FFMPEG_PATH), c.RADIO_STREAM_BITRATE_KBPS),
          broadcaster: b,
          options: {
            burstSeconds: c.RADIO_PREBUFFER_SECONDS,
            sliceBytes: 4096,
            preselectSeconds: 20,
            prefetchBytes: 256 * 1024,
            idleRetryMs: 5000,
            maxBackoffMs: 30_000,
            now: realClock.now,
            sleep: realClock.sleep,
          },
        }),
    },
    {
      provide: PlaybackRunner,
      inject: [DatabaseService, PlaybackEngine, RADIO_BUS, PlaybackHistoryRepository, RadioConfigRepository, APP_CONFIG],
      useFactory: (db: DatabaseService, e: PlaybackEngine, bus: RadioBus, h: PlaybackHistoryRepository, rc: RadioConfigRepository, c: AppConfig) =>
        new PlaybackRunner(new PlaybackSupervisor(db, e, bus, h, 5000, () => rc.applyDefaultWindow(c.RADIO_RECENT_TRACK_WINDOW))),
    },
    {
      provide: CurrentRadioService,
      inject: [RadioStateRepository, TrackRepository, LyricsRepository],
      useFactory: (s: RadioStateRepository, t: TrackRepository, l: LyricsRepository) => new CurrentRadioService(s, t, l),
    },
    { provide: STREAM_OPTIONS, useValue: { maxBacklogBytes: 512 * 1024, stationName: 'radio_rainy' } },
  ],
  exports: [APP_CONFIG, DatabaseService, TrackRepository, LyricsRepository, RadioConfigRepository, RadioStateRepository, PlaybackHistoryRepository, TelegramClientManager, TelegramTrackDiscovery, LyricsPipeline, PlaybackEngine, RADIO_BUS, BullMqJobQueue, CurrentRadioService, TelegramSessionStore],
})
export class AppModule {}
