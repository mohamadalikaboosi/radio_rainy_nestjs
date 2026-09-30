import { DatabaseService } from '../src/database/database.service';
import { TrackAudioPipeline } from '../src/playback/audio-pipeline';
import { EngineOptions, PlaybackEngine } from '../src/playback/playback-engine';
import { PlaybackHistoryRepository } from '../src/playback/playback-history.repository';
import { RadioConfigRepository } from '../src/radio/radio-config.repository';
import { RadioScheduler } from '../src/radio/radio-scheduler';
import { RadioStateRepository } from '../src/radio/radio-state.repository';
import { seededRng } from '../src/radio/rng';
import { Broadcaster } from '../src/streaming/broadcaster';
import { TrackRepository } from '../src/track/track.repository';
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
}

export function buildHarness(db: DatabaseService, gw: FakeTelegramGateway, over: Partial<EngineOptions> = {}, seed = 1): Harness {
  const clock = new VirtualClock();
  const tracks = new TrackRepository(db);
  const history = new PlaybackHistoryRepository(db);
  const state = new RadioStateRepository(db);
  const config = new RadioConfigRepository(db);
  const scheduler = new RadioScheduler(config, history, state, undefined, seededRng(seed));
  const broadcaster = new Broadcaster(8000);
  const engine = new PlaybackEngine({
    scheduler,
    state,
    history,
    tracks,
    audio: new TrackAudioPipeline(gw, null, 128),
    broadcaster,
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
  return { engine, broadcaster, clock, tracks, history, state, config, scheduler };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
