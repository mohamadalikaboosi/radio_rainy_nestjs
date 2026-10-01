import { DatabaseService } from '../src/shared/infrastructure/database/database.service';
import { TrackAudioPipeline } from '../src/radio/application/audio-pipeline';
import { StationMetrics } from '../src/radio/application/radio-metrics';
import { AdSource, EngineOptions, PlaybackEngine } from '../src/radio/application/playback-engine';
import { PlaybackHistoryRepository } from '../src/radio/application/ports/playback-history.repository';
import { PgPlaybackHistoryRepository } from '../src/radio/infrastructure/playback-history.repository';
import { RadioConfigRepository } from '../src/radio/application/ports/radio-config.repository';
import { PgRadioConfigRepository } from '../src/radio/infrastructure/radio-config.repository';
import { RadioScheduler } from '../src/radio/application/radio-scheduler';
import { RadioStateRepository } from '../src/radio/application/ports/radio-state.repository';
import { PgRadioStateRepository } from '../src/radio/infrastructure/radio-state.repository';
import { seededRng } from '../src/radio/domain/rng';
import { Broadcaster } from '../src/radio/domain/broadcaster';
import { TrackRepository } from '../src/catalog/application/ports/track.repository';
import { PgTrackRepository } from '../src/catalog/infrastructure/persistence/track.repository';
import { FakeTelegramGateway } from './fake-telegram';

/** Time-warp clock: pacing sleeps advance virtual time instantly, so a 3-minute track plays in milliseconds. */
export class VirtualClock {
  t = Date.now();
  now = (): number => this.t;
  sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return;
    this.t += ms;
    await new Promise((r) => setImmediate(r));
  };
}

export interface Harness {
  engine: PlaybackEngine;
  broadcaster: Broadcaster;
  clock: VirtualClock;
  tracks: TrackRepository;
  history: PlaybackHistoryRepository;
  state: RadioStateRepository;
  config: RadioConfigRepository;
  scheduler: RadioScheduler;
  channelId: string;
}

export const CHANNEL = '1001';

export function buildHarness(db: DatabaseService, gw: FakeTelegramGateway, over: Partial<EngineOptions> = {}, seed = 1, channelId = CHANNEL, ads?: AdSource, metrics?: StationMetrics): Harness {
  const clock = new VirtualClock();
  const tracks = new PgTrackRepository(db);
  const history = new PgPlaybackHistoryRepository(db);
  const state = new PgRadioStateRepository(db);
  const config = new PgRadioConfigRepository(db);
  const scheduler = new RadioScheduler(config, history, state, undefined, seededRng(seed));
  const broadcaster = new Broadcaster(8000);
  const engine = new PlaybackEngine({
    channelId,
    scheduler,
    state,
    history,
    tracks,
    audio: new TrackAudioPipeline(gw, null, 128),
    broadcaster,
    ads,
    metrics,
    options: {
      burstSeconds: 2,
      sliceBytes: 4000,
      preselectSeconds: 20,
      prefetchBytes: 64 * 1024,
      idleRetryMs: 30,
      maxBackoffMs: 30,
      now: clock.now,
      sleep: clock.sleep,
      ...over,
    },
  });
  return { engine, broadcaster, clock, tracks, history, state, config, scheduler, channelId };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
