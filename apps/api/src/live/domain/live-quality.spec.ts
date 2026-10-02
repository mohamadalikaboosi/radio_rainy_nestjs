import { DEFAULT_ADAPT, LIVE_LADDER, LiveQualityController } from './live-quality';

const opt = { ...DEFAULT_ADAPT, cooldownMs: 1000, upAfterMs: 5000, windowMs: 2000 };
/** feeds `speed` once a second for `seconds`, returns the decisions seen */
const feed = (c: LiveQualityController, from: number, seconds: number, speed: number) => {
  const out: (string | null)[] = [];
  for (let s = 0; s <= seconds; s++) out.push(c.observe(speed, from + s * 1000));
  return out;
};

describe('LiveQualityController (adaptive bitrate of the Telegram live uplink)', () => {
  it('starts at the best level and stays while the stream keeps up', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    c.attemptStarted(0);
    expect(c.quality.name).toBe('high');
    expect(feed(c, 0, 4, 1.0).every((d) => d === null)).toBe(true);
  });

  it('steps down when ffmpeg cannot keep real time, one level at a time with a cooldown', () => {
    const c = new LiveQualityController(LIVE_LADDER, opt);
    c.attemptStarted(0);
    const d = feed(c, 0, 3, 0.6);
    expect(d).toContain('down');
    expect(c.quality.name).toBe('medium');
    c.attemptStarted(10_000);
    feed(c, 10_000, 3, 0.6);
    expect(c.quality.name).toBe('low');
    c.attemptStarted(20_000);
    feed(c, 20_000, 3, 0.6);
    expect(c.quality.name).toBe('minimum');
    c.attemptStarted(30_000);
    expect(feed(c, 30_000, 5, 0.3).every((x) => x === null)).toBe(true); // nowhere lower to go
    expect(c.quality.name).toBe('minimum');
  });

  it('one slow second is noise, not a reason to degrade', () => {
    const c = new LiveQualityController(LIVE_LADDER, { ...opt, windowMs: 10_000 });
    c.attemptStarted(0);
    feed(c, 0, 9, 1.0);
    expect(c.observe(0.2, 10_000)).toBeNull();
    expect(c.quality.name).toBe('high');
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
    c.attemptStarted(0);
    feed(c, 0, 3, 0.5);
    expect(c.quality.name).toBe('medium');
    c.attemptStarted(10_000);
    const ups = feed(c, 10_000, 8, 1.0);
    expect(ups).toContain('up');
    expect(c.quality.name).toBe('high');
    // high immediately fails again: back to medium and the next probe needs twice as long
    c.attemptStarted(16_000);
    feed(c, 16_000, 3, 0.5);
    expect(c.quality.name).toBe('medium');
    c.attemptStarted(20_000);
    expect(feed(c, 20_000, 8, 1.0)).not.toContain('up'); // 8 s < 10 s now
    expect(feed(c, 29_000, 4, 1.0)).toContain('up');
  });
});
