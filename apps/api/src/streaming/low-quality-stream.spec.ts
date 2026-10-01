import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broadcaster } from './broadcaster';
import { DEFAULT_LOW, LowQualityStream, lowQualityArgs } from './low-quality-stream';

const dir = mkdtempSync(join(tmpdir(), 'lowq-'));
const script = (name: string, body: string): string => {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
/** "ffmpeg" that upper-cases stdin so we can see the data went through the encoder. */
const echo = script('echo.js', "process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase())); process.stdin.on('end', () => process.exit(0));");
const crashy = script('crash.js', 'process.exit(1);');

const wait = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const sink = () => {
  const got: Buffer[] = [];
  return { got, text: () => Buffer.concat(got).toString(), sink: { write: (c: Buffer) => void got.push(c), end: jest.fn() } };
};

describe('lowQualityArgs', () => {
  it('encodes mono mp3 at the given bitrate, 24 kHz up to 64k', () => {
    const a = lowQualityArgs(48);
    expect(a).toEqual(expect.arrayContaining(['-b:a', '48k', '-ac', '1', '-ar', '24000']));
    expect(lowQualityArgs(96)).toEqual(expect.arrayContaining(['-ar', '44100']));
  });
});

describe('LowQualityStream', () => {
  const opts = { ...DEFAULT_LOW, restartMinMs: 20, restartMaxMs: 40 };

  it('runs ffmpeg only while someone listens and feeds listeners from the main stream', async () => {
    const main = new Broadcaster(10);
    const low = new LowQualityStream(main, { ...opts, ffmpegPath: echo });
    expect(low.running).toBe(false);
    expect(main.listenerCount).toBe(0);
    const a = sink();
    const offA = low.subscribe(a.sink);
    expect(low.running).toBe(true);
    expect(main.listenerCount).toBe(1); // ONE feed no matter how many low listeners
    const b = sink();
    const offB = low.subscribe(b.sink);
    expect(main.listenerCount).toBe(1);
    expect(low.listenerCount).toBe(2);
    main.push(Buffer.from('hello'));
    await wait(() => a.text().includes('HELLO') && b.text().includes('HELLO'));
    offA();
    offA(); // idempotent
    expect(low.running).toBe(true);
    offB();
    expect(low.running).toBe(false);
    expect(main.listenerCount).toBe(0);
  });

  it('restarts the encoder when it crashes while listeners are connected', async () => {
    const spawned: string[] = [];
    const main = new Broadcaster(10);
    const { spawn } = await import('node:child_process');
    let n = 0;
    const low = new LowQualityStream(main, { ...opts, ffmpegPath: echo }, (c, a) => {
      spawned.push(c);
      n++;
      return spawn(n === 1 ? crashy : c, a, { stdio: ['pipe', 'pipe', 'pipe'] });
    });
    const s = sink();
    const off = low.subscribe(s.sink);
    await wait(() => spawned.length >= 2);
    main.push(Buffer.from('again'));
    await wait(() => s.text().includes('AGAIN'));
    off();
  });

  it('becomes unavailable (and ends low listeners) when ffmpeg cannot be started, then recovers', async () => {
    let t = 1_000;
    const main = new Broadcaster(10);
    const low = new LowQualityStream(main, { ...opts, ffmpegPath: '/nonexistent/ffmpeg', brokenForMs: 1000 }, undefined, () => t);
    const s = sink();
    low.subscribe(s.sink);
    await wait(() => !low.available);
    expect(s.sink.end).toHaveBeenCalled();
    t += 1001;
    expect(low.available).toBe(true);
  });

  it('shutdown ends listeners and stops ffmpeg', async () => {
    const main = new Broadcaster(10);
    const low = new LowQualityStream(main, { ...opts, ffmpegPath: echo });
    const s = sink();
    low.subscribe(s.sink);
    low.shutdown();
    expect(low.running).toBe(false);
    expect(s.sink.end).toHaveBeenCalled();
    expect(main.listenerCount).toBe(0);
  });
});
