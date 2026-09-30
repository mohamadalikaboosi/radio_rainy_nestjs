import { Global, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ManualOrAutoLiveApi } from './live/manual-live-api';
import { RadioMetrics } from './metrics/radio-metrics';
import { DiskAudioCache } from './storage/disk-audio-cache';
import { DiskCachingGateway } from './storage/disk-caching-gateway';
import { join } from 'node:path';
import { AuditService } from './admin/audit.service';
import { PORTAL_AUDIT, PortalAuthController, PortalController } from './portal/portal.controllers';
import { PortalAuthService } from './portal/portal-auth.service';
import { PortalGuard } from './portal/portal.guard';
import { randomUUID } from 'node:crypto';
import { HttpAdapterHost } from '@nestjs/core';
import { REALTIME_BUS, RealtimeBus, RedisRealtimeBus } from './realtime/events';
import { ListenerCountPublisher } from './realtime/listener-count-publisher';
import { MessagesRepository } from './realtime/messages.repository';
import { RealtimeService } from './realtime/realtime.service';
import { AccountsRepository } from './portal/accounts.repository';
import { PlatformSettingsRepository } from './portal/platform-settings.repository';
import { AdsRepository } from './engagement/ads.repository';
import { DbAdSource } from './engagement/ad-source';
import { EngagementPublicController } from './engagement/engagement-public.controller';
import { EngagementSettingsRepository } from './engagement/engagement-settings.repository';
import { SponsorsRepository } from './engagement/sponsors.repository';
import { TagPollRepository } from './engagement/tag-poll.repository';
import { TagVoteService } from './engagement/tag-vote.service';
import { TagVoteTicker } from './engagement/tag-vote-ticker';
import { AdminModule } from './admin/admin.module';
import { LyricsAlignmentService } from './alignment/lyrics-alignment.service';
import { ChannelRepository, ChannelRow } from './channels/channel.repository';
import { LexiconRepository } from './language/lexicon';
import { LanguageService } from './language/language.service';
import { LlmClient, OpenAiCompatibleLlm } from './language/llm-client';
import { GramJsLiveApi } from './live/gramjs-live-api';
import { DEFAULT_LIVE_OPTIONS, FfmpegRtmpPublisher, TelegramLiveApi, TelegramLiveStreamer } from './live/telegram-live-streamer';
import { SettingsService } from './settings/settings.service';
import { AudioStoreSource } from './storage/audio-store';
import { SettingsAudioStoreSource } from './storage/audio-store.source';
import { CachingTelegramGateway, resolverFrom } from './storage/caching-gateway';
import { Station, StationManager } from './playback/station-manager';
import { SettingsTranscriptionSource, TranscriptionSource } from './transcription/transcription-source';
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
import { ListenerSampler } from './playback/listener-sampler';
import { PlaybackSupervisor } from './playback/playback-supervisor';
import { CurrentRadioService } from './radio/current-radio.service';
import { RADIO_BUS, RadioBus, RedisRadioBus } from './radio/radio-bus';
import { RadioConfigRepository } from './radio/radio-config.repository';
import { RadioScheduler } from './radio/radio-scheduler';
import { RadioStateRepository } from './radio/radio-state.repository';
import { Broadcaster } from './streaming/broadcaster';
import { realClock } from './streaming/pacer';
import { MetricsController } from './metrics/metrics.controller';
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

/** Attaches the WebSocket server to the HTTP server once the app is up, and closes it (and its Redis connections) on shutdown. */
class RealtimeLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(private readonly realtime: RealtimeService, private readonly host: HttpAdapterHost, private readonly bus: RealtimeBus) {}
  async onApplicationBootstrap(): Promise<void> {
    const server = this.host.httpAdapter?.getHttpServer();
    if (server) await this.realtime.start(server);
  }
  async onModuleDestroy(): Promise<void> {
    await this.realtime.stop();
    await (this.bus as Partial<RedisRealtimeBus>).close?.();
  }
}

/** Composition root: all wiring lives here; classes themselves only depend on interfaces/ports. */
@Global()
@Module({
  imports: [
    AdminModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        pinoHttp: {
          level: cfg.LOG_LEVEL,
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.apiHash', '*.apiKey', '*.session', '*.token'],
            censor: '[REDACTED]',
          },
          // the stream, the panel's polling GETs and the Docker healthcheck would drown the real log lines
          autoLogging: { ignore: (req) => /\/stream$/.test((req as { url?: string }).url ?? '') || ((req as { method?: string }).method === 'GET' && /^\/(admin\/(live|channels|telegram\/status)|radio\/stations)(\?|$)/.test((req as { url?: string }).url ?? '')) },
        },
      }),
    }),
  ],
  controllers: [RadioController, EngagementPublicController, MetricsController, PortalAuthController, PortalController],
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    { provide: DatabaseService, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new DatabaseService(c) },
    { provide: TrackRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new TrackRepository(db) },
    { provide: LyricsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new LyricsRepository(db) },
    { provide: RadioConfigRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new RadioConfigRepository(db) },
    { provide: RadioStateRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new RadioStateRepository(db) },
    { provide: PlaybackHistoryRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PlaybackHistoryRepository(db) },
    { provide: ChannelRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new ChannelRepository(db) },
    { provide: LexiconRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new LexiconRepository(db) },

    { provide: AdsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new AdsRepository(db) },
    { provide: AccountsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new AccountsRepository(db) },
    { provide: PlatformSettingsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PlatformSettingsRepository(db) },
    { provide: PORTAL_AUDIT, inject: [DatabaseService], useFactory: (db: DatabaseService) => new AuditService(db) },
    { provide: PortalAuthService, inject: [AccountsRepository, PlatformSettingsRepository, APP_CONFIG], useFactory: (a: AccountsRepository, p: PlatformSettingsRepository, c: AppConfig) => new PortalAuthService(a, p, { jwtSecret: c.JWT_SECRET, tokenTtlSeconds: 12 * 3600 }) },
    { provide: PortalGuard, inject: [PortalAuthService, AccountsRepository], useFactory: (a: PortalAuthService, acc: AccountsRepository) => new PortalGuard(a, acc) },
    { provide: SponsorsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new SponsorsRepository(db) },
    { provide: EngagementSettingsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new EngagementSettingsRepository(db) },
    { provide: TagPollRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new TagPollRepository(db) },

    { provide: SessionCipher, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new SessionCipher(c.TELEGRAM_SESSION_ENCRYPTION_KEY) },
    {
      provide: SettingsService,
      inject: [DatabaseService, APP_CONFIG],
      useFactory: (db: DatabaseService, c: AppConfig) =>
        new SettingsService(db, new SessionCipher(c.TELEGRAM_SESSION_ENCRYPTION_KEY, 'app-settings'), {
          storage: c.MINIO_ENDPOINT && c.MINIO_ACCESS_KEY && c.MINIO_SECRET_KEY ? { endpoint: c.MINIO_ENDPOINT, port: c.MINIO_PORT, useSsl: c.MINIO_USE_SSL, bucket: c.MINIO_BUCKET, accessKey: c.MINIO_ACCESS_KEY, secretKey: c.MINIO_SECRET_KEY } : undefined,
          telegram: c.TELEGRAM_API_ID && c.TELEGRAM_API_HASH ? { apiId: c.TELEGRAM_API_ID, apiHash: c.TELEGRAM_API_HASH } : undefined,
          whisper: c.WHISPER_URL ? { url: c.WHISPER_URL, model: c.WHISPER_MODEL, apiKey: c.WHISPER_API_KEY, language: c.WHISPER_LANGUAGE, sampleRate: c.WHISPER_SAMPLE_RATE, timeoutSeconds: c.WHISPER_TIMEOUT_SECONDS } : undefined,
        }),
    },
    { provide: TelegramSessionStore, inject: [DatabaseService, SessionCipher], useFactory: (db: DatabaseService, c: SessionCipher) => new TelegramSessionStore(db, c) },
    { provide: TelegramClientManager, inject: [APP_CONFIG, TelegramSessionStore, SettingsService], useFactory: (c: AppConfig, s: TelegramSessionStore, st: SettingsService) => new TelegramClientManager(c, s, st) },
    { provide: GramJsTelegramGateway, inject: [TelegramClientManager, ChannelRepository], useFactory: (m: TelegramClientManager, ch: ChannelRepository) => new GramJsTelegramGateway(m, ch) },
    { provide: RadioMetrics, useFactory: () => new RadioMetrics() },
    { provide: DiskAudioCache, inject: [APP_CONFIG, RadioMetrics], useFactory: (c: AppConfig, m: RadioMetrics) => new DiskAudioCache({ dir: c.AUDIO_CACHE_DIR ?? join(c.TMP_DIR, 'audio-cache'), maxBytes: c.AUDIO_CACHE_MAX_MB * 1024 * 1024, maxConcurrentFills: c.AUDIO_CACHE_CONCURRENT_FILLS }, m.cache) },
    { provide: 'AUDIO_STORE_SOURCE', inject: [SettingsService], useFactory: (s: SettingsService): AudioStoreSource => new SettingsAudioStoreSource(s) },
    {
      // Everything that downloads audio (radio, live stream, Whisper) goes through the MinIO cache when it is configured.
      provide: TELEGRAM_GATEWAY,
      inject: [GramJsTelegramGateway, 'AUDIO_STORE_SOURCE', TrackRepository, DiskAudioCache],
      useFactory: (inner: GramJsTelegramGateway, src: AudioStoreSource, t: TrackRepository, disk: DiskAudioCache): TelegramGateway => {
        const keys = resolverFrom((c, m) => t.getAudioIdentity(c, m));
        // Engine/Whisper -> local disk cache -> (MinIO) -> Telegram
        return new DiskCachingGateway(new CachingTelegramGateway(inner, src, keys), disk, keys);
      },
    },
    { provide: GramJsLiveApi, inject: [TelegramClientManager, GramJsTelegramGateway], useFactory: (m: TelegramClientManager, g: GramJsTelegramGateway) => new GramJsLiveApi(m, g) },
    { provide: 'LIVE_API', inject: [GramJsLiveApi, ChannelRepository, APP_CONFIG], useFactory: (auto: GramJsLiveApi, ch: ChannelRepository, c: AppConfig) => new ManualOrAutoLiveApi(auto, ch, new SessionCipher(c.TELEGRAM_SESSION_ENCRYPTION_KEY, 'live-rtmp-key')) },

    { provide: BullMqJobQueue, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new BullMqJobQueue({ redisUrl: c.REDIS_URL, prefix: c.QUEUE_PREFIX }) },
    { provide: JOB_QUEUE, useExisting: BullMqJobQueue },
    { provide: REALTIME_BUS, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new RedisRealtimeBus(c.REDIS_URL) },
    { provide: MessagesRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new MessagesRepository(db) },
    { provide: RADIO_BUS, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new RedisRadioBus(c.REDIS_URL) },
    { provide: TagVoteService, inject: [EngagementSettingsRepository, TagPollRepository, RADIO_BUS, REALTIME_BUS], useFactory: (s: EngagementSettingsRepository, p: TagPollRepository, b: RadioBus, rt: RealtimeBus) => new TagVoteService(s, p, b, undefined, undefined, rt) },

    {
      provide: LyricsService,
      inject: [LyricsRepository, TrackRepository, APP_CONFIG],
      useFactory: (l: LyricsRepository, t: TrackRepository, c: AppConfig) => new LyricsService(new TelegraphLyricsSource(), l, t, c.LYRICS_CACHE_TTL),
    },
    { provide: 'TRANSCRIPTION_SOURCE', inject: [SettingsService], useFactory: (s: SettingsService): TranscriptionSource => new SettingsTranscriptionSource(s) },
    {
      provide: TrackTranscriptionService,
      inject: ['TRANSCRIPTION_SOURCE', TELEGRAM_GATEWAY, TrackRepository, LyricsRepository, APP_CONFIG],
      useFactory: (src: TranscriptionSource, gw: TelegramGateway, t: TrackRepository, l: LyricsRepository, c: AppConfig) => new TrackTranscriptionService(src, gw, new FfmpegPreprocessor(c.FFMPEG_PATH), t, l, c.TMP_DIR),
    },
    { provide: LyricsAlignmentService, inject: [LyricsRepository, LexiconRepository, TrackRepository], useFactory: (l: LyricsRepository, lx: LexiconRepository, t: TrackRepository) => new LyricsAlignmentService(l, lx, t) },
    { provide: 'LLM_CLIENT', inject: [SettingsService], useFactory: (s: SettingsService): LlmClient => new OpenAiCompatibleLlm(s) },
    { provide: LanguageService, inject: [DatabaseService, LexiconRepository, LyricsAlignmentService, 'LLM_CLIENT'], useFactory: (db: DatabaseService, lx: LexiconRepository, a: LyricsAlignmentService, llm: LlmClient) => new LanguageService(db, lx, a, llm) },
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
      inject: [BullMqJobQueue, LyricsPipeline, TelegramTrackDiscovery, ChannelRepository, APP_CONFIG],
      useFactory: (q: BullMqJobQueue, p: LyricsPipeline, d: TelegramTrackDiscovery, ch: ChannelRepository, c: AppConfig) => new JobsRunner(q, p, d, ch, c.TELEGRAM_SYNC_INTERVAL_SECONDS),
    },

    { provide: RadioScheduler, inject: [RadioConfigRepository, PlaybackHistoryRepository, RadioStateRepository, TagVoteService], useFactory: (c: RadioConfigRepository, h: PlaybackHistoryRepository, s: RadioStateRepository, v: TagVoteService) => new RadioScheduler(c, h, s, undefined, undefined, v) },
    {
      provide: StationManager,
      inject: [ChannelRepository, RadioStateRepository, RadioScheduler, PlaybackHistoryRepository, TrackRepository, TELEGRAM_GATEWAY, 'LIVE_API', APP_CONFIG, AdsRepository, EngagementSettingsRepository, RadioMetrics, PlatformSettingsRepository, REALTIME_BUS],
      useFactory: (channels: ChannelRepository, state: RadioStateRepository, sch: RadioScheduler, h: PlaybackHistoryRepository, t: TrackRepository, gw: TelegramGateway, liveApi: TelegramLiveApi, c: AppConfig, adsRepo: AdsRepository, engagement: EngagementSettingsRepository, metrics: RadioMetrics, platform: PlatformSettingsRepository, rt: RealtimeBus) =>
        new StationManager(channels, state, (channel: ChannelRow): Station => {
          const broadcaster = new Broadcaster(Math.round(((c.RADIO_STREAM_BITRATE_KBPS * 1000) / 8) * c.RADIO_PREBUFFER_SECONDS));
          const engine = new PlaybackEngine({
            channelId: channel.id,
            scheduler: sch,
            state,
            history: h,
            tracks: t,
            audio: new TrackAudioPipeline(gw, new FfmpegLiveTranscoder(c.FFMPEG_PATH), c.RADIO_STREAM_BITRATE_KBPS),
            broadcaster,
            metrics: metrics.forStation(channel.id),
            ads: new DbAdSource(adsRepo, platform, engagement, new FfmpegLiveTranscoder(c.FFMPEG_PATH), c.RADIO_STREAM_BITRATE_KBPS),
            options: { burstSeconds: c.RADIO_PREBUFFER_SECONDS, sliceBytes: 4096, preselectSeconds: c.RADIO_PREFETCH_SECONDS, prefetchTimeoutMs: c.RADIO_PREFETCH_TIMEOUT_SECONDS * 1000, validateAudio: true, prefetchBytes: 256 * 1024, idleRetryMs: 5000, maxBackoffMs: 30_000, now: realClock.now, sleep: realClock.sleep },
          });
          // Tell every instance's live sockets when the track or the ad on air changes (the state row is already updated).
          engine.subscribe((e) => {
            if (e.type === 'track-started' || e.type === 'ad-started' || e.type === 'ad-ended') void rt.publish({ type: 'current', channelId: channel.id }).catch(() => undefined);
          });
          const live = new TelegramLiveStreamer(channel.id, channel.title, broadcaster, liveApi, new FfmpegRtmpPublisher(c.FFMPEG_PATH, c.RADIO_STREAM_BITRATE_KBPS), channels, DEFAULT_LIVE_OPTIONS);
          return { channel, broadcaster, engine, live };
        }),
    },
    {
      provide: PlaybackRunner,
      inject: [DatabaseService, StationManager, RADIO_BUS, PlaybackHistoryRepository, TagVoteService, REALTIME_BUS],
      useFactory: (db: DatabaseService, sm: StationManager, bus: RadioBus, h: PlaybackHistoryRepository, votes: TagVoteService, rt: RealtimeBus) => {
        const sampler = new ListenerSampler(db, sm);
        const ticker = new TagVoteTicker(sm, votes);
        const counts = new ListenerCountPublisher(sm, rt);
        return new PlaybackRunner(new PlaybackSupervisor(db, sm, bus, h, 5000, undefined, { start: () => { sampler.start(); ticker.start(); counts.start(); }, stop: () => { sampler.stop(); ticker.stop(); counts.stop(); } }));
      },
    },
    {
      provide: CurrentRadioService,
      inject: [RadioStateRepository, TrackRepository, LyricsRepository, AdsRepository],
      useFactory: (s: RadioStateRepository, t: TrackRepository, l: LyricsRepository, a: AdsRepository) => new CurrentRadioService(s, t, l, undefined, a),
    },
    {
      provide: RealtimeService,
      inject: [ChannelRepository, CurrentRadioService, TagVoteService, MessagesRepository, EngagementSettingsRepository, StationManager, REALTIME_BUS],
      useFactory: (ch: ChannelRepository, cur: CurrentRadioService, v: TagVoteService, m: MessagesRepository, st: EngagementSettingsRepository, sm: StationManager, bus: RealtimeBus) =>
        new RealtimeService({ channels: ch, current: cur, votes: v, messages: m, settings: st, stations: sm, bus, instanceId: randomUUID() }),
    },
    { provide: 'REALTIME_LIFECYCLE', inject: [RealtimeService, HttpAdapterHost, REALTIME_BUS], useFactory: (r: RealtimeService, h: HttpAdapterHost, b: RealtimeBus) => new RealtimeLifecycle(r, h, b) },
    { provide: STREAM_OPTIONS, useValue: { maxBacklogBytes: 512 * 1024, stationName: 'radio_rainy' } },
  ],
  exports: [APP_CONFIG, DatabaseService, TrackRepository, LyricsRepository, RadioConfigRepository, RadioStateRepository, PlaybackHistoryRepository, ChannelRepository, LexiconRepository, SettingsService, TelegramClientManager, TELEGRAM_GATEWAY, 'AUDIO_STORE_SOURCE', TelegramTrackDiscovery, LyricsPipeline, StationManager, RADIO_BUS, BullMqJobQueue, CurrentRadioService, TelegramSessionStore, LanguageService, AdsRepository, SponsorsRepository, EngagementSettingsRepository, TagPollRepository, TagVoteService, RadioMetrics, AccountsRepository, PlatformSettingsRepository, REALTIME_BUS, MessagesRepository, RealtimeService],
})
export class AppModule {}
