import { Logger } from '@nestjs/common';
import { ChannelRepository, ChannelRow } from '../channels/channel.repository';
import { TelegramLiveStreamer } from '../live/telegram-live-streamer';
import { RadioStateRepository } from '../radio/radio-state.repository';
import { Broadcaster } from '../streaming/broadcaster';
import { LowQualityStream } from '../streaming/low-quality-stream';
import { PlaybackEngine } from './playback-engine';

/** Everything that makes one channel a running radio station. */
export interface Station {
  channel: ChannelRow;
  broadcaster: Broadcaster;
  engine: PlaybackEngine;
  live: TelegramLiveStreamer;
  /** The data-saver stream (only encoded while somebody listens to it). */
  low?: LowQualityStream;
  /** Revision of the manual live target this station's streamer connected with (a change => reconnect). */
  liveRev?: number;
}

/** Everyone listening to a station, on either quality. */
export const listenersOf = (s: Pick<Station, 'broadcaster' | 'low'> | undefined): number => (s?.broadcaster.listenerCount ?? 0) + (s?.low?.listenerCount ?? 0);

export type StationFactory = (channel: ChannelRow) => Station;

/**
 * Runs on the leader only. Owns one Station (player + broadcaster + optional Telegram live stream) per *started* channel
 * and keeps the set in sync with the database (`reconcile`), which the admin panel changes at any time.
 */
export class StationManager {
  private readonly logger = new Logger(StationManager.name);
  private readonly stations = new Map<string, Station>();
  private reconciling: Promise<void> = Promise.resolve();

  constructor(
    private readonly channels: Pick<ChannelRepository, 'list' | 'setLiveStatus'>,
    private readonly state: Pick<RadioStateRepository, 'setStatus'>,
    private readonly factory: StationFactory,
  ) {}

  get(channelId: string): Station | undefined {
    return this.stations.get(channelId);
  }

  get active(): Station[] {
    return [...this.stations.values()];
  }

  /** Serialized: overlapping reconcile calls (rapid admin clicks) queue up instead of racing. */
  reconcile(): Promise<void> {
    this.reconciling = this.reconciling.then(() => this.doReconcile()).catch((err: unknown) => this.logger.error({ msg: 'station reconcile failed', err: err instanceof Error ? err.message : String(err) }));
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    const rows = await this.channels.list();
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const [id, station] of [...this.stations]) {
      const row = byId.get(id);
      if (!row || !row.started) await this.stopStation(id, station, row !== undefined);
    }

    for (const row of rows) {
      if (!row.started) continue;
      let station = this.stations.get(row.id);
      if (!station) {
        station = this.factory(row);
        this.stations.set(row.id, station);
        station.engine.start();
        this.logger.log({ msg: 'station started', channelId: row.id, slug: row.slug });
      } else {
        station.channel = row;
      }
      if (row.telegramLiveEnabled && station.live.running && station.liveRev !== undefined && station.liveRev !== row.liveTargetRev) {
        await station.live.stop(); // the link/key changed: reconnect with the new target
      }
      if (row.telegramLiveEnabled && !station.live.running) {
        station.liveRev = row.liveTargetRev;
        station.live.start();
      } else if (!row.telegramLiveEnabled && station.live.running) await station.live.stop();
    }
  }

  private async stopStation(id: string, station: Station, rowExists: boolean): Promise<void> {
    this.stations.delete(id);
    await station.live.stop().catch((e: unknown) => this.logger.warn({ msg: 'live stop failed', channelId: id, err: String(e) }));
    station.low?.shutdown();
    await station.engine.stop();
    if (rowExists) await this.state.setStatus(id, 'STOPPED', 'Station stopped by admin').catch((e: unknown) => this.logger.warn({ msg: 'state update failed', err: String(e) }));
    this.logger.log({ msg: 'station stopped', channelId: id });
  }

  async stopAll(): Promise<void> {
    await this.reconciling;
    for (const [id, station] of [...this.stations]) {
      this.stations.delete(id);
      // Keep the Telegram live stream open across restarts of this process? No: close cleanly so it can be re-created.
      await station.live.stop(false).catch((e: unknown) => this.logger.warn({ msg: 'live stop failed', err: String(e) }));
      station.low?.shutdown();
      await station.engine.stop();
    }
  }
}
