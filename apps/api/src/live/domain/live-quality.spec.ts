import { mp3Cbr } from '../../../test/mp3';
import { DEFAULT_ADAPT, LIVE_LADDER, LiveQualityController, SourceRate, SpeedMeter } from './live-quality';

describe('SourceRate (how fast the radio feeds the live encoder)', () => {
  /** Feeds `kbps` audio from wall time `from` for `seconds`, as the pacer would: one 100 ms chunk per `everyMs` of wall time. */
  const feed = (r: SourceRate, kbps: number, from: number, seconds: number, everyMs = 100): number => {
    const chunk = mp3Cbr(kbps, 0.096); // 4 frames, 96 ms of audio
    let t = from;
    for (; t < from + seconds * 1000; t += everyMs) r.fed(chunk, t);
    return t;
  };

  it('reads ~1.0 for a radio that keeps up, whatever its bitrate', () => {
    for (const kbps of [128, 320]) {
      const r = new SourceRate();
      const t = feed(r, kbps, 0, 30, 96);
      expect(r.ratio(t)).toBeCloseTo(1, 1);
    }
  });

  it('a 320 kbps track paced as 128 kbps (the old bug) reads 0.4', () => {
    const r = new SourceRate();
    const t = feed(r, 320, 0, 30, 240); // 96 ms of audio every 240 ms
    expect(r.ratio(t)).toBeCloseTo(0.4, 1);
  });

  it('silence (the radio stalled between tracks) reads 0, and nothing is reported before a whole window was seen', () => {
    const r = new SourceRate();
    expect(r.ratio(0)).toBeNull();
    const t = feed(r, 128, 0, 5, 96);
    expect(r.ratio(t)).toBeNull(); // only 5 s seen
    feed(r, 128, t, 10, 96);
    expect(r.ratio(t + 10_000 + 31_000)).toBe(0); // 31 s without a byte
  });
});

describe('SpeedMeter (the CURRENT speed of the Telegram live encoder)', () => {
  /** ffmpeg started at wall time 0 but produced its first output only after `startupMs`; afterwards it runs exactly in real time. */
  const run = (startupMs: number, seconds: number, rate: number): { t: number; speed: number | null; cumulative: number }[] => {
    const meter = new SpeedMeter();
    const out: { t: number; speed: number | null; cumulative: number }[] = [];
    for (let t = 500; t <= seconds * 1000; t += 500) {
      const media = Math.max(0, t - startupMs) * rate; // ms of media produced by wall time t
      out.push({ t, speed: meter.add(t, media * 1000), cumulative: media / t });
    }
    return out;
  };

  it('is silent during the warm-up', () => {
    expect(run(6000, 9, 1).every((p) => p.speed === null)).toBe(true);
  });

  it('a link that keeps up reads ~1.0 although ffmpeg\'s own cumulative speed (startup delay!) stays below 0.9 for a minute', () => {
    const pts = run(6000, 60, 1);
    const at30 = pts.find((p) => p.t === 30_000);
    expect(at30?.cumulative).toBeLessThan(0.85); // what the old logic saw: "too slow", restart, again and again
    expect(at30?.speed).toBeCloseTo(1, 1); // what is really happening
    expect(pts.filter((p) => p.speed !== null).every((p) => (p.speed as number) > 0.97)).toBe(true);
  });

  it('a link that really cannot keep up reads low', () => {
    const pts = run(2000, 40, 0.6).filter((p) => p.speed !== null);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.at(-1)?.speed).toBeCloseTo(0.6, 1);
  });
});

describe('LiveQualityController (adaptive bitrate of the Telegram live uplink)', () => {
  const opt = { ...DEFAULT_ADAPT, sustainMs: 4000, cooldownMs: 10_000, repeatDownAfterMs: 60_000, upAfterMs: 20_000 };
  /** feeds `speed` once a second from `from` to `from+seconds`, returns the first non-null decision with its time */
  const feed = (c: LiveQualityController, from: number, seconds: number, speed: number): { d: string; at: number } | null => {
    for (let s = 0; s <= seconds; s++) {
      const d = c.observe(speed, from + s * 1000);
      if (d) return { d, at: from + s * 1000 };
    }
    return null;
  };

  it('stays on the best level while the stream keeps up', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    expect(feed(c, 0, 10, 1.0)).toBeNull();
    expect(c.quality.name).toBe('high');
  });

  it('a short dip is ignored: it must be slow for the whole sustain period', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    for (let s = 0; s < 3; s++) expect(c.observe(0.7, s * 1000)).toBeNull();
    expect(c.observe(1.0, 3000)).toBeNull(); // recovered: the timer resets
    for (let s = 4; s < 7; s++) expect(c.observe(0.7, s * 1000)).toBeNull();
    expect(c.quality.name).toBe('high');
  });

  it('a sustained slow stream steps down once', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    const r = feed(c, 0, 10, 0.7);
    expect(r?.d).toBe('down');
    expect(c.quality.name).toBe('medium');
  });

  it('if lowering the bitrate did not help (still merely slow), it does NOT keep restarting the stream', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    expect(feed(c, 0, 10, 0.7)?.d).toBe('down');
    c.attemptStarted(11_000);
    expect(feed(c, 11_000, 40, 0.8)).toBeNull(); // cooldown passed, but 0.8 is not starving and the last change was recent
    expect(c.quality.name).toBe('medium');
    c.attemptStarted(70_000);
    expect(feed(c, 70_000, 10, 0.8)?.d).toBe('down'); // a long time later it may try the next rung
  });

  it('a starving stream keeps stepping down (after the cooldown)', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    expect(feed(c, 0, 10, 0.3)?.d).toBe('down');
    c.attemptStarted(11_000);
    expect(feed(c, 11_000, 20, 0.3)?.d).toBe('down');
    expect(c.quality.name).toBe('low');
  });

  it('a slow encoder fed by a slow radio is not a slow connection: no step down (each one is a restart, a cut for the viewers)', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    for (let s = 0; s <= 60; s++) expect(c.observe(0.4, s * 1000, 0.4)).toBeNull(); // the logs: 0.40 on every rung
    expect(c.quality.name).toBe('high');
    // the radio recovers but the uplink really is slow now: the usual rule applies again
    expect(feed(c, 61_000, 10, 0.5)?.d).toBe('down');
  });

  it('readings while the radio was starved never count as healthy either (no step up on them)', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt, 1);
    for (let s = 0; s <= 60; s++) expect(c.observe(1.0, s * 1000, 0.5)).toBeNull();
    expect(c.quality.name).toBe('medium');
  });

  it('a drop while the radio fed nothing (Telegram closes a silent stream) does not count against the connection', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    expect(c.crashed(0, 0)).toBeNull();
    expect(c.crashed(30_000, 0.1)).toBeNull();
    expect(c.quality.name).toBe('high');
    expect(c.crashed(40_000, 1)).toBeNull(); // the first drop that counts
    expect(c.crashed(50_000, null)).toBe('down');
  });

  it('a connection that keeps dropping lowers the quality (second drop inside the window)', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    expect(c.crashed(0)).toBeNull();
    expect(c.crashed(30_000)).toBe('down');
    expect(c.quality.name).toBe('medium');
    expect(c.crashed(10 * 60_000)).toBeNull(); // old drop expired
  });

  it('tries a better level after a long healthy period, and waits longer if that failed quickly', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    expect(feed(c, 0, 10, 0.3)?.d).toBe('down'); // -> medium
    c.attemptStarted(12_000);
    const up = feed(c, 12_000, 40, 1.0);
    expect(up?.d).toBe('up'); // 20 s healthy
    expect(c.quality.name).toBe('high');
    // high fails again right away: down, and the next probe needs twice as long
    c.attemptStarted((up?.at ?? 0) + 1000);
    const down = feed(c, (up?.at ?? 0) + 1000, 30, 0.3);
    expect(down?.d).toBe('down');
    c.attemptStarted((down?.at ?? 0) + 1000);
    expect(feed(c, (down?.at ?? 0) + 1000, 30, 1.0)).toBeNull(); // 30 s healthy < 40 s now
    expect(feed(c, (down?.at ?? 0) + 31_000, 20, 1.0)?.d).toBe('up');
  });
});
