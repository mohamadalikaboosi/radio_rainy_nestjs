import { Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../shared/infrastructure/config/app-config';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { LyricsPipeline } from '../../lyrics/application/lyrics-pipeline';
import { LyricsRepository } from '../../lyrics/infrastructure/lyrics.repository';
import { PlaybackHistoryRepository } from '../../radio/infrastructure/playback-history.repository';
import { RADIO_BUS, RadioBus } from '../../radio/infrastructure/radio-bus';
import { RadioConfigRepository } from '../../radio/infrastructure/radio-config.repository';
import { ChannelRepository } from '../../catalog/infrastructure/persistence/channel.repository';
import { ChannelService } from '../../catalog/application/channel.service';
import { StationManager } from '../../radio/application/station-manager';
import { TELEGRAM_GATEWAY, TelegramGateway } from '../../catalog/application/ports/telegram.types';
import { RadioConfigurationService } from '../../radio/application/radio-configuration.service';
import { RadioStateRepository } from '../../radio/infrastructure/radio-state.repository';
import { TelegramClientManager } from '../../catalog/infrastructure/telegram/telegram-client.manager';
import { TelegramTrackDiscovery } from '../../catalog/application/track-discovery';
import { TrackRepository } from '../../catalog/infrastructure/persistence/track.repository';
import { SessionCipher } from '../../shared/infrastructure/crypto/session-cipher';
import { AdminAuthService } from '../application/admin-auth.service';
import { AdminGuard } from './admin.guard';
import { AdminUsersRepository } from '../infrastructure/admin-users.repository';
import { seedAdmin } from '../application/admin-seeder';
import { AdminAuthController, AdminChannelsController, AdminLiveController, AdminReportsController, AdminDashboardController, AdminHashtagsController, AdminRadioController, AdminTelegramController, AdminTracksController } from './admin.controllers';
import { AdminMessagesController } from '../../realtime/interface/messages.controllers';
import { AdminAccountsController, AdminCampaignsController, AdminPlatformController, AdminStationOwnerController } from '../../accounts/interface/platform-admin.controllers';
import { AdminAdsController, AdminEngagementController, AdminSponsorsController } from '../../engagement/interface/engagement-admin.controllers';
import { AdminLanguageController, AdminSettingsController } from './settings-language.controllers';
import { AuditService } from '../application/audit.service';
import { DashboardService } from '../application/dashboard.service';
import { LiveService } from '../application/live.service';
import { ReportsService } from '../application/reports.service';
import { SystemReportService } from '../application/system-report.service';
import { CurrentRadioService } from '../../radio/application/current-radio.service';
import { BullMqJobQueue } from '../../lyrics/infrastructure/bullmq-job-queue';
import { SettingsService } from '../application/settings.service';
import { AudioStoreSource } from '../../catalog/application/ports/audio-store';
import { RadioControlService } from '../../radio/application/radio-control.service';
import { StatsService } from '../application/stats.service';
import { TrackAdminService } from '../../catalog/application/track-admin.service';
import { TrackQueryRepository } from '../../catalog/infrastructure/persistence/track-query.repository';

/** Runs the admin seeder once the database is migrated (DatabaseService migrates on init). */
class AdminSeederLifecycle implements OnApplicationBootstrap {
  constructor(private readonly users: AdminUsersRepository, private readonly cfg: AppConfig) {}
  async onApplicationBootstrap(): Promise<void> {
    await seedAdmin(this.users, { username: this.cfg.ADMIN_EMAIL, passwordHash: this.cfg.ADMIN_PASSWORD_HASH });
  }
}

class StatsLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(private readonly stats: StatsService) {}
  onApplicationBootstrap(): void {
    this.stats.start();
  }
  onModuleDestroy(): void {
    this.stats.stop();
  }
}

@Module({
  controllers: [AdminMessagesController, AdminPlatformController, AdminAccountsController, AdminCampaignsController, AdminStationOwnerController, AdminAdsController, AdminSponsorsController, AdminEngagementController, AdminLiveController, AdminReportsController, AdminAuthController, AdminDashboardController, AdminChannelsController, AdminTelegramController, AdminTracksController, AdminHashtagsController, AdminRadioController, AdminSettingsController, AdminLanguageController],
  providers: [
    { provide: AdminUsersRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new AdminUsersRepository(db) },
    { provide: AdminAuthService, inject: [AdminUsersRepository, APP_CONFIG], useFactory: (u: AdminUsersRepository, c: AppConfig) => new AdminAuthService(u, { jwtSecret: c.JWT_SECRET, tokenTtlSeconds: 8 * 3600 }) },
    { provide: 'ADMIN_SEEDER', inject: [AdminUsersRepository, APP_CONFIG], useFactory: (u: AdminUsersRepository, c: AppConfig) => new AdminSeederLifecycle(u, c) },
    { provide: AdminGuard, inject: [AdminAuthService], useFactory: (a: AdminAuthService) => new AdminGuard(a) },
    { provide: AuditService, inject: [DatabaseService], useFactory: (db: DatabaseService) => new AuditService(db) },
    { provide: TrackQueryRepository, inject: [DatabaseService], useFactory: (db: DatabaseService) => new TrackQueryRepository(db) },
    { provide: StatsService, inject: [DatabaseService], useFactory: (db: DatabaseService) => new StatsService(db) },
    { provide: 'STATS_LIFECYCLE', inject: [StatsService], useFactory: (s: StatsService) => new StatsLifecycle(s) },
    {
      provide: TrackAdminService,
      inject: [DatabaseService, TrackRepository, LyricsRepository, LyricsPipeline, TelegramTrackDiscovery, AuditService],
      useFactory: (db: DatabaseService, t: TrackRepository, l: LyricsRepository, p: LyricsPipeline, d: TelegramTrackDiscovery, a: AuditService) => new TrackAdminService(db, t, l, p, d, a),
    },
    {
      provide: RadioConfigurationService,
      inject: [DatabaseService, RadioConfigRepository, AuditService, RADIO_BUS, RadioStateRepository, PlaybackHistoryRepository],
      useFactory: (db: DatabaseService, r: RadioConfigRepository, a: AuditService, bus: RadioBus, s: RadioStateRepository, h: PlaybackHistoryRepository) => new RadioConfigurationService(db, r, a, bus, s, h),
    },
    {
      provide: RadioControlService,
      inject: [RADIO_BUS, AuditService, TrackRepository, RadioStateRepository, PlaybackHistoryRepository],
      useFactory: (bus: RadioBus, a: AuditService, t: TrackRepository, s: RadioStateRepository, h: PlaybackHistoryRepository) => new RadioControlService(bus, a, t, s, h),
    },
    {
      provide: DashboardService,
      inject: [DatabaseService, RadioStateRepository, RadioConfigRepository, TrackRepository, PlaybackHistoryRepository, StationManager, ChannelRepository, TelegramClientManager],
      useFactory: (db: DatabaseService, s: RadioStateRepository, c: RadioConfigRepository, t: TrackRepository, h: PlaybackHistoryRepository, sm: StationManager, ch: ChannelRepository, tg: TelegramClientManager) => new DashboardService(db, s, c, t, h, sm, ch, tg),
    },
    { provide: ReportsService, inject: [DatabaseService], useFactory: (db: DatabaseService) => new ReportsService(db) },
    {
      provide: LiveService,
      inject: [ChannelRepository, RadioStateRepository, TrackRepository, PlaybackHistoryRepository, StationManager, CurrentRadioService],
      useFactory: (c: ChannelRepository, s: RadioStateRepository, t: TrackRepository, h: PlaybackHistoryRepository, sm: StationManager, cur: CurrentRadioService) => new LiveService(c, s, t, h, sm, cur),
    },
    {
      provide: SystemReportService,
      inject: [DatabaseService, BullMqJobQueue, TelegramClientManager, StationManager, ChannelRepository, SettingsService, 'AUDIO_STORE_SOURCE'],
      useFactory: (db: DatabaseService, q: BullMqJobQueue, tg: TelegramClientManager, sm: StationManager, ch: ChannelRepository, st: SettingsService, store: AudioStoreSource) => new SystemReportService(db, q, tg, sm, ch, st, store),
    },
    {
      provide: ChannelService,
      inject: [ChannelRepository, TELEGRAM_GATEWAY, RADIO_BUS, AuditService, APP_CONFIG],
      useFactory: (ch: ChannelRepository, gw: TelegramGateway, bus: RadioBus, a: AuditService, c: AppConfig) => new ChannelService(ch, gw, bus, a, c.RADIO_RECENT_TRACK_WINDOW, new SessionCipher(c.TELEGRAM_SESSION_ENCRYPTION_KEY, 'live-rtmp-key')),
    },
  ],
})
export class AdminModule {}
