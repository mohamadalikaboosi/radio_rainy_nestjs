import { Writable } from 'node:stream';
import { Broadcaster } from '../../radio/domain/broadcaster';
import { RtmpPublisher, RtmpTarget, TelegramLiveApi } from './ports/telegram-live';
import { DEFAULT_ADAPT, LIVE_LADDER, LiveQualityController } from '../domain/live-quality';
import { buildFfmpegRtmpArgs } from '../infrastructure/ffmpeg-rtmp-publisher';
import { TelegramLiveStreamer } from './telegram-live-streamer';

describe('buildFfmpegRtmpArgs', () => {
  it('publishes mp3 from stdin + a still video to url+key, AAC at 48 kHz', () => {
    const args = buildFfmpegRtmpArgs({ url: 'rtmps://dc5-1.rtmp.t.me:443/s/', key: 'abc-123' }, LIVE_LADDER[0]);
    expect(args.at(-1)).toBe('rtmps://dc5-1.rtmp.t.me:443/s/abc-123');
    expect(args).toEqual(expect.arrayContaining(['-f', 'mp3', '-i', 'pipe:0', '-c:a', 'aac', '-ar', '48000', '-f', 'flv']));
    expect(args).toEqual(expect.arrayContaining(['-b:a', '128k', '-b:v', '300k']));
    // a lower rung shrinks both the audio and the picture
    const low = buildFfmpegRtmpArgs({ url: 'rtmps://x/s/', key: 'k' }, LIVE_LADDER[2]);
    expect(low).toEqual(expect.arrayContaining(['-b:a', '64k', '-b:v', '120k']));
    expect(low[low.indexOf('-vf') + 1]).toContain('scale=640:360');
    // the picture comes from a PNG that ffmpeg re-reads for every frame (so an ad banner can replace it live)
    const withSlide = buildFfmpegRtmpArgs({ url: 'rtmps://x/s/', key: 'k' }, LIVE_LADDER[0], '/tmp/slide.png');
    expect(withSlide.slice(withSlide.indexOf('image2') - 1, withSlide.indexOf('image2') + 7)).toEqual(['-f', 'image2', '-loop', '1', '-framerate', '5', '-i', '/tmp/slide.png']);
    // the live encoder does no text rendering at all and is cheap: still-image tune, few frames per second, limited threads, silence instead of gaps
    expect(withSlide.join(' ')).not.toContain('drawtext');
    expect(withSlide).toEqual(expect.arrayContaining(['-tune', 'stillimage,zerolatency', '-threads', '2', '-af', 'aresample=async=1:first_pts=0']));
    // url without trailing slash still joins correctly
    expect(buildFfmpegRtmpArgs({ url: 'rtmps://x/s', key: 'k' }).at(-1)).toBe('rtmps://x/s/k');
  });
});

describe('TelegramLiveStreamer', () => {
  const target: RtmpTarget = { url: 'rtmps://fake/s/', key: 'k' };
  const wait = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  function setup(publish: RtmpPublisher['publish'], openImpl?: TelegramLiveApi['openLiveStream'], quality = new LiveQualityController()) {
    const statuses: [string, string | null][] = [];
    const api: TelegramLiveApi = { openLiveStream: openImpl ?? (async () => target), closeLiveStream: jest.fn(async () => undefined) };
    const broadcaster = new Broadcaster(1000);
    const streamer = new TelegramLiveStreamer(
      '1001', 'Radio', broadcaster, api, { publish },
      { setLiveStatus: async (_id, s, e = null) => void statuses.push([s, e]) },
      { retryMinMs: 5, retryMaxMs: 20, maxBacklogBytes: 1024, stableAfterMs: 10_000, activeTimeoutMs: 400 },
      quality,
      (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }),
    );
    return { streamer, statuses, api, broadcaster };
  }

  it('goes LIVE, mirrors the radio stream into the publisher, and stops cleanly (closing the Telegram stream)', async () => {
    const received: Buffer[] = [];
    let attached = false;
    const { streamer, statuses, api, broadcaster } = setup(async (_t, input, signal, hooks) => {
      hooks?.onActive?.();
      const sink = new Writable({ write(chunk: Buffer, _e, cb) { received.push(chunk); cb(); } });
      const detach = input(sink);
      attached = true;
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      detach();
      return { code: 0, stderr: '' };
    });
    streamer.start();
    await wait(() => attached);
    expect(statuses.map((s) => s[0])).toEqual(['STARTING', 'LIVE']);
    broadcaster.push(Buffer.from('audio-1'));
    broadcaster.push(Buffer.from('audio-2'));
    await wait(() => Buffer.concat(received).toString().includes('audio-2'));
    expect(broadcaster.listenerCount).toBe(1);
    await streamer.stop();
    expect(api.closeLiveStream).toHaveBeenCalledWith('1001');
    expect(broadcaster.listenerCount).toBe(0); // no leaked subscription
    expect(statuses.at(-1)).toEqual(['OFF', null]);
    expect(streamer.running).toBe(false);
  });

  it('reports ERROR with the reason (e.g. missing admin right) and retries with backoff until it works', async () => {
    let opens = 0;
    const { streamer, statuses } = setup(
      async (_t, _i, signal, hooks) => {
        hooks?.onActive?.();
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        return { code: 0, stderr: '' };
      },
      async () => {
        if (++opens < 3) throw new Error('Telegram: CHAT_ADMIN_REQUIRED — the logged-in account must be an admin');
        return target;
      },
    );
    streamer.start();
    await wait(() => statuses.some((s) => s[0] === 'LIVE'));
    expect(opens).toBe(3);
    expect(statuses.filter((s) => s[0] === 'ERROR').map((s) => s[1])[0]).toMatch(/CHAT_ADMIN_REQUIRED/);
    await streamer.stop();
  });

  it('a crashing ffmpeg is restarted; the listener subscription is released every time', async () => {
    let runs = 0;
    const { streamer, broadcaster, statuses } = setup(async (_t, input, signal) => {
      const detach = input(new Writable({ write(_c, _e, cb) { cb(); } }));
      runs++;
      if (runs < 3) {
        detach();
        return { code: 1, stderr: 'Connection refused' };
      }
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      detach();
      return { code: 0, stderr: '' };
    });
    streamer.start();
    await wait(() => runs >= 3);
    expect(statuses.filter((s) => s[0] === 'ERROR').length).toBeGreaterThanOrEqual(2);
    expect(broadcaster.listenerCount).toBe(1);
    await streamer.stop();
    expect(broadcaster.listenerCount).toBe(0);
  });

  it('a connection that never carries data (stuck handshake) is abandoned with an error, never reported LIVE', async () => {
    let runs = 0;
    const { streamer, statuses } = setup(async (_t, _i, signal) => {
      runs++;
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      return { code: null, stderr: 'tls: timeout' };
    });
    streamer.start();
    await wait(() => runs >= 2);
    expect(statuses.some((s) => s[0] === 'LIVE')).toBe(false);
    expect(statuses.find((s) => s[0] === 'ERROR')?.[1]).toMatch(/accepted no data.*tls: timeout/);
    await streamer.stop();
  });

  it('a connection too slow for real time lowers the quality and restarts WITHOUT an error or a back-off; later attempts use the new level', async () => {
    const levels: string[] = [];
    const quality = new LiveQualityController(LIVE_LADDER, { ...DEFAULT_ADAPT, sustainMs: 30, cooldownMs: 0, slowSpeed: 0.9 });
    const { streamer, statuses } = setup(async (_t, _i, signal, hooks, q) => {
      levels.push(q?.name ?? '?');
      hooks?.onActive?.();
      if (levels.length === 1) {
        // the first attempt: ffmpeg reports it only runs at 0.5x real time
        for (let i = 0; i < 12 && !signal.aborted; i++) {
          hooks?.onSpeed?.(0.5);
          await new Promise((r) => setTimeout(r, 15));
        }
      }
      if (!signal.aborted) await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      return { code: null, stderr: '' };
    }, undefined, quality);
    streamer.start();
    await wait(() => levels.length >= 2);
    expect(levels.slice(0, 2)).toEqual(['high', 'medium']);
    expect(statuses.some((s) => s[0] === 'ERROR')).toBe(false);
    await streamer.stop();
  });

  it('start() is idempotent and stop() before start is a no-op', async () => {
    const { streamer } = setup(async (_t, _i, signal) => {
      if (!signal.aborted) await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      return { code: 0, stderr: '' };
    });
    await streamer.stop();
    streamer.start();
    streamer.start();
    expect(streamer.running).toBe(true);
    await streamer.stop();
  });
});
