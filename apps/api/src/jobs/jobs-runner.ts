import { Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ChannelRepository } from '../channels/channel.repository';
import { TelegramTrackDiscovery } from '../telegram/track-discovery';
import { BullMqJobQueue, BullMqWorkers } from './bullmq-job-queue';
import { LyricsPipeline } from './lyrics-pipeline';

/** Starts the BullMQ workers and the periodic Telegram sync. */
export class JobsRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsRunner.name);
  private workers: BullMqWorkers | null = null;

  constructor(
    private readonly queue: BullMqJobQueue,
    private readonly pipeline: LyricsPipeline,
    private readonly discovery: TelegramTrackDiscovery,
    private readonly channels: Pick<ChannelRepository, 'list'>,
    private readonly syncEverySeconds: number,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.workers = this.queue.createWorkers({
      fetch: (p, c) => this.pipeline.handleFetch(p, c),
      transcribe: (p, c) => this.pipeline.handleTranscribe(p, c),
      align: (p, c) => this.pipeline.handleAlign(p, c),
      sync: async (p) => {
        const ids = p.channelId ? [p.channelId] : (await this.channels.list()).map((c) => c.id);
        for (const id of ids) await this.discovery.sync(id, { full: p.full });
      },
    });
    await this.queue.schedulePeriodicSync(this.syncEverySeconds);
    await this.queue.enqueueTelegramSync({}); // first sync right away
    this.logger.log({ msg: 'job workers started', syncEverySeconds: this.syncEverySeconds });
  }

  async onModuleDestroy(): Promise<void> {
    await this.workers?.close();
  }
}
