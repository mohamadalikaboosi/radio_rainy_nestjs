import { Logger } from '@nestjs/common';
import { DatabaseService, LOCKS } from '../database/database.service';
import { RadioBus } from '../radio/radio-bus';
import { PlaybackEngine } from './playback-engine';
import { PlaybackHistoryRepository } from './playback-history.repository';

/**
 * Leader election: only the instance holding the Postgres advisory lock runs the PlaybackEngine, so two
 * workers can never select/play at the same time. If the lock connection dies, the engine stops and we re-elect.
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
    private readonly engine: PlaybackEngine,
    private readonly bus: RadioBus,
    private readonly history: PlaybackHistoryRepository,
    private readonly retryMs = 5000,
    private readonly onBecomeLeader?: () => Promise<void>,
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
      this.engine.start();
    } catch (err) {
      this.logger.error({ msg: 'leader election failed', err: err instanceof Error ? err.message : String(err) });
      await this.demote('election-error');
    } finally {
      this.electing = false;
    }
  }

  private handle(cmd: Parameters<Parameters<RadioBus['subscribe']>[0]>[0]): void {
    switch (cmd.type) {
      case 'skip':
        this.logger.log({ msg: 'command: skip', result: this.engine.skip(cmd.expectedSeq) });
        break;
      case 'play-next':
        this.logger.log({ msg: 'command: play-next', result: this.engine.playNext(cmd.trackId) });
        break;
      case 'config-changed':
        this.engine.invalidatePlan();
        break;
      case 'wake':
        this.engine.wake();
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
    await this.engine.stop();
    await release();
  }
}
