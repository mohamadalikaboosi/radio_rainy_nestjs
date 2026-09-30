import { audioMsg, FakeTelegramGateway } from '../../test/fake-telegram';
import { buildHarness, Harness, waitFor } from '../../test/engine-harness';
import { freshDb } from '../../test/test-db';
import { DatabaseService } from '../database/database.service';
import { TelegramTrackDiscovery } from '../telegram/track-discovery';
import { TrackRepository } from '../track/track.repository';
import { AdSource, PlayableAd } from './playback-engine';

const AD_BYTE = 200;
const AD_ID = '11111111-1111-4111-8111-111111111111';

/** Each track = 1 s (20000 B at 20000 B/s) filled with its message id; the ad is 1 s filled with 200. */
const addTrack = (gw: FakeTelegramGateway, id: number): void => gw.add(audioMsg(id, `Artist - Song ${id}`, { size: 20000, duration: 1 }), [Buffer.alloc(20000, id)]);
const seconds = (chunks: Buffer[]): number[] => {
  const all = Buffer.concat(chunks);
  const out: number[] = [];
  for (let i = 0; i < all.length; i += 20000) out.push(all[i] ?? -1);
  return out;
};

class FakeAds implements AdSource {
  playedIds: string[] = [];
  every = 2;
  fail = false;
  async everyN(): Promise<number> {
    return this.every;
  }
  async pick(): Promise<PlayableAd | null> {
    if (this.fail) throw new Error('db down');
    return {
      id: AD_ID,
      name: 'Test ad',
      open: () => ({
        bytes: (async function* () {
          yield Buffer.alloc(20000, AD_BYTE);
        })(),
        bytesPerSec: 20000,
        cancel: async () => undefined,
      }),
    };
  }
  async played(id: string): Promise<void> {
    this.playedIds.push(id);
  }
}

describe('PlaybackEngine ads', () => {
  let db: DatabaseService;
  let gw: FakeTelegramGateway;
  let h: Harness;
  let ads: FakeAds;

  beforeEach(async () => {
    db = await freshDb();
    gw = new FakeTelegramGateway();
    ads = new FakeAds();
    h = buildHarness(db, gw, {}, 1, '1001', ads);
    for (const i of [1, 2, 3, 4]) addTrack(gw, i);
    await new TelegramTrackDiscovery(gw, new TrackRepository(db)).sync('1001');
  });
  afterEach(async () => {
    await h.engine.stop();
    await db.onModuleDestroy();
  });

  const listen = (): Buffer[] => {
    const chunks: Buffer[] = [];
    h.broadcaster.subscribe({ write: (c) => void chunks.push(c), end: () => undefined });
    return chunks;
  };

  it('plays an ad after every N tracks, records the play, and clears the on-air state afterwards', async () => {
    const chunks = listen();
    h.engine.start();
    await waitFor(() => ads.playedIds.length >= 2);
    await h.engine.stop();
    const seq = seconds(chunks);
    // pattern: track, track, AD, track, track, AD ...
    const adAt = seq.map((b, i) => (b === AD_BYTE ? i : -1)).filter((i) => i >= 0);
    expect(adAt.length).toBeGreaterThanOrEqual(2);
    expect(adAt[0]).toBe(2);
    expect(adAt[1]).toBe(5);
    expect(seq.slice(0, 2).every((b) => b !== AD_BYTE)).toBe(true);
    expect((await h.state.get(h.channelId)).adId).toBeNull();
  });

  it('reports the ad as on air while it plays', async () => {
    let seen: string | null = null;
    const original = h.state.setAd.bind(h.state);
    h.state.setAd = async (c, id, at) => {
      if (id) seen = id;
      return original(c, id, at);
    };
    listen();
    h.engine.start();
    await waitFor(() => seen !== null);
    expect(seen).toBe(AD_ID);
  });

  it('never plays ads when everyN is 0', async () => {
    ads.every = 0;
    const chunks = listen();
    h.engine.start();
    await waitFor(() => seconds(chunks).length >= 6);
    await h.engine.stop();
    expect(seconds(chunks)).not.toContain(AD_BYTE);
    expect(ads.playedIds).toHaveLength(0);
  });

  it('a failing ad source never stalls the music', async () => {
    ads.fail = true;
    const chunks = listen();
    h.engine.start();
    await waitFor(() => seconds(chunks).length >= 6);
    await h.engine.stop();
    expect(seconds(chunks)).not.toContain(AD_BYTE);
  });

  it('skip cuts the ad and the music continues', async () => {
    const slow: PlayableAd = {
      id: AD_ID,
      name: 'slow',
      open: (signal) => ({
        bytes: (async function* () {
          for (let i = 0; i < 100 && !signal.aborted; i++) yield Buffer.alloc(20000, AD_BYTE);
        })(),
        bytesPerSec: 20000,
        cancel: async () => undefined,
      }),
    };
    ads.pick = async () => slow;
    const chunks = listen();
    h.engine.start();
    await waitFor(() => seconds(chunks).includes(AD_BYTE));
    expect(h.engine.skip()).toBe('SKIPPED');
    await waitFor(() => {
      const seq = seconds(chunks);
      const first = seq.indexOf(AD_BYTE);
      return seq.slice(first).some((b) => b !== AD_BYTE);
    });
    await h.engine.stop();
    const seq = seconds(chunks);
    const first = seq.indexOf(AD_BYTE);
    const run = seq.slice(first).findIndex((b) => b !== AD_BYTE);
    expect(run).toBeLessThan(90); // the 100-second ad was cut short
  });
});
