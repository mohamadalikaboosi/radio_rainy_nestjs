import { listenersOf } from './station-manager';
import { Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StationManager } from './station-manager';

export const SAMPLE_EVERY_SECONDS = 30;
const RETENTION_DAYS = 90;

/** Leader-only: records how many people listen to each running station every 30 s (audience report). */
export class ListenerSampler {
  private readonly logger = new Logger(ListenerSampler.name);
  private timer: NodeJS.Timeout | null = null;
  private lastCleanup = 0;

  constructor(private readonly db: Pick<DatabaseService, 'query'>, private readonly stations: Pick<StationManager, 'active'>, private readonly everyMs = SAMPLE_EVERY_SECONDS * 1000) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample().catch((e: unknown) => this.logger.warn({ msg: 'listener sampling failed', err: String(e) })), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sample(now = new Date()): Promise<number> {
    // Aligned to the sampling grid so a re-run inside the same slot never double counts.
    const slot = new Date(Math.floor(now.getTime() / this.everyMs) * this.everyMs);
    let n = 0;
    for (const s of this.stations.active) {
      await this.db.query('INSERT INTO listener_samples (channel_id, at, listeners) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [s.channel.id, slot, listenersOf(s)]);
      n++;
    }
    if (now.getTime() - this.lastCleanup > 3_600_000) {
      this.lastCleanup = now.getTime();
      await this.db.query(`DELETE FROM listener_samples WHERE at < now() - interval '${RETENTION_DAYS} days'`);
    }
    return n;
  }
}
