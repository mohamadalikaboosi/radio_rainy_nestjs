import { Logger } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { CacheMetrics } from '../../../radio/application/radio-metrics';

export interface DiskCacheOptions {
  dir: string;
  /** Hard size limit of complete files (least recently used are evicted). 0 disables caching. */
  maxBytes: number;
  /** How many Telegram downloads may fill the cache at the same time. */
  maxConcurrentFills: number;
}

interface Fill {
  file: string;
  part: string;
  written: number;
  done: boolean;
  error: unknown;
  waiters: Set<() => void>;
}

const READ_CHUNK = 64 * 1024;

const fileNameOf = (key: string): string => key.replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * Local audio cache: Telegram -> (one full-speed download per track) -> file -> playback.
 *  - The download is owned by the cache, not by the listener/engine: prefetching a track starts it and it keeps filling the file
 *    even when the player only reads the first bytes, so the whole next track is on disk before the current one ends.
 *  - Readers "tail" the growing file (nothing big is ever held in RAM: 64 KiB reads).
 *  - Files are written as `<name>.part` and renamed atomically when complete and the size matches: a crash/failed download never
 *    leaves a half file that looks valid; leftover `.part` files are deleted at startup (incomplete detection).
 *  - A complete file whose size differs from the track's known size is corrupted: deleted and downloaded again.
 *  - One fill per key (singleflight) however many readers ask; a global concurrency limit and an LRU size limit.
 */
export class DiskAudioCache {
  private readonly logger = new Logger(DiskAudioCache.name);
  private readonly fills = new Map<string, Fill>();
  private readonly index = new Map<string, { size: number; used: number }>();
  private readonly inUse = new Map<string, number>();
  private readonly slotWaiters: (() => void)[] = [];
  private activeFills = 0;
  private ready: Promise<void> | null = null;

  constructor(private readonly opt: DiskCacheOptions, readonly metrics: CacheMetrics = new CacheMetrics()) {}

  get enabled(): boolean {
    return this.opt.maxBytes > 0;
  }

  /** Creates the directory, removes unfinished `.part` files and indexes the complete ones. Idempotent. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.opt.dir, { recursive: true });
      for (const name of await readdir(this.opt.dir)) {
        const path = join(this.opt.dir, name);
        if (name.endsWith('.part')) {
          await rm(path, { force: true });
          continue;
        }
        const st = await stat(path).catch(() => null);
        if (st?.isFile()) this.index.set(name, { size: st.size, used: st.mtimeMs });
      }
      this.syncUsage();
      await this.evictFor(0);
    })();
    return this.ready;
  }

  /**
   * Streams the track from `offset`. `fill` downloads it from Telegram (always from 0, on a miss only). `size` is the expected size
   * when known (enables corruption/incomplete detection). Never buffers the file in memory.
   */
  async *stream(key: string, size: number | null, fill: () => AsyncIterable<Uint8Array>, opts: { offset?: number; signal?: AbortSignal } = {}): AsyncGenerator<Uint8Array> {
    if (!this.enabled || (size !== null && size > this.opt.maxBytes)) {
      yield* this.bypass(fill, opts);
      return;
    }
    await this.init();
    const file = fileNameOf(key);
    const offset = opts.offset ?? 0;
    this.hold(file);
    try {
      const existing = this.index.get(file);
      if (existing && !this.fills.has(file)) {
        const st = await stat(join(this.opt.dir, file)).catch(() => null);
        if (st && st.size === existing.size && (size === null || st.size === size)) {
          this.metrics.hits++;
          existing.used = Date.now();
          void utimes(join(this.opt.dir, file), new Date(), new Date()).catch(() => undefined);
          yield* this.readComplete(file, offset, opts.signal);
          return;
        }
        this.logger.warn({ msg: 'cached audio is corrupted or truncated; downloading again', key, expected: size, onDisk: st?.size ?? null });
        this.metrics.corrupted++;
        await this.drop(file);
      }
      this.metrics.misses++;
      const job = this.fills.get(file) ?? this.startFill(file, size, fill);
      yield* this.tail(job, offset, opts.signal);
    } finally {
      this.release(file);
    }
  }

  stats(): { files: number; bytes: number; activeFills: number } {
    return { files: this.index.size, bytes: this.totalBytes(), activeFills: this.activeFills };
  }

  // ---- reading ----

  private async *bypass(fill: () => AsyncIterable<Uint8Array>, opts: { offset?: number; signal?: AbortSignal }): AsyncGenerator<Uint8Array> {
    let skip = opts.offset ?? 0;
    for await (const chunk of fill()) {
      if (opts.signal?.aborted) return;
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      yield skip > 0 ? chunk.subarray(skip) : chunk;
      skip = 0;
    }
  }

  private async *readComplete(file: string, offset: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const stream = createReadStream(join(this.opt.dir, file), { start: offset, highWaterMark: READ_CHUNK });
    const abort = (): void => void stream.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) return;
        yield chunk as Buffer;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      stream.destroy();
    }
  }

  /** Follows the file while the fill job is still writing it. */
  private async *tail(job: Fill, offset: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    let handle: FileHandle | null = null;
    let pos = offset;
    try {
      while (!signal?.aborted) {
        if (job.written > pos) {
          handle ??= await open(job.part, 'r').catch(async () => open(join(this.opt.dir, job.file), 'r').catch((e: unknown) => {
            throw job.error ?? e; // the fill failed and removed its file: report why
          })); // (renamed meanwhile = the complete file)
          const n = Math.min(READ_CHUNK, job.written - pos);
          const buf = Buffer.allocUnsafe(n);
          const { bytesRead } = await handle.read(buf, 0, n, pos);
          if (bytesRead === 0) throw new Error('cache file shorter than reported');
          pos += bytesRead;
          yield bytesRead === n ? buf : buf.subarray(0, bytesRead);
          continue;
        }
        if (job.error) throw job.error;
        if (job.done) return;
        await new Promise<void>((resolve) => {
          job.waiters.add(resolve);
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  // ---- filling ----

  private startFill(file: string, size: number | null, fill: () => AsyncIterable<Uint8Array>): Fill {
    const job: Fill = { file, part: join(this.opt.dir, `${file}.part`), written: 0, done: false, error: null, waiters: new Set() };
    this.fills.set(file, job);
    this.hold(file);
    const notify = (): void => {
      const w = [...job.waiters];
      job.waiters.clear();
      for (const f of w) f();
    };
    void (async () => {
      let fh: FileHandle | null = null;
      const startedAt = Date.now();
      try {
        await this.acquireSlot();
        await this.evictFor(size ?? 0);
        fh = await open(job.part, 'w');
        for await (const chunk of fill()) {
          await fh.write(chunk);
          job.written += chunk.length;
          this.metrics.fillBytes += chunk.length;
          notify();
        }
        if (size !== null && job.written !== size) throw new Error(`incomplete download: ${job.written}/${size} bytes`);
        if (job.written === 0) throw new Error('empty download');
        await fh.close();
        fh = null;
        await rename(job.part, join(this.opt.dir, file));
        this.index.set(file, { size: job.written, used: Date.now() });
        this.syncUsage();
        job.done = true;
        this.logger.log({ msg: 'track cached', file, bytes: job.written, ms: Date.now() - startedAt });
      } catch (err) {
        this.metrics.fillFailures++;
        await fh?.close().catch(() => undefined);
        await rm(job.part, { force: true });
        job.error = err; // published only after the cleanup; keeps the original type (TelegramNotReadyError etc. drive the engine's outage handling)
      } finally {
        this.releaseSlot();
        this.fills.delete(file);
        this.release(file);
        notify();
      }
    })();
    return job;
  }

  private acquireSlot(): Promise<void> {
    if (this.activeFills < this.opt.maxConcurrentFills) {
      this.activeFills++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.slotWaiters.push(() => {
      this.activeFills++;
      resolve();
    }));
  }

  private releaseSlot(): void {
    this.activeFills--;
    this.slotWaiters.shift()?.();
  }

  // ---- size management ----

  private hold(file: string): void {
    this.inUse.set(file, (this.inUse.get(file) ?? 0) + 1);
  }

  private release(file: string): void {
    const n = (this.inUse.get(file) ?? 1) - 1;
    if (n <= 0) this.inUse.delete(file);
    else this.inUse.set(file, n);
  }

  private totalBytes(): number {
    let t = 0;
    for (const v of this.index.values()) t += v.size;
    for (const f of this.fills.values()) t += f.written;
    return t;
  }

  private syncUsage(): void {
    this.metrics.bytesOnDisk = this.totalBytes();
    this.metrics.filesOnDisk = this.index.size;
  }

  private async drop(file: string): Promise<void> {
    this.index.delete(file);
    await rm(join(this.opt.dir, file), { force: true });
    this.syncUsage();
  }

  /** Evicts least-recently-used complete files that nobody is reading until `incoming` more bytes fit. */
  private async evictFor(incoming: number): Promise<void> {
    if (this.totalBytes() + incoming <= this.opt.maxBytes) return;
    const victims = [...this.index.entries()].filter(([f]) => !this.inUse.has(f)).sort((a, b) => a[1].used - b[1].used);
    for (const [file] of victims) {
      if (this.totalBytes() + incoming <= this.opt.maxBytes) break;
      await this.drop(file);
      this.metrics.evictions++;
    }
  }
}
