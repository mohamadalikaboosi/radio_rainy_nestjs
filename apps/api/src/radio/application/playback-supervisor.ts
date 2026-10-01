import { Logger } from '@nestjs/common';
import { DatabaseService, LOCKS } from '../../shared/infrastructure/database/database.service';
import { RadioBus, RadioCommand } from './ports/radio-bus';
import { PlaybackHistoryRepository } from './ports/playback-history.repository';
import { StationManager } from './station-manager';

/**
 * Leader election: only the instance holding the Postgres advisory lock runs the stations, so two workers can never
 * select/play the same channel at once. If the lock connection dies, all stations stop and we re-elect.
 */
export class PlaybackSupervisor {
  private readonly logger = new Logger(PlaybackSupervisor.name);
  private timer: NodeJS.Timeout | null = null;
  private release: (() => Promise<void>) | null = null;
  private unsubscribe: (() => Promise<void>) | null = null;
  private stopped = false;
  private electing = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly stations: StationManager,
    private readonly bus: RadioBus,
    private readonly history: PlaybackHistoryRepository,
    private readonly retryMs = 5000,
    private readonly onBecomeLeader?: () => Promise<void>,
    private readonly sampler?: { start(): void; stop(): void },
  ) {}

  get isLeader(): boolean {
    return this.release !== null;
  }

  start(): void {
    void this.tryElect();
    this.timer = setInterval(() => void this.tryElect(), this.retryMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.demote('shutdown');
  }

  private async tryElect(): Promise<void> {
    if (this.stopped || this.release || this.electing) return;
    this.electing = true;
    try {
      const release = await this.db.tryAdvisoryLock(LOCKS.PLAYBACK_LEADER, () => {
        this.logger.error({ msg: 'leader lock connection lost; stepping down' });
        void this.demote('lock-lost');
      });
      if (!release) return;
      this.release = release;
      this.logger.log({ msg: 'became playback leader' });
      const closed = await this.history.closeDangling();
      if (closed > 0) this.logger.warn({ msg: 'closed dangling playback rows', count: closed });
      await this.onBecomeLeader?.();
      this.unsubscribe = await this.bus.subscribe((cmd) => this.handle(cmd));
      await this.stations.reconcile();
      this.sampler?.start();
    } catch (err) {
      this.logger.error({ msg: 'leader election failed', err: err instanceof Error ? err.message : String(err) });
      await this.demote('election-error');
    } finally {
      this.electing = false;
    }
  }

  private handle(cmd: RadioCommand): void {
    if (cmd.type === 'stations-changed') {
      void this.stations.reconcile();
      return;
    }
    const station = this.stations.get(cmd.channelId);
    if (!station) {
      this.logger.warn({ msg: 'command for a station that is not running', type: cmd.type, channelId: cmd.channelId });
      return;
    }
    switch (cmd.type) {
      case 'skip':
        this.logger.log({ msg: 'command: skip', channelId: cmd.channelId, result: station.engine.skip(cmd.expectedSeq) });
        break;
      case 'play-next':
        this.logger.log({ msg: 'command: play-next', channelId: cmd.channelId, result: station.engine.playNext(cmd.trackId) });
        break;
      case 'queue-next':
        station.engine.queueNext(cmd.trackId);
        this.logger.log({ msg: 'command: queue-next', channelId: cmd.channelId });
        break;
      case 'config-changed':
        station.engine.invalidatePlan();
        break;
      case 'wake':
        station.engine.wake();
        break;
    }
  }

  private async demote(why: string): Promise<void> {
    const release = this.release;
    this.release = null;
    if (!release) return;
    this.logger.warn({ msg: 'stepping down as playback leader', why });
    await this.unsubscribe?.().catch((e: unknown) => this.logger.warn({ msg: 'unsubscribe failed', err: String(e) }));
    this.unsubscribe = null;
    this.sampler?.stop();
    await this.stations.stopAll();
    await release();
  }
}
