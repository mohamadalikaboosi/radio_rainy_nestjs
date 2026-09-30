import { Injectable, Logger } from '@nestjs/common';
import { TrackRepository } from '../track/track.repository';
import { parseCaption } from './caption-parser';
import { TelegramAudioMessage, TelegramGateway } from './telegram.types';

export interface SyncReport {
  channelId: string;
  full: boolean;
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  restored: number;
  failed: number;
  markedUnavailable: number;
  durationMs: number;
}

export interface DiscoveryListener {
  /** Called for new tracks and for tracks whose lyrics URL changed. Must not throw for retryable work; it should enqueue. */
  onLyricsNeedFetch(trackId: string): Promise<void>;
}

export interface SyncOptions {
  /** Re-scan the whole channel (catches edited captions) instead of only new messages. */
  full?: boolean;
  checkDeleted?: boolean;
  signal?: AbortSignal;
}

const EXISTS_BATCH = 100;

@Injectable()
export class TelegramTrackDiscovery {
  private readonly logger = new Logger(TelegramTrackDiscovery.name);
  private running: Promise<SyncReport> | null = null;

  constructor(
    private readonly gateway: TelegramGateway,
    private readonly tracks: TrackRepository,
    private readonly listener?: DiscoveryListener,
  ) {}

  /** Concurrent callers share one run (no double-scan). */
  sync(options: SyncOptions = {}): Promise<SyncReport> {
    this.running ??= this.doSync(options).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doSync(options: SyncOptions): Promise<SyncReport> {
    const started = Date.now();
    const full = options.full === true;
    const channel = await this.gateway.resolveChannel();
    const state = await this.tracks.getSyncState(channel.id);
    const report: SyncReport = {
      channelId: channel.id,
      full,
      scanned: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      restored: 0,
      failed: 0,
      markedUnavailable: 0,
      durationMs: 0,
    };
    this.logger.log({ msg: 'telegram sync started', channelId: channel.id, full, sinceMessageId: full ? 0 : state.lastMessageId });

    let maxId = state.lastMessageId;
    for await (const msg of this.gateway.fetchAudioMessages({ minId: full ? 0 : state.lastMessageId })) {
      if (options.signal?.aborted) throw new Error('sync aborted');
      report.scanned++;
      maxId = Math.max(maxId, msg.messageId);
      await this.processMessage(msg, report);
    }

    if (options.checkDeleted !== false) report.markedUnavailable = await this.detectDeleted(channel.id);

    await this.tracks.saveSyncState(channel.id, maxId, full);
    report.durationMs = Date.now() - started;
    this.logger.log({ msg: 'telegram sync finished', ...report });
    return report;
  }

  private async processMessage(msg: TelegramAudioMessage, report: SyncReport): Promise<void> {
    try {
      const parsed = parseCaption(msg.caption, {
        title: msg.audio.title,
        performer: msg.audio.performer,
        fileName: msg.audio.fileName,
      }, msg.entityUrls);
      const res = await this.tracks.upsertFromTelegram(msg, parsed);
      report[res.outcome]++;
      if (res.outcome !== 'unchanged') {
        this.logger.log({ msg: 'track discovered', outcome: res.outcome, trackId: res.trackId, messageId: msg.messageId });
      }
      if (res.lyricsNeedsFetch) await this.listener?.onLyricsNeedFetch(res.trackId);
    } catch (err) {
      // One bad message must not abort the whole sync.
      report.failed++;
      this.logger.error({ msg: 'failed to process message', messageId: msg.messageId, err: err instanceof Error ? err.message : String(err) });
    }
  }

  private async detectDeleted(channelId: string): Promise<number> {
    const known = await this.tracks.listActiveMessageIds(channelId);
    let marked = 0;
    for (let i = 0; i < known.length; i += EXISTS_BATCH) {
      const batch = known.slice(i, i + EXISTS_BATCH).map((k) => k.messageId);
      const existing = await this.gateway.existingAudioMessageIds(batch);
      const missing = batch.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        marked += await this.tracks.markUnavailable(channelId, missing);
        this.logger.warn({ msg: 'tracks no longer on telegram', count: missing.length });
      }
    }
    return marked;
  }
}
