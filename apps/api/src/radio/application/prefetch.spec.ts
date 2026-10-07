import { audioMsg, FakeTelegramGateway } from '../../../test/fake-telegram';
import { buildHarness, Harness, waitFor } from '../../../test/engine-harness';
import { freshDb } from '../../../test/test-db';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { StationMetrics } from './radio-metrics';
import { TelegramTrackDiscovery } from '../../catalog/application/track-discovery';
import { PgTrackRepository } from '../../catalog/infrastructure/persistence/track.repository';
import { PlaybackEvent } from './playback-engine';
import { id3Tag, mp3Cbr } from '../../../test/mp3';

/** A valid-looking MPEG frame header followed by `fill` so the corruption check accepts it. 1 s = 20000 B. */
const audio = (fill: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(19996, fill)]);
const addTrack = (gw: FakeTelegramGateway, id: number, data: Buffer = audio(id)): void => gw.add(audioMsg(id, `Artist - Song ${id}`, { size: 20000, duration: 1 }), [data]);
/** The "id" of each 1-second block (its 5th byte, after the frame header). */
const blocks = (chunks: Buffer[]): number[] => {
  const all = Buffer.concat(chunks);
  const out: number[] = [];
  for (let i = 0; i < all.length; i += 20000) out.push(all[i + 4] ?? -1);
  return out;
};

describe('PlaybackEngine prefetch, fail-over, state and metrics', () => {
  let db: DatabaseService;
  let gw: FakeTelegramGateway;
  let h: Harness;
  let metrics: StationMetrics;
  let events: PlaybackEvent[];
  let discovery: TelegramTrackDiscovery;

  const boot = (over: Parameters<typeof buildHarness>[2] = {}, seed = 1): void => {
    metrics = new StationMetrics();
    h = buildHarness(db, gw, { validateAudio: true, prefetchTimeoutMs: 2000, ...over }, seed, '1001', undefined, metrics);
    events = [];
    h.engine.subscribe((e) => void events.push(e));
  };
  const listen = (): Buffer[] => {
    const chunks: Buffer[] = [];
    h.broadcaster.subscribe({ write: (c) => void chunks.push(c), end: () => undefined });
    return chunks;
  };
  const plays = async (): Promise<number> => Number((await db.query('SELECT count(*) AS n FROM playback_history')).rows[0]?.n);
  const failures = async (msg: number): Promise<number> => Number((await db.query('SELECT consecutive_failures AS n FROM tracks WHERE telegram_message_id = $1', [msg])).rows[0]?.n);

  beforeEach(async () => {
    db = await freshDb();
    gw = new FakeTelegramGateway();
    discovery = new TelegramTrackDiscovery(gw, new PgTrackRepository(db));
  });
  afterEach(async () => {
    await h.engine.stop();
    await db.onModuleDestroy();
  });

  it('prepares the next track BEFORE the current one ends (next is READY in the state while the current plays)', async () => {
    for (const i of [1, 2, 3]) addTrack(gw, i);
    await discovery.sync('1001');
    boot();
    listen();
    h.engine.start();
    await waitFor(async () => (await h.state.get('1001')).nextTrackId !== null && h.engine.current !== null);
    const st = await h.state.get('1001');
    expect(st.nextTrackId).not.toBe(st.currentTrackId);
    expect(gw.downloadCalls.length).toBeGreaterThanOrEqual(2); // the next download started while the first was still on air
  });

  it('a broken next track is replaced while the current one is still playing: no pause, no broken audio on air', async () => {
    for (const i of [1, 2, 3, 4]) addTrack(gw, i);
    gw.failDownloadFor.add(2);
    await discovery.sync('1001');
    boot();
    const chunks = listen();
    h.engine.start();
    await waitFor(async () => (await plays()) >= 8);
    await h.engine.stop();
    expect(blocks(chunks)).not.toContain(2);
    expect(metrics.prefetchFailovers).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'prefetch-failover' && e.reason === 'FAILED')).toBe(true);
    expect(await failures(2)).toBeGreaterThanOrEqual(1); // repeated failures mark the track invalid
    expect(metrics.audibleGaps).toBe(0);
  });

  it('a prefetch that takes too long is replaced by another track, without blaming the slow track', async () => {
    for (const i of [1, 2, 3]) addTrack(gw, i);
    await discovery.sync('1001');
    const original = gw.download.bind(gw);
    gw.download = async function* (channelId, id, opts = {}) {
      if (id === 3) await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true })); // never answers
      yield* original(channelId, id, opts);
    };
    boot({ prefetchTimeoutMs: 80 });
    const chunks = listen();
    h.engine.start();
    await waitFor(async () => (await plays()) >= 6);
    await h.engine.stop();
    expect(blocks(chunks)).not.toContain(3);
    expect(events.some((e) => e.type === 'prefetch-failover' && e.reason === 'TIMEOUT')).toBe(true);
    expect(await failures(3)).toBe(0);
  });

  it('whole-track buffering never leaves the radio silent: a download slower than playback just streams while it plays', async () => {
    for (const i of [1, 2, 3]) addTrack(gw, i);
    await discovery.sync('1001');
    const original = gw.download.bind(gw);
    gw.download = async function* (channelId, id, opts = {}) {
      let n = 0;
      for await (const c of original(channelId, id, opts)) {
        if (n++ > 0) await new Promise((r) => setTimeout(r, 1500)); // everything after the first chunk is slower than real time
        yield c;
      }
    };
    boot({ bufferWholeTrack: true, prefetchBytes: 64 * 1024 * 1024, prefetchTimeoutMs: 600 });
    listen();
    h.engine.start();
    await waitFor(async () => (await plays()) >= 3, 15_000);
    await h.engine.stop();
    expect(events.filter((e) => e.type === 'prefetch-failover')).toHaveLength(0);
  });

  it('corrupt audio (no MPEG frame) never goes on air and is counted against the track', async () => {
    addTrack(gw, 1);
    addTrack(gw, 2, Buffer.alloc(20000, 9)); // garbage
    addTrack(gw, 3);
    await discovery.sync('1001');
    boot();
    const chunks = listen();
    h.engine.start();
    await waitFor(async () => (await plays()) >= 6);
    await h.engine.stop();
    expect(blocks(chunks)).not.toContain(2);
    expect(blocks(chunks).includes(9)).toBe(false);
    expect(events.some((e) => e.type === 'prefetch-failover' && e.reason === 'CORRUPT')).toBe(true);
    expect(await failures(2)).toBeGreaterThanOrEqual(1);
  });

  it('records transitions: normal ones are gapless (covered by the buffer) and the lead stays within the burst', async () => {
    for (const i of [1, 2, 3]) addTrack(gw, i);
    await discovery.sync('1001');
    boot();
    listen();
    h.engine.start();
    await waitFor(() => metrics.transitions >= 4);
    await h.engine.stop();
    expect(metrics.audibleGaps).toBe(0);
    expect(metrics.maxTransitionMs).toBeLessThan(2000);
    expect(metrics.bufferSeconds).toBeLessThanOrEqual(2.5);
    expect(metrics.transitionFailures).toBe(0);
    expect(events.filter((e) => e.type === 'transition').length).toBeGreaterThanOrEqual(4);
  });

  it('counts a buffer underrun when the source stalls longer than the buffer', async () => {
    addTrack(gw, 1);
    await discovery.sync('1001');
    boot({ burstSeconds: 0.5 });
    const original = gw.download.bind(gw);
    let slowed = false;
    gw.download = async function* (channelId, id, opts = {}) {
      for await (const c of original(channelId, id, opts)) {
        if (slowed) h.clock.t += 10_000; // the source stalls for 10 s while listeners only hold 0.5 s
        slowed = true;
        yield c;
      }
    };
    listen();
    h.engine.start();
    await waitFor(() => metrics.underruns >= 1);
    expect(metrics.underruns).toBeGreaterThanOrEqual(1);
  });

  it('a 320 kbps MP3 with cover art goes on air in real time (paced as 128 kbps it played at 0.4x and starved every listener)', async () => {
    const file = Buffer.concat([id3Tag(58_000), mp3Cbr(320, 6)]); // the metadata reads 397 kbps
    gw.add(audioMsg(1, 'Ebi - Derakht', { size: file.length, duration: 6 }), [file]);
    await discovery.sync('1001');
    boot();
    let rate = 0;
    const at: { start?: number; end?: number } = {};
    h.engine.subscribe((e) => {
      if (e.type === 'track-started' && at.start === undefined) {
        at.start = h.clock.t;
        rate = h.engine.current?.bytesPerSec ?? -1;
      }
      if (e.type === 'track-ended' && at.end === undefined) at.end = h.clock.t;
    });
    listen();
    h.engine.start();
    await waitFor(() => at.end !== undefined);
    expect(rate).toBe(40_000);
    // 6 s of audio minus the 2 s burst ahead of real time; at 128 kbps it would have taken ~13 s
    const onAir = (at.end ?? 0) - (at.start ?? 0);
    expect(onAir).toBeGreaterThan(3500);
    expect(onAir).toBeLessThan(4500);
  });

  it('getState() derives the position from the canonical clock, never from a per-listener counter', async () => {
    gw.add(audioMsg(1, 'Artist - Long song', { size: 100_000, duration: 5 }), [Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(99_996, 1)])]);
    await discovery.sync('1001');
    // the pacer blocks after the 2 s burst, so the track stays "on air" while we look at it
    boot({ sleep: (_ms, signal) => new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true })) });
    listen();
    h.engine.start();
    await waitFor(() => h.engine.current !== null);
    const first = h.engine.getState();
    expect(first).toMatchObject({ status: 'PLAYING', trackId: h.engine.current?.track.id, duration: 5 });
    expect(first.startedAt).toBe(h.engine.current?.startedAt.getTime());
    expect(first.bufferedSeconds).toBeGreaterThan(0);
    const t0 = h.clock.t;
    h.clock.t += 350; // "current time = startedAt + X" => position = X (capped to the duration)
    expect(h.engine.getState().position).toBeCloseTo(Math.min(1, (t0 + 350 - (first.startedAt ?? 0)) / 1000), 2);
    await h.engine.stop();
    expect(h.engine.getState().status).toBe('STOPPED');
  });

  it('track finished + admin skip at the same moment never produce two current tracks or overlapping history', async () => {
    for (const i of [1, 2, 3, 4]) addTrack(gw, i);
    await discovery.sync('1001');
    boot();
    listen();
    h.engine.start();
    for (let round = 0; round < 6; round++) {
      await waitFor(() => h.engine.current !== null);
      const seq = h.engine.current?.seq;
      await Promise.all([Promise.resolve(h.engine.skip(seq)), Promise.resolve(h.engine.skip(seq)), Promise.resolve(h.engine.playNext())]);
      await waitFor(() => (h.engine.current?.seq ?? 0) > (seq ?? 0));
    }
    await h.engine.stop();
    const open = await db.query(`SELECT count(*)::int AS n FROM playback_history WHERE ended_at IS NULL`);
    expect((open.rows[0] as { n: number }).n).toBe(0);
    const overlaps = await db.query(`SELECT count(*)::int AS n FROM playback_history a JOIN playback_history b ON a.id < b.id AND a.started_at < b.started_at AND a.ended_at > b.started_at + interval '50 milliseconds'`);
    expect((overlaps.rows[0] as { n: number }).n).toBe(0);
  });

  it('a listener leaving never disturbs the shared engine', async () => {
    for (const i of [1, 2]) addTrack(gw, i);
    await discovery.sync('1001');
    boot();
    const a = h.broadcaster.subscribe({ write: () => undefined, end: () => undefined });
    const chunks = listen();
    h.engine.start();
    await waitFor(() => h.engine.current !== null);
    a();
    const before = chunks.length;
    await waitFor(() => chunks.length > before + 5);
    expect(h.engine.running).toBe(true);
  });
});
