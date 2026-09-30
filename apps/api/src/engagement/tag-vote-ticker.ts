import { Logger } from '@nestjs/common';
import { StationManager } from '../playback/station-manager';
import { TagVoteService } from './tag-vote.service';

/** Leader-only: advances the tag vote state machine of every running station every few seconds. */
export class TagVoteTicker {
  private readonly logger = new Logger(TagVoteTicker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly stations: Pick<StationManager, 'active'>, private readonly votes: Pick<TagVoteService, 'tick'>, private readonly everyMs = 5000) {}

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
    if (this.running) return;
    this.running = true;
    try {
      for (const s of this.stations.active) {
        await this.votes.tick(s.channel.id).catch((e: unknown) => this.logger.warn({ msg: 'tag vote tick failed', channelId: s.channel.id, err: String(e) }));
      }
    } finally {
      this.running = false;
    }
  }
}
