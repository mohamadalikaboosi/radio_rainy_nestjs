import { Writable } from 'node:stream';
import { Broadcaster } from './broadcaster';
import { HttpListenerSink } from '../application/http-listener-sink';
import { stripId3v2 } from './id3';
import { pace } from './pacer';

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};
async function* from(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c;
}

describe('Broadcaster', () => {
  const sink = () => {
    const got: Buffer[] = [];
    return { got, sink: { write: (c: Buffer) => void got.push(c), end: jest.fn() } };
  };

  it('fans identical bytes to all listeners and gives late joiners the buffered tail', () => {
    const b = new Broadcaster(10);
    const a = sink();
    b.subscribe(a.sink);
    b.push(Buffer.from('aaaa'));
    b.push(Buffer.from('bbbb'));
    b.push(Buffer.from('cccc'));
    const late = sink();
    b.subscribe(late.sink);
    b.push(Buffer.from('dddd'));
    expect(Buffer.concat(a.got).toString()).toBe('aaaabbbbccccdddd');
    // ring keeps >= 10 bytes: bbbb cccc (8) is < 10 so aaaa is kept too
    expect(Buffer.concat(late.got).toString()).toBe('aaaabbbbccccdddd'.slice(0));
    expect(b.listenerCount).toBe(2);
  });

  it('unsubscribe frees the listener; a throwing sink is dropped without affecting others', () => {
    const b = new Broadcaster(4);
    const good = sink();
    const off = b.subscribe(good.sink);
    b.subscribe({ write: () => { throw new Error('dead'); }, end: () => undefined });
    b.push(Buffer.from('x'));
    expect(b.listenerCount).toBe(1);
    off();
    off(); // idempotent
    expect(b.listenerCount).toBe(0);
    b.push(Buffer.from('y'));
    expect(Buffer.concat(good.got).toString()).toBe('x');
  });

  it('endAll ends and removes every listener', () => {
    const b = new Broadcaster(4);
    const a = sink();
    b.subscribe(a.sink);
    b.endAll();
    expect(a.sink.end).toHaveBeenCalled();
    expect(b.listenerCount).toBe(0);
  });

  it('ring buffer memory stays bounded', () => {
    const b = new Broadcaster(1000);
    for (let i = 0; i < 10_000; i++) b.push(Buffer.alloc(100));
    const s = sink();
    b.subscribe(s.sink);
    expect(Buffer.concat(s.got).length).toBeLessThan(1200);
  });
});

describe('HttpListenerSink', () => {
  it('drops listeners whose backlog exceeds the limit', () => {
    const slow = new Writable({ highWaterMark: 4, write() { /* never calls back: simulates a stuck client */ } });
    const drops: string[] = [];
    const s = new HttpListenerSink(slow, 100, (r) => drops.push(r));
    for (let i = 0; i < 20; i++) s.write(Buffer.alloc(20));
    expect(slow.destroyed).toBe(true);
    expect(drops).toEqual(['slow-listener']);
  });
});

describe('pace', () => {
  it('emits burst immediately and then at real-time rate (fake clock)', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const out = await collect(
      pace(from(Buffer.alloc(4000)), {
        bytesPerSec: 1000,
        burstSeconds: 1,
        sliceBytes: 500,
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
      }),
    );
    expect(out).toHaveLength(8);
    // slices 0-2 go out at once (1s burst + the current slice); the remaining 5 are spaced 500ms apart
    expect(sleeps).toEqual([500, 500, 500, 500, 500]);
    expect(t).toBe(2500);
  });

  it('re-anchors after a stall instead of flooding a catch-up burst', async () => {
    let t = 0;
    const sleeps: number[] = [];
    async function* slowSource(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(1000);
      t += 60_000; // download stalled for a minute
      yield Buffer.alloc(3000);
    }
    await collect(pace(slowSource(), { bytesPerSec: 1000, burstSeconds: 1, sliceBytes: 1000, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } }));
    // after the stall the schedule is re-anchored: only the 1s burst goes out at once, the rest is paced again
    expect(sleeps).toEqual([1000]);
  });

  it('stops promptly on abort', async () => {
    const ac = new AbortController();
    const out: Buffer[] = [];
    for await (const c of pace(from(Buffer.alloc(100_000)), { bytesPerSec: 10, burstSeconds: 0, sliceBytes: 10, now: Date.now, sleep: async () => { ac.abort(); }, signal: ac.signal })) out.push(c);
    expect(out.length).toBeLessThanOrEqual(2);
  });
});

describe('stripId3v2', () => {
  const tag = (payload: number) => {
    const h = Buffer.alloc(10);
    h.write('ID3', 0, 'latin1');
    h[3] = 3;
    h[9] = payload & 0x7f;
    return Buffer.concat([h, Buffer.alloc(payload, 0xaa)]);
  };
  it('removes a tag even when split across chunks', async () => {
    const data = Buffer.concat([tag(50), Buffer.from('AUDIO')]);
    const out = Buffer.concat(await collect(stripId3v2(from(data.subarray(0, 7), data.subarray(7, 40), data.subarray(40)))));
    expect(out.toString()).toBe('AUDIO');
  });
  it('passes untagged data through untouched, including tiny inputs', async () => {
    expect(Buffer.concat(await collect(stripId3v2(from(Buffer.from('\xff\xfb9000000000000')))))).toEqual(Buffer.from('\xff\xfb9000000000000'));
    expect(Buffer.concat(await collect(stripId3v2(from(Buffer.from('abc')))))).toEqual(Buffer.from('abc'));
  });
});
