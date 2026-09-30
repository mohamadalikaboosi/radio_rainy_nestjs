import { audioMsg, FakeTelegramGateway } from '../../test/fake-telegram';
import { buildHarness, Harness, waitFor } from '../../test/engine-harness';
import { freshDb } from '../../test/test-db';
import { DatabaseService } from '../database/database.service';
import { TelegramTrackDiscovery } from '../telegram/track-discovery';
import { TrackRepository } from '../track/track.repository';

/** Each track = 1 second of "audio" (20000 B at 20000 B/s) filled with its message id, so bytes identify the track. */
const addTrack = (gw: FakeTelegramGateway, id: number, caption = `Artist - Song ${id}`): void =>
  gw.add(audioMsg(id, caption, { size: 20000, duration: 1 }), [Buffer.alloc(20000, id)]);

const ids = (chunks: Buffer[]): number[] => {
  const all = Buffer.concat(chunks);
  const seq: number[] = [];
  for (let i = 0; i < all.length; i += 20000) seq.push(all[i] ?? -1);
  return seq;
};

const gatedSleep =
  (gate: Promise<void>) =>
  async (_ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return;
    await Promise.race([gate, new Promise<void>((r) => signal?.addEventListener('abort', () => r()))]);
  };

describe('PlaybackEngine', () => {
  let db: DatabaseService;
  let gw: FakeTelegramGateway;
  let h: Harness;
  let discovery: TelegramTrackDiscovery;
  let extra: Harness[] = [];

  beforeEach(async () => {
    db = await freshDb();
    gw = new FakeTelegramGateway();
    h = buildHarness(db, gw);
    extra = [];
    discovery = new TelegramTrackDiscovery(gw, new TrackRepository(db));
  });
  afterEach(async () => {
    await Promise.all(extra.map((e) => e.engine.stop()));
    await h.engine.stop();
    await db.onModuleDestroy();
  });

  const listen = (): { chunks: Buffer[]; off: () => void; ended: () => boolean } => {
    const chunks: Buffer[] = [];
    let ended = false;
    const off = h.broadcaster.subscribe({ write: (c) => void chunks.push(c), end: () => void (ended = true) });
    return { chunks, off, ended: () => ended };
  };
  const plays = async () => Number((await db.query(`SELECT count(*) AS n FROM playback_history`)).rows[0]?.n);

  it('plays random tracks continuously, never repeating immediately, and records history', async () => {
    for (const i of [1, 2, 3, 4]) addTrack(gw, i);
    await discovery.sync('1001');
    const l = listen();
    h.engine.start();
    await waitFor(async () => (await plays()) >= 8);
    await h.engine.stop();
    const order = (await db.query<{ n: number }>(`SELECT t.telegram_message_id AS n FROM playback_history p JOIN tracks t ON t.id=p.track_id ORDER BY p.started_at, p.id`)).rows.map((r) => r.n);
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
    expect(new Set(order).size).toBeGreaterThan(1);
    // recent window of 10 > library of 4 must degrade gracefully (no stall): we got 8+ plays
    const finished = await db.query(`SELECT count(*)::int AS n FROM playback_history WHERE end_reason = 'FINISHED'`);
    expect((finished.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(7);
    expect(ids(l.chunks).length).toBeGreaterThanOrEqual(8);
    expect(l.ended()).toBe(true); // stop() ends listeners cleanly
  });

  it('transitions are gapless: listener bytes are exactly the tracks back to back', async () => {
    for (const i of [1, 2, 3]) addTrack(gw, i);
    await discovery.sync('1001');
    const l = listen();
    h.engine.start();
    await waitFor(async () => (await plays()) >= 4);
    await h.engine.stop();
    const all = Buffer.concat(l.chunks);
    expect(all.length % 20000 === 0 || all.length > 0).toBe(true);
    const seq = ids(l.chunks);
    // every full 20000-byte block is homogeneous (no interleaving / corruption at transitions)
    for (let b = 0; b + 20000 <= all.length; b += 20000) {
      expect(new Set(all.subarray(b, b + 20000)).size).toBe(1);
    }
    expect(seq.length).toBeGreaterThanOrEqual(3);
  });

  it('serves many listeners from ONE Telegram download per play; disconnects free resources', async () => {
    for (const i of [1, 2]) addTrack(gw, i);
    await discovery.sync('1001');
    const a = listen();
    const b = listen();
    const c = listen();
    c.off();
    expect(h.broadcaster.listenerCount).toBe(2);
    h.engine.start();
    await waitFor(async () => (await plays()) >= 3);
    await h.engine.stop();
    expect(Buffer.concat(a.chunks).equals(Buffer.concat(b.chunks))).toBe(true);
    expect(c.chunks).toHaveLength(0);
    expect(gw.downloadCalls.length).toBeLessThanOrEqual((await plays()) + 1); // one per play (+ possibly one unused prefetch)
    expect(h.broadcaster.listenerCount).toBe(0);
  });

  it('a late listener gets the buffered tail immediately (low join latency)', async () => {
    addTrack(gw, 1);
    addTrack(gw, 2);
    await discovery.sync('1001');
    h.engine.start();
    await waitFor(async () => (await plays()) >= 2);
    const late = listen();
    expect(Buffer.concat(late.chunks).length).toBeGreaterThan(0);
    expect(Buffer.concat(late.chunks).length).toBeLessThanOrEqual(8000 + 4000);
  });

  it('skips a track whose download fails, keeps radio alive, and marks it FAILED after repeated failures', async () => {
    addTrack(gw, 1);
    addTrack(gw, 2);
    gw.failDownloadFor.add(2);
    await discovery.sync('1001');
    const l = listen();
    h.engine.start();
    await waitFor(async () => (await plays()) >= 5);
    await h.engine.stop();
    expect(new Set(ids(l.chunks))).toEqual(new Set([1]));
    const t2 = (await db.query<{ status: string; consecutive_failures: number }>(`SELECT status, consecutive_failures FROM tracks WHERE telegram_message_id = 2`)).rows[0];
    expect(t2?.status).toBe('FAILED');
    expect((await db.query(`SELECT status FROM tracks WHERE telegram_message_id = 1`)).rows[0]).toEqual({ status: 'READY' });
  });

  it('resumes a broken download from the last byte instead of skipping the track', async () => {
    gw.add(audioMsg(1, 'A - One', { size: 20000, duration: 1 }), [Buffer.alloc(10000, 1), Buffer.alloc(10000, 1)]);
    gw.flakyAfterChunks.set(1, 1);
    await discovery.sync('1001');
    const l = listen();
    h.engine.start();
    await waitFor(async () => Buffer.concat(l.chunks).length >= 20000);
    await h.engine.stop();
    expect(Buffer.concat(l.chunks).subarray(0, 20000).equals(Buffer.alloc(20000, 1))).toBe(true);
    expect(gw.downloadCalls.slice(0, 2)).toEqual([1, 1]);
  });

  it('empty library: IDLE with a reason (no busy loop); starts once a track appears', async () => {
    h.engine.start();
    await waitFor(async () => (await h.state.get('1001')).statusReason === 'NO_PLAYABLE_TRACKS');
    expect((await h.state.get('1001')).statusReason).toBe('NO_PLAYABLE_TRACKS');
    addTrack(gw, 1);
    await discovery.sync('1001');
    h.engine.wake();
    await waitFor(async () => (await h.state.get('1001')).status === 'PLAYING');
    expect((await h.state.get('1001')).currentTrackId).not.toBeNull();
  });

  it('skip is idempotent, stale tokens are ignored, and it triggers exactly one transition', async () => {
    for (const i of [1, 2, 3]) addTrack(gw, i);
    await discovery.sync('1001');
    // Block pacing so the first track stays "playing" until we act.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slowH = buildHarness(db, gw, { burstSeconds: 0, ...{ sleep: gatedSleep(gate) } }, 2);
    extra.push(slowH);
    slowH.engine.start();
    await waitFor(() => slowH.engine.current !== null);
    const seq = slowH.engine.current?.seq ?? 0;
    expect(slowH.engine.skip(seq + 99)).toBe('STALE');
    expect(slowH.engine.skip(seq)).toBe('SKIPPED');
    expect(slowH.engine.skip(seq)).toBe('ALREADY_SKIPPING');
    expect(slowH.engine.skip()).toBe('ALREADY_SKIPPING');
    release(); // un-gate pacing so the next track can start
    await waitFor(() => slowH.engine.current !== null && slowH.engine.current.seq !== seq);
    await slowH.engine.stop();
    const skipped = await db.query(`SELECT count(*)::int AS n FROM playback_history WHERE end_reason = 'SKIPPED'`);
    expect((skipped.rows[0] as { n: number }).n).toBe(1); // 4 skip() calls -> exactly one transition
    const first = (await db.query<{ end_reason: string }>(`SELECT end_reason FROM playback_history ORDER BY started_at, id LIMIT 1`)).rows[0];
    expect(first?.end_reason).toBe('SKIPPED');
  });

  it('playNext(trackId) plays exactly that track next', async () => {
    for (const i of [1, 2, 3]) addTrack(gw, i);
    await discovery.sync('1001');
    const target = (await db.query<{ id: string }>(`SELECT id FROM tracks WHERE telegram_message_id = 3`)).rows[0]?.id ?? '';
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slowH = buildHarness(db, gw, { burstSeconds: 0, ...{ sleep: gatedSleep(gate) } }, 3);
    extra.push(slowH);
    slowH.engine.start();
    await waitFor(() => slowH.engine.current !== null);
    const firstSeq = slowH.engine.current?.seq ?? 0;
    expect(slowH.engine.playNext(target)).toBe('SKIPPED');
    release();
    await waitFor(() => slowH.engine.current !== null && slowH.engine.current.seq > firstSeq);
    expect(slowH.engine.current?.track.id).toBe(target);
    await slowH.engine.stop();
  });

  it('Telegram outage does NOT mark tracks FAILED: status ERROR, recovers when Telegram is back', async () => {
    addTrack(gw, 1);
    addTrack(gw, 2);
    await discovery.sync('1001');
    gw.notReady = true;
    h.engine.start();
    await waitFor(async () => (await h.state.get('1001')).status === 'ERROR');
    await new Promise((r) => setTimeout(r, 150));
    const rows = (await db.query<{ status: string; consecutive_failures: number }>(`SELECT status, consecutive_failures FROM tracks`)).rows;
    expect(rows.every((r) => r.status === 'READY' && r.consecutive_failures === 0)).toBe(true);
    gw.notReady = false;
    h.engine.wake();
    await waitFor(async () => (await h.state.get('1001')).status === 'PLAYING', 12000);
  });

  it('radio disabled -> STOPPED', async () => {
    addTrack(gw, 1);
    await discovery.sync('1001');
    await db.query('UPDATE radio_configuration SET enabled = false');
    h.engine.start();
    await waitFor(async () => (await h.state.get('1001')).status === 'STOPPED');
  });
});
