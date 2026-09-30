import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramNotReadyError } from '../telegram/telegram.types';
import { DiskAudioCache } from './disk-audio-cache';

const collect = async (it: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const c of it) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A fake Telegram download: `chunks` of `size` bytes each, `delayMs` apart. Counts how often it was started. */
function source(total: number, opts: { chunk?: number; delayMs?: number; failAfter?: number; fail?: Error } = {}) {
  const calls = { n: 0 };
  const data = Buffer.from(Array.from({ length: total }, (_, i) => i % 251));
  const fill = (): AsyncIterable<Uint8Array> =>
    (async function* () {
      calls.n++;
      const chunk = opts.chunk ?? 10_000;
      for (let off = 0; off < total; off += chunk) {
        if (opts.delayMs) await sleep(opts.delayMs);
        if (opts.failAfter !== undefined && off >= opts.failAfter) throw opts.fail ?? new Error('network down');
        yield data.subarray(off, Math.min(total, off + chunk));
      }
    })();
  return { calls, data, fill };
}

describe('DiskAudioCache', () => {
  let dir: string;
  let cache: DiskAudioCache;
  const make = (over: Partial<ConstructorParameters<typeof DiskAudioCache>[0]> = {}): DiskAudioCache => new DiskAudioCache({ dir, maxBytes: 10_000_000, maxConcurrentFills: 2, ...over });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rr-cache-'));
    cache = make();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('miss: downloads once, serves the caller while the file is still being written, then hits from disk', async () => {
    const s = source(100_000, { delayMs: 2 });
    const first = await collect(cache.stream('audio/1/1-aa', 100_000, s.fill));
    expect(first.equals(s.data)).toBe(true);
    expect(cache.metrics.misses).toBe(1);

    const second = await collect(cache.stream('audio/1/1-aa', 100_000, s.fill));
    expect(second.equals(s.data)).toBe(true);
    expect(s.calls.n).toBe(1); // no second Telegram download
    expect(cache.metrics.hits).toBe(1);
    expect(await readdir(dir)).toEqual(['audio_1_1-aa']); // complete file only, no .part left behind
  });

  it('supports an offset (resume) on both a miss and a hit', async () => {
    const s = source(50_000);
    const miss = await collect(cache.stream('k1', 50_000, s.fill, { offset: 12_345 }));
    expect(miss.equals(s.data.subarray(12_345))).toBe(true);
    const hit = await collect(cache.stream('k1', 50_000, s.fill, { offset: 40_000 }));
    expect(hit.equals(s.data.subarray(40_000))).toBe(true);
    expect(s.calls.n).toBe(1);
  });

  it('two readers of the same track share ONE download (singleflight)', async () => {
    const s = source(80_000, { delayMs: 5 });
    const [a, b] = await Promise.all([collect(cache.stream('k2', 80_000, s.fill)), collect(cache.stream('k2', 80_000, s.fill))]);
    expect(a.equals(s.data) && b.equals(s.data)).toBe(true);
    expect(s.calls.n).toBe(1);
  });

  it('keeps filling the file after the reader stops (prefetch): the next reader gets a full disk hit', async () => {
    const s = source(120_000, { delayMs: 3 });
    const ac = new AbortController();
    const it = cache.stream('k3', 120_000, s.fill, { signal: ac.signal })[Symbol.asyncIterator]();
    await it.next(); // only the first chunk is consumed (like the engine's small prefetch read)
    ac.abort();
    await it.return?.(undefined);
    for (let i = 0; i < 200 && cache.stats().activeFills > 0; i++) await sleep(10);
    const again = await collect(cache.stream('k3', 120_000, s.fill));
    expect(again.equals(s.data)).toBe(true);
    expect(s.calls.n).toBe(1);
    expect(cache.metrics.hits).toBe(1);
  });

  it('a failed download leaves nothing behind, reports the ORIGINAL error, and the next attempt starts clean', async () => {
    const err = new TelegramNotReadyError();
    const bad = source(100_000, { failAfter: 30_000, fail: err });
    await expect(collect(cache.stream('k4', 100_000, bad.fill))).rejects.toBe(err);
    expect(await readdir(dir)).toEqual([]);
    expect(cache.metrics.fillFailures).toBe(1);
    const good = source(100_000);
    expect((await collect(cache.stream('k4', 100_000, good.fill))).equals(good.data)).toBe(true);
  });

  it('an incomplete download (fewer bytes than expected) is never published as a cached file', async () => {
    const short = source(60_000);
    await expect(collect(cache.stream('k5', 70_000, short.fill))).rejects.toThrow('incomplete download');
    expect(await readdir(dir)).toEqual([]);
  });

  it('detects a corrupted cached file (size mismatch), discards it and downloads again', async () => {
    const s = source(40_000);
    await collect(cache.stream('k6', 40_000, s.fill));
    await writeFile(join(dir, 'k6'), Buffer.alloc(1234)); // truncated/garbled on disk
    const fresh = await make().stream('k6', 40_000, s.fill)[Symbol.asyncIterator]();
    const all: Buffer[] = [];
    for (let r = await fresh.next(); !r.done; r = await fresh.next()) all.push(Buffer.from(r.value));
    expect(Buffer.concat(all).equals(s.data)).toBe(true);
    expect(s.calls.n).toBe(2);
    expect((await stat(join(dir, 'k6'))).size).toBe(40_000);
  });

  it('startup removes unfinished .part files and indexes complete ones', async () => {
    await writeFile(join(dir, 'old.part'), 'half');
    await writeFile(join(dir, 'complete'), Buffer.alloc(500));
    const c = make();
    await c.init();
    expect(await readdir(dir)).toEqual(['complete']);
    expect(c.stats()).toMatchObject({ files: 1, bytes: 500 });
  });

  it('stays under the size limit by evicting the least recently used files, never one that is being read', async () => {
    const small = make({ maxBytes: 250_000 });
    const s = source(100_000);
    await collect(small.stream('a', 100_000, s.fill));
    await sleep(15);
    await collect(small.stream('b', 100_000, s.fill));
    await sleep(15);
    await collect(small.stream('a', 100_000, s.fill)); // a is now more recent than b
    await sleep(15);
    await collect(small.stream('c', 100_000, s.fill)); // needs room: evicts b (LRU)
    expect((await readdir(dir)).sort()).toEqual(['a', 'c']);
    expect(small.metrics.evictions).toBe(1);
    expect(small.stats().bytes).toBeLessThanOrEqual(250_000);
  });

  it('files larger than the whole cache bypass it (still streamed, nothing kept)', async () => {
    const tiny = make({ maxBytes: 10_000 });
    const s = source(50_000);
    expect((await collect(tiny.stream('big', 50_000, s.fill))).equals(s.data)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('is a pass-through when disabled (0 MB)', async () => {
    const off = make({ maxBytes: 0 });
    const s = source(20_000);
    expect(off.enabled).toBe(false);
    expect((await collect(off.stream('x', 20_000, s.fill, { offset: 5000 }))).equals(s.data.subarray(5000))).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('limits concurrent Telegram fills', async () => {
    const limited = make({ maxConcurrentFills: 1 });
    let running = 0;
    let peak = 0;
    const mk = (n: number) => () =>
      (async function* () {
        running++;
        peak = Math.max(peak, running);
        await sleep(20);
        yield Buffer.alloc(n, 7);
        running--;
      })();
    await Promise.all([collect(limited.stream('p1', 1000, mk(1000))), collect(limited.stream('p2', 2000, mk(2000))), collect(limited.stream('p3', 3000, mk(3000)))]);
    expect(peak).toBe(1);
  });
});
