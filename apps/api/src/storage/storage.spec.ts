import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from 'minio';
import S3rver from 's3rver';
import { audioMsg, FakeTelegramGateway } from '../../test/fake-telegram';
import { AudioStore, AudioStoreSource } from './audio-store';
import { CachingTelegramGateway, resolverFrom } from './caching-gateway';
import { MinioAudioStore } from './minio-audio-store';

const collect = async (it: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const out: Buffer[] = [];
  for await (const c of it) out.push(Buffer.from(c));
  return Buffer.concat(out);
};

/** In-memory AudioStore with failure injection. */
class MemStore implements AudioStore {
  objects = new Map<string, Buffer>();
  failStat = false;
  failPut = false;
  failOpenAfter: number | null = null;
  puts = 0;
  async stat(key: string) {
    if (this.failStat) throw new Error('store down');
    const o = this.objects.get(key);
    return o ? { size: o.length } : null;
  }
  async *open(key: string, opts: { offset?: number } = {}) {
    const o = this.objects.get(key);
    if (!o) throw new Error('missing');
    const data = o.subarray(opts.offset ?? 0);
    for (let i = 0; i < data.length; i += 4) {
      if (this.failOpenAfter !== null && i >= this.failOpenAfter) throw new Error('read broke');
      yield data.subarray(i, i + 4);
    }
  }
  async put(key: string, data: NodeJS.ReadableStream) {
    this.puts++;
    if (this.failPut) {
      data.resume();
      throw new Error('upload rejected');
    }
    const chunks: Buffer[] = [];
    for await (const c of data) chunks.push(Buffer.from(c as Buffer));
    this.objects.set(key, Buffer.concat(chunks));
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async ping() {
    /* ok */
  }
  async usage() {
    return { objects: this.objects.size, bytes: [...this.objects.values()].reduce((s, b) => s + b.length, 0), truncated: false };
  }
}

describe('CachingTelegramGateway', () => {
  const CH = '1001';
  let inner: FakeTelegramGateway;
  let store: MemStore;
  let current: AudioStore | null;
  let gw: CachingTelegramGateway;
  const source: AudioStoreSource = { current: async () => current };
  const payload = Buffer.from('0123456789abcdefghij'); // 20 bytes

  beforeEach(() => {
    inner = new FakeTelegramGateway();
    inner.add(audioMsg(1, 'A - One', { size: 20, duration: 1 }), [payload.subarray(0, 8), payload.subarray(8, 16), payload.subarray(16)]);
    store = new MemStore();
    current = store;
    gw = new CachingTelegramGateway(inner, source, resolverFrom(async (_c, m) => (m === 1 ? { fileReference: 'doc-1', fileSize: 20 } : null)));
  });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('miss: downloads from Telegram ONCE, returns the bytes and fills the cache; hit: no Telegram call at all', async () => {
    expect((await collect(gw.download(CH, 1))).equals(payload)).toBe(true);
    await settle();
    expect(inner.downloadCalls).toEqual([1]);
    expect([...store.objects.values()][0]?.equals(payload)).toBe(true);
    expect([...store.objects.keys()][0]).toMatch(/^audio\/1001\/1-[0-9a-f]{16}$/);

    inner.downloadCalls.length = 0;
    expect((await collect(gw.download(CH, 1))).equals(payload)).toBe(true);
    expect(inner.downloadCalls).toEqual([]); // served from the store
  });

  it('a hit honours the resume offset', async () => {
    await collect(gw.download(CH, 1));
    await settle();
    inner.downloadCalls.length = 0;
    expect((await collect(gw.download(CH, 1, { offset: 12 }))).toString()).toBe('cdefghij');
    expect(inner.downloadCalls).toEqual([]);
  });

  it('caller leaving early (skip) still completes the cache from the same single download', async () => {
    const ac = new AbortController();
    const it = gw.download(CH, 1, { signal: ac.signal })[Symbol.asyncIterator]();
    await it.next(); // first chunk received, then the listener leaves (skip)
    ac.abort();
    await it.return?.();
    await settle();
    expect(inner.downloadCalls).toEqual([1]);
    expect([...store.objects.values()][0]?.equals(payload)).toBe(true);
  });

  it('a failed/incomplete Telegram download leaves NOTHING in the store', async () => {
    inner.flakyAfterChunks.set(1, 1);
    await expect(collect(gw.download(CH, 1))).rejects.toThrow('connection reset');
    await settle();
    expect(store.objects.size).toBe(0);
  });

  it('store problems never break playback: unreachable store, rejected upload, broken read', async () => {
    store.failStat = true;
    expect((await collect(gw.download(CH, 1))).equals(payload)).toBe(true); // straight from Telegram
    store.failStat = false;

    store.failPut = true;
    expect((await collect(gw.download(CH, 1))).equals(payload)).toBe(true);
    await settle();
    expect(store.objects.size).toBe(0);
    store.failPut = false;

    await collect(gw.download(CH, 1));
    await settle();
    store.failOpenAfter = 8; // cache read breaks mid-file -> continues from Telegram at the right offset
    expect((await collect(gw.download(CH, 1))).equals(payload)).toBe(true);
  });

  it('disabled cache / unknown track / size mismatch fall back to Telegram', async () => {
    current = null;
    expect((await collect(gw.download(CH, 1))).equals(payload)).toBe(true);
    expect(store.puts).toBe(0);
    current = store;
    store.objects.set([...(await keyOf(gw))][0] ?? 'x', Buffer.from('stale'));
    inner.downloadCalls.length = 0;
    expect((await collect(gw.download(CH, 1))).equals(payload)).toBe(true); // stale object ignored
    expect(inner.downloadCalls).toEqual([1]);
  });

  it('two simultaneous first plays start only one cache fill', async () => {
    const [a, b] = await Promise.all([collect(gw.download(CH, 1)), collect(gw.download(CH, 1))]);
    expect(a.equals(payload) && b.equals(payload)).toBe(true);
    await settle();
    expect(store.puts).toBe(1);
  });

  async function keyOf(g: CachingTelegramGateway): Promise<string[]> {
    const tmp = new MemStore();
    current = tmp;
    await collect(g.download(CH, 1));
    await settle();
    const keys = [...tmp.objects.keys()];
    current = store;
    return keys;
  }
});

describe('MinioAudioStore against an S3-compatible server (s3rver)', () => {
  let server: S3rver;
  let store: MinioAudioStore;
  let s3port = 0;

  beforeAll(async () => {
    server = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: mkdtempSync(join(tmpdir(), 's3-')), configureBuckets: [{ name: 'radio-rainy-audio', configs: [] }] });
    const addr = await server.run();
    s3port = typeof addr === 'string' ? Number(addr.split(':').pop()) : addr.port;
    store = new MinioAudioStore(new Client({ endPoint: '127.0.0.1', port: s3port, useSSL: false, accessKey: 'S3RVER', secretKey: 'S3RVER' }), 'radio-rainy-audio');
  });
  afterAll(async () => {
    await server.close();
  });

  it('put / stat / range read / usage / remove; missing objects are null', async () => {
    const data = Buffer.from('hello radio rainy — سلام');
    expect(await store.stat('audio/1/1-abc')).toBeNull();
    await store.put('audio/1/1-abc', Readable.from([data.subarray(0, 5), data.subarray(5)]), data.length);
    expect(await store.stat('audio/1/1-abc')).toEqual({ size: data.length });
    expect((await collect(store.open('audio/1/1-abc'))).equals(data)).toBe(true);
    expect((await collect(store.open('audio/1/1-abc', { offset: 6 }))).toString()).toBe(data.subarray(6).toString());
    expect(await store.usage()).toEqual({ objects: 1, bytes: data.length, truncated: false });
    await store.remove('audio/1/1-abc');
    expect(await store.stat('audio/1/1-abc')).toBeNull();
  });

  it('a stream that errors mid-upload creates no object', async () => {
    const broken = new Readable({ read() { this.push(Buffer.from('partial')); this.destroy(new Error('source died')); } });
    await expect(store.put('audio/1/2-broken', broken)).rejects.toThrow();
    expect(await store.stat('audio/1/2-broken')).toBeNull();
  });

  it('ping verifies bucket + read/write; a wrong secret is reported', async () => {
    await expect(store.ping()).resolves.toBeUndefined();
    const bad = new MinioAudioStore(new Client({ endPoint: '127.0.0.1', port: s3port, useSSL: false, accessKey: 'x', secretKey: 'y' }), 'radio-rainy-audio');
    await expect(bad.ping()).rejects.toBeDefined();
  });
});
