import { listenersOf } from '../../radio/application/station-manager';
import { Logger } from '@nestjs/common';
import { StationManager } from '../../radio/application/station-manager';
import { RealtimeBus } from './ports/realtime-bus';

/** Leader only: announces how many people listen to each running station (HTTP and WebSocket audio alike) when it changes, and at least every 20 s. */
export class ListenerCountPublisher {
  private readonly logger = new Logger(ListenerCountPublisher.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly last = new Map<string, { count: number; at: number }>();

  constructor(
    private readonly stations: Pick<StationManager, 'active'>,
    private readonly bus: Pick<RealtimeBus, 'publish'>,
    private readonly everyMs = 3000,
    private readonly refreshMs = 20_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<void> {
    const t = this.now();
    for (const s of this.stations.active) {
      const count = listenersOf(s);
      const prev = this.last.get(s.channel.id);
      if (prev && prev.count === count && t - prev.at < this.refreshMs) continue;
      this.last.set(s.channel.id, { count, at: t });
      await this.bus.publish({ type: 'listeners', channelId: s.channel.id, count }).catch((e: unknown) => this.logger.warn({ msg: 'listeners publish failed', err: String(e) }));
    }
  }
}
