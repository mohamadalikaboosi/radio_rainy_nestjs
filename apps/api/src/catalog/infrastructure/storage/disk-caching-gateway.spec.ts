import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioMsg, FakeTelegramGateway } from '../../../../test/fake-telegram';
import { buildHarness, Harness, waitFor } from '../../../../test/engine-harness';
import { freshDb } from '../../../../test/test-db';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { RadioMetrics } from '../../../radio/application/radio-metrics';
import { TelegramTrackDiscovery } from '../../application/track-discovery';
import { PgTrackRepository } from '../persistence/track.repository';
import { resolverFrom } from './caching-gateway';
import { DiskAudioCache } from './disk-audio-cache';
import { DiskCachingGateway } from './disk-caching-gateway';

const audio = (fill: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(19996, fill)]);

describe('engine + DiskCachingGateway (Telegram is hit once per track)', () => {
  let db: DatabaseService;
  let fake: FakeTelegramGateway;
  let dir: string;
  let metrics: RadioMetrics;
  let h: Harness;

  beforeEach(async () => {
    db = await freshDb();
    dir = await mkdtemp(join(tmpdir(), 'rr-gw-'));
    fake = new FakeTelegramGateway();
    for (const i of [1, 2, 3]) fake.add(audioMsg(i, `Artist - Song ${i}`, { size: 20000, duration: 1 }), [audio(i)]);
    await new TelegramTrackDiscovery(fake, new PgTrackRepository(db)).sync('1001');
    metrics = new RadioMetrics();
    const tracks = new PgTrackRepository(db);
    const cache = new DiskAudioCache({ dir, maxBytes: 50_000_000, maxConcurrentFills: 2 }, metrics.cache);
    const cached = new DiskCachingGateway(fake, cache, resolverFrom((c, m) => tracks.getAudioIdentity(c, m)));
    h = buildHarness(db, cached as unknown as FakeTelegramGateway, { validateAudio: true });
  });
  afterEach(async () => {
    await h.engine.stop();
    await db.onModuleDestroy();
    await rm(dir, { recursive: true, force: true });
  });

  const plays = async (): Promise<number> => Number((await db.query('SELECT count(*) AS n FROM playback_history')).rows[0]?.n);

  it('9 plays of 3 tracks = 3 Telegram downloads; the rest are cache hits', async () => {
    h.broadcaster.subscribe({ write: () => undefined, end: () => undefined });
    h.engine.start();
    await waitFor(async () => (await plays()) >= 9);
    await h.engine.stop();
    expect(new Set(fake.downloadCalls).size).toBe(3);
    expect(fake.downloadCalls.length).toBe(3);
    expect(metrics.cache.misses).toBe(3);
    expect(metrics.cache.hits).toBeGreaterThanOrEqual(6);
  });

  it('keeps the radio playing from the cache while Telegram is unreachable', async () => {
    const chunks: Buffer[] = [];
    h.broadcaster.subscribe({ write: (c) => void chunks.push(c), end: () => undefined });
    h.engine.start();
    await waitFor(async () => (await plays()) >= 4); // every track has been cached by now
    fake.notReady = true; // Telegram goes away
    const before = await plays();
    await waitFor(async () => (await plays()) >= before + 4);
    await h.engine.stop();
    expect(fake.downloadCalls.length).toBe(3); // nothing was requested while it was down (and none failed)
    expect(chunks.length).toBeGreaterThan(0);
  });
});
