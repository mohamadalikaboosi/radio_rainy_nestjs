import { listenersOf } from '../../radio/application/station-manager';
import { Injectable } from '@nestjs/common';
import { ChannelRepository } from '../../catalog/application/ports/channel.repository';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { JobQueue } from '../../lyrics/application/ports/job-queues';
import { StationManager } from '../../radio/application/station-manager';
import { SettingsService } from './settings.service';
import { AudioStoreSource } from '../../catalog/application/ports/audio-store';
import { TelegramConnection } from '../../catalog/application/ports/telegram-connection';

const CACHE_MS = 30_000;

/** Health of every moving part in one place (queues, Telegram, stations, integrations, cache). */
@Injectable()
export class SystemReportService {
  private cached: { at: number; value: unknown } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly queue: Pick<JobQueue, 'counts'>,
    private readonly telegram: TelegramConnection,
    private readonly stations: StationManager,
    private readonly channels: ChannelRepository,
    private readonly settings: SettingsService,
    private readonly store: AudioStoreSource,
  ) {}

  async get(): Promise<unknown> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const started = Date.now();
    const dbOk = await this.db.query('SELECT 1').then(() => true, () => false);
    const dbMs = Date.now() - started;
    const [queues, chans, view, cache, dbSize] = await Promise.all([
      this.queue.counts().catch(() => null),
      this.channels.list(),
      this.settings.view(),
      this.store.current().then(async (s) => (s ? await s.usage(20_000).then((u) => ({ configured: true as const, ...u }), (e: unknown) => ({ configured: true as const, error: String(e) })) : { configured: false as const }), () => ({ configured: false as const })),
      this.db.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes').then((r) => Number(r.rows[0]?.bytes ?? 0), () => 0),
    ]);
    const value = {
      generatedAt: new Date().toISOString(),
      process: { uptimeSeconds: Math.round(process.uptime()), node: process.version, memoryMb: Math.round(process.memoryUsage().rss / 1_048_576) },
      database: { ok: dbOk, latencyMs: dbMs, sizeMb: Math.round(dbSize / 1_048_576) },
      telegram: this.telegram.getStatus(),
      leader: this.stations.active.length > 0 || chans.every((c) => !c.started),
      stations: chans.map((c) => ({ id: c.id, title: c.title, started: c.started, running: this.stations.get(c.id) !== undefined, listeners: listenersOf(this.stations.get(c.id)), live: { enabled: c.telegramLiveEnabled, status: c.liveStatus, error: c.liveError } })),
      queues,
      integrations: { whisper: view.whisper.enabled, llm: view.llm.enabled, audioCache: view.storage.active },
      audioCache: cache,
    };
    this.cached = { at: Date.now(), value };
    return value;
  }
}
