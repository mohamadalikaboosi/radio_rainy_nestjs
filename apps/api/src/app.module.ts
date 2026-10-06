import { JwtTokenService } from './shared/infrastructure/jwt-token.service';
import { Global, Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ManualOrAutoLiveApi } from './live/infrastructure/manual-live-api';
import { DEFAULT_LOW, FfmpegLowQualityStream } from './radio/infrastructure/low-quality-stream';
import { RadioMetrics } from './radio/application/radio-metrics';
import { DiskAudioCache } from './catalog/infrastructure/storage/disk-audio-cache';
import { DiskCachingGateway } from './catalog/infrastructure/storage/disk-caching-gateway';
import { join } from 'node:path';
import { PgAuditService } from './administration/infrastructure/audit.service';
import { PORTAL_AUDIT, PortalAuthController, PortalController } from './accounts/interface/portal.controllers';
import { PortalAuthService } from './accounts/application/portal-auth.service';
import { PortalGuard } from './accounts/interface/portal.guard';
import { randomUUID } from 'node:crypto';
import { HttpAdapterHost } from '@nestjs/core';
import { REALTIME_BUS, RealtimeBus } from './realtime/application/ports/realtime-bus';
import { RedisRealtimeBus } from './realtime/infrastructure/events';
import { ListenerCountPublisher } from './realtime/application/listener-count-publisher';
import { MessagesRepository } from './realtime/application/ports/messages.repository';
import { PgMessagesRepository } from './realtime/infrastructure/messages.repository';
import { RealtimeService } from './realtime/interface/realtime.service';
import { AccountsRepository } from './accounts/application/ports/accounts.repository';
import { PgAccountsRepository } from './accounts/infrastructure/accounts.repository';
import { PlatformSettingsRepository } from './accounts/application/ports/platform-settings.repository';
import { PgPlatformSettingsRepository } from './accounts/infrastructure/platform-settings.repository';
import { AdsRepository } from './engagement/application/ports/ads.repository';
import { PgAdsRepository } from './engagement/infrastructure/ads.repository';
import { DbAdSource } from './engagement/application/ad-source';
import { EngagementPublicController } from './engagement/interface/engagement-public.controller';
import { EngagementSettingsRepository } from './engagement/application/ports/engagement-settings.repository';
import { PgEngagementSettingsRepository } from './engagement/infrastructure/engagement-settings.repository';
import { SponsorsRepository } from './engagement/application/ports/sponsors.repository';
import { PgSponsorsRepository } from './engagement/infrastructure/sponsors.repository';
import { TagPollRepository } from './engagement/application/ports/tag-poll.repository';
import { PgTagPollRepository } from './engagement/infrastructure/tag-poll.repository';
import { TagVoteService } from './engagement/application/tag-vote.service';
import { TagVoteTicker } from './engagement/application/tag-vote-ticker';
import { AdminModule } from './admin.module';
import { LyricsAlignmentService } from './lyrics/application/lyrics-alignment.service';
import { ChannelRepository, ChannelRow } from './catalog/application/ports/channel.repository';
import { PgChannelRepository } from './catalog/infrastructure/persistence/channel.repository';
import { LexiconRepository } from './lyrics/application/ports/lexicon.repository';
import { PgLexiconRepository } from './lyrics/infrastructure/lexicon.repository';
import { LanguageService } from './lyrics/application/language.service';
import { PgLanguageData } from './lyrics/infrastructure/language-data.repository';
import { LlmClient } from './lyrics/application/ports/llm-client';
import { OpenAiCompatibleLlm } from './lyrics/infrastructure/llm-client';
import { GramJsLiveApi } from './live/infrastructure/gramjs-live-api';
import { LIVE_LADDER, LiveQualityController } from './live/domain/live-quality';
import { LiveSlide, Scene } from './live/infrastructure/live-slide';
import { TelegramLiveApi } from './live/application/ports/telegram-live';
import { FfmpegRtmpPublisher } from './live/infrastructure/ffmpeg-rtmp-publisher';
import { DEFAULT_LIVE_OPTIONS, TelegramLiveStreamer } from './live/application/telegram-live-streamer';
import { SettingsService } from './administration/application/ports/settings.service';
import { PgSettingsService } from './administration/infrastructure/settings.service';
import { AudioStoreSource } from './catalog/application/ports/audio-store';
import { SettingsAudioStoreSource } from './catalog/infrastructure/storage/settings-audio-store-source';
import { CachingTelegramGateway, resolverFrom } from './catalog/infrastructure/storage/caching-gateway';
import { Station, StationManager } from './radio/application/station-manager';
import { SettingsTranscriptionSource } from './lyrics/infrastructure/settings-transcription-source';
import { TranscriptionSource } from './lyrics/application/ports/transcription-source';
import { APP_CONFIG, AppConfig, loadConfig } from './shared/infrastructure/config/app-config';
import { DatabaseService } from './shared/infrastructure/database/database.service';
import { BullMqJobQueue } from './lyrics/infrastructure/bullmq-job-queue';
import { JOB_QUEUE } from './lyrics/application/ports/job-queues';
import { JobsRunner } from './lyrics/infrastructure/jobs-runner';
import { LyricsPipeline } from './lyrics/application/lyrics-pipeline';
import { LyricsRepository } from './lyrics/application/ports/lyrics.repository';
import { PgLyricsRepository } from './lyrics/infrastructure/lyrics.repository';
import { LyricsService } from './lyrics/application/lyrics.service';
import { TelegraphLyricsSource } from './lyrics/infrastructure/telegraph-lyrics-source';
import { TrackAudioPipeline } from './radio/application/audio-pipeline';
import { FfmpegLiveTranscoder } from './radio/infrastructure/ffmpeg-live-transcoder';
import { PlaybackEngine } from './radio/application/playback-engine';
import { PlaybackHistoryRepository } from './radio/application/ports/playback-history.repository';
import { PgPlaybackHistoryRepository } from './radio/infrastructure/playback-history.repository';
import { PlaybackRunner } from './radio/infrastructure/playback-runner';
import { ListenerSampler } from './radio/infrastructure/listener-sampler';
import { PlaybackSupervisor } from './radio/infrastructure/playback-supervisor';
import { CurrentRadioService } from './radio/application/current-radio.service';
import { RADIO_BUS, RadioBus } from './radio/application/ports/radio-bus';
import { RedisRadioBus } from './radio/infrastructure/radio-bus';
import { RadioConfigRepository } from './radio/application/ports/radio-config.repository';
import { PgRadioConfigRepository } from './radio/infrastructure/radio-config.repository';
import { RadioScheduler } from './radio/application/radio-scheduler';
import { RadioStateRepository } from './radio/application/ports/radio-state.repository';
import { PgRadioStateRepository } from './radio/infrastructure/radio-state.repository';
import { Broadcaster } from './radio/domain/broadcaster';
import { realClock } from './radio/domain/pacer';
import { MetricsController } from './radio/interface/metrics.controller';
import { RadioController, STREAM_OPTIONS } from './radio/interface/radio.controller';
import { GramJsTelegramGateway } from './catalog/infrastructure/telegram/gramjs.gateway';
import { SessionCipher } from './shared/kernel/session-cipher';
import { TelegramConnection } from './catalog/application/ports/telegram-connection';
import { TelegramClientManager } from './catalog/infrastructure/telegram/telegram-client.manager';
import { TelegramSessionStore } from './catalog/infrastructure/telegram/telegram-session.store';
import { TELEGRAM_GATEWAY, TelegramGateway } from './catalog/application/ports/telegram.types';
import { TelegramTrackDiscovery } from './catalog/application/track-discovery';
import { TrackRepository } from './catalog/application/ports/track.repository';
import { PgTrackRepository } from './catalog/infrastructure/persistence/track.repository';
import { TelegramAudioStaging } from './lyrics/infrastructure/telegram-audio-staging';
import { FfmpegPreprocessor } from './lyrics/infrastructure/audio-preprocessor';
import { TrackTranscriptionService } from './lyrics/application/track-transcription.service';

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
    { provide: TrackRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgTrackRepository(db) },
    { provide: LyricsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgLyricsRepository(db) },
    { provide: RadioConfigRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgRadioConfigRepository(db) },
    { provide: RadioStateRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgRadioStateRepository(db) },
    { provide: PlaybackHistoryRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgPlaybackHistoryRepository(db) },
    { provide: ChannelRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgChannelRepository(db) },
    { provide: LexiconRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgLexiconRepository(db) },

    { provide: AdsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgAdsRepository(db) },
    { provide: AccountsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgAccountsRepository(db) },
    { provide: PlatformSettingsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgPlatformSettingsRepository(db) },
    { provide: PORTAL_AUDIT, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgAuditService(db) },
    { provide: PortalAuthService, inject: [AccountsRepository, PlatformSettingsRepository, APP_CONFIG], useFactory: (a: AccountsRepository, p: PlatformSettingsRepository, c: AppConfig) => new PortalAuthService(a, p, { tokens: new JwtTokenService(c.JWT_SECRET), tokenTtlSeconds: 12 * 3600 }) },
    { provide: PortalGuard, inject: [PortalAuthService, AccountsRepository], useFactory: (a: PortalAuthService, acc: AccountsRepository) => new PortalGuard(a, acc) },
    { provide: SponsorsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgSponsorsRepository(db) },
    { provide: EngagementSettingsRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgEngagementSettingsRepository(db) },
    { provide: TagPollRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgTagPollRepository(db) },

    { provide: SessionCipher, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new SessionCipher(c.TELEGRAM_SESSION_ENCRYPTION_KEY) },
    {
      provide: SettingsService,
      inject: [DatabaseService, APP_CONFIG],
      useFactory: (db: DatabaseService, c: AppConfig) =>
        new PgSettingsService(db, new SessionCipher(c.TELEGRAM_SESSION_ENCRYPTION_KEY, 'app-settings'), {
          storage: c.MINIO_ENDPOINT && c.MINIO_ACCESS_KEY && c.MINIO_SECRET_KEY ? { endpoint: c.MINIO_ENDPOINT, port: c.MINIO_PORT, useSsl: c.MINIO_USE_SSL, bucket: c.MINIO_BUCKET, accessKey: c.MINIO_ACCESS_KEY, secretKey: c.MINIO_SECRET_KEY } : undefined,
          telegram: c.TELEGRAM_API_ID && c.TELEGRAM_API_HASH ? { apiId: c.TELEGRAM_API_ID, apiHash: c.TELEGRAM_API_HASH } : undefined,
          whisper: c.WHISPER_URL ? { url: c.WHISPER_URL, model: c.WHISPER_MODEL, apiKey: c.WHISPER_API_KEY, language: c.WHISPER_LANGUAGE, sampleRate: c.WHISPER_SAMPLE_RATE, timeoutSeconds: c.WHISPER_TIMEOUT_SECONDS } : undefined,
        }),
    },
    { provide: TelegramSessionStore, inject: [DatabaseService, SessionCipher], useFactory: (db: DatabaseService, c: SessionCipher) => new TelegramSessionStore(db, c) },
    { provide: TelegramClientManager, inject: [APP_CONFIG, TelegramSessionStore, SettingsService], useFactory: (c: AppConfig, s: TelegramSessionStore, st: SettingsService) => new TelegramClientManager(c, s, st) },
    { provide: TelegramConnection, useExisting: TelegramClientManager },
    { provide: GramJsTelegramGateway, inject: [TelegramClientManager, ChannelRepository, APP_CONFIG], useFactory: (m: TelegramClientManager, ch: ChannelRepository, c: AppConfig) => new GramJsTelegramGateway(m, ch, c.TELEGRAM_DOWNLOAD_REQUEST_KB) },
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
    { provide: MessagesRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new PgMessagesRepository(db) },
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
      useFactory: (src: TranscriptionSource, gw: TelegramGateway, t: TrackRepository, l: LyricsRepository, c: AppConfig) => new TrackTranscriptionService(src, new TelegramAudioStaging(gw, new FfmpegPreprocessor(c.FFMPEG_PATH), c.TMP_DIR), t, l),
    },
    { provide: LyricsAlignmentService, inject: [LyricsRepository, LexiconRepository, TrackRepository], useFactory: (l: LyricsRepository, lx: LexiconRepository, t: TrackRepository) => new LyricsAlignmentService(l, lx, t) },
    { provide: 'LLM_CLIENT', inject: [SettingsService], useFactory: (s: SettingsService): LlmClient => new OpenAiCompatibleLlm(s) },
    { provide: LanguageService, inject: [DatabaseService, LexiconRepository, LyricsAlignmentService, 'LLM_CLIENT'], useFactory: (db: DatabaseService, lx: LexiconRepository, a: LyricsAlignmentService, llm: LlmClient) => new LanguageService(new PgLanguageData(db), lx, a, llm) },
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
            options: { burstSeconds: c.RADIO_PREBUFFER_SECONDS, sliceBytes: 4096, preselectSeconds: c.RADIO_PREFETCH_SECONDS, prefetchTimeoutMs: c.RADIO_PREFETCH_TIMEOUT_SECONDS * 1000, validateAudio: true, bufferWholeTrack: c.RADIO_BUFFER_WHOLE_TRACK, prefetchBytes: c.RADIO_BUFFER_WHOLE_TRACK ? 64 * 1024 * 1024 : 256 * 1024, idleRetryMs: 5000, maxBackoffMs: 30_000, now: realClock.now, sleep: realClock.sleep },
          });
          // Tell every instance's live sockets when the track or the ad on air changes (the state row is already updated).
          engine.subscribe((e) => {
            if (e.type === 'track-started' || e.type === 'ad-started' || e.type === 'ad-ended') void rt.publish({ type: 'current', channelId: channel.id }).catch(() => undefined);
          });
          // The picture of the Telegram live video (song title + artist, or the ad and its banner) is drawn by a one-shot ffmpeg job into a PNG
          // that the live encoder re-reads; it changes after a short delay so it matches what is HEARD in the stream (prebuffer + encoder queue).
          const slideLog = new Logger('LiveSlide');
          const slide = new LiveSlide(join(c.TMP_DIR, 'live'), channel.id, c.FFMPEG_PATH, undefined, (m) => slideLog.warn({ msg: m, channelId: channel.id }));
          void slide.show({ title: channel.title });
          let pendingScene: NodeJS.Timeout | undefined;
          const showScene = (scene: Promise<Scene | null>): void => {
            void scene.then((s) => {
              if (!s) return;
              clearTimeout(pendingScene);
              pendingScene = setTimeout(() => void slide.show(s), c.TELEGRAM_LIVE_TEXT_DELAY_SECONDS * 1000);
            }).catch(() => undefined);
          };
          engine.subscribe((e) => {
            if (e.type === 'track-started') {
              showScene(t.findById(e.trackId).then((tr) => (tr ? { title: tr.title, artist: tr.artist } : null)));
            } else if (e.type === 'ad-started') {
              // "AD" + its name, where to go (the link's host, or the button text) and the advertiser's banner
              showScene(Promise.all([adsRepo.onAir(e.adId), adsRepo.image(e.adId)]).then(([ad, img]) => {
                let where = ad?.ctaLabel ?? '';
                try {
                  if (ad?.linkUrl) where = new URL(ad.linkUrl).host;
                } catch {
                  /* keep the button text */
                }
                return { title: ad ? `AD · ${ad.name}` : 'AD', artist: where || null, ...(img ? { banner: img } : {}) };
              }));
            }
          });
          const live = new TelegramLiveStreamer(channel.id, channel.title, broadcaster, liveApi, new FfmpegRtmpPublisher(c.FFMPEG_PATH, slide.path), channels, DEFAULT_LIVE_OPTIONS, c.TELEGRAM_LIVE_QUALITY === 'auto' ? new LiveQualityController() : new LiveQualityController(LIVE_LADDER.filter((q) => q.name === c.TELEGRAM_LIVE_QUALITY)));
          const low = c.RADIO_LOW_QUALITY_ENABLED ? new FfmpegLowQualityStream(broadcaster, { ...DEFAULT_LOW, ffmpegPath: c.FFMPEG_PATH, bitrateKbps: c.RADIO_LOW_BITRATE_KBPS, prebufferSeconds: c.RADIO_PREBUFFER_SECONDS }) : undefined;
          return { channel, broadcaster, engine, live, low };
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
  exports: [APP_CONFIG, DatabaseService, TrackRepository, LyricsRepository, RadioConfigRepository, RadioStateRepository, PlaybackHistoryRepository, ChannelRepository, LexiconRepository, SettingsService, TelegramClientManager, TelegramConnection, TELEGRAM_GATEWAY, 'AUDIO_STORE_SOURCE', TelegramTrackDiscovery, LyricsPipeline, StationManager, RADIO_BUS, BullMqJobQueue, JOB_QUEUE, CurrentRadioService, TelegramSessionStore, LanguageService, AdsRepository, SponsorsRepository, EngagementSettingsRepository, TagPollRepository, TagVoteService, RadioMetrics, AccountsRepository, PlatformSettingsRepository, REALTIME_BUS, MessagesRepository, RealtimeService],
})
export class AppModule {}
