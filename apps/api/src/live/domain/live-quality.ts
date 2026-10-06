/** One rung of the Telegram live quality ladder (what ffmpeg encodes and sends up). */
export interface LiveQuality {
  name: 'high' | 'medium' | 'low' | 'minimum';
  videoKbps: number;
  audioKbps: number;
  width: number;
  height: number;
  fps: number;
}

/** Best first. The picture is a still frame, so the audio is what matters; the ladder shrinks both so a weak uplink keeps the music flowing. */
export const LIVE_LADDER: readonly LiveQuality[] = [
  { name: 'high', videoKbps: 300, audioKbps: 128, width: 1280, height: 720, fps: 5 },
  { name: 'medium', videoKbps: 200, audioKbps: 96, width: 854, height: 480, fps: 5 },
  { name: 'low', videoKbps: 120, audioKbps: 64, width: 640, height: 360, fps: 4 },
  { name: 'minimum', videoKbps: 60, audioKbps: 48, width: 426, height: 240, fps: 2 },
];

export interface AdaptOptions {
  /** A measured speed below this (1.0 = exactly real time) means the uplink cannot keep up. */
  slowSpeed: number;
  /** ...and it must stay below for this long before anything is done (a restart is itself a cut in the stream). */
  sustainMs: number;
  /** A level is only changed this long after the previous change. */
  cooldownMs: number;
  /** Below this the stream is clearly starving: further steps down are allowed right after the cooldown. */
  starvedSpeed: number;
  /** A second step down for a merely "slow" (not starving) stream needs this long since the last change: if lowering the bitrate did not help, the bottleneck is not the bitrate. */
  repeatDownAfterMs: number;
  /** First time: this long of a healthy stream before trying a better level again. Doubles each time the better level failed quickly. */
  upAfterMs: number;
  maxUpAfterMs: number;
  /** Unexpected exits within this window count as "the connection is unstable". */
  crashWindowMs: number;
  crashesToDegrade: number;
}

export const DEFAULT_ADAPT: AdaptOptions = {
  slowSpeed: 0.85,
  sustainMs: 15_000,
  cooldownMs: 60_000,
  starvedSpeed: 0.6,
  repeatDownAfterMs: 5 * 60_000,
  upAfterMs: 120_000,
  maxUpAfterMs: 15 * 60_000,
  crashWindowMs: 90_000,
  crashesToDegrade: 2,
};

/**
 * The CURRENT encoding speed of ffmpeg from its progress output: media time produced / wall time that passed, over a sliding window.
 * (ffmpeg's own `speed=` is an average since the process started, so the connect/probe delay of the first seconds drags it below 1.0 for a
 * minute even on a perfect link: acting on it restarts a healthy stream again and again.) Nothing is reported during the warm-up.
 */
export class SpeedMeter {
  private points: { wall: number; out: number }[] = [];
  private t0: number | null = null;

  constructor(private readonly windowMs = 12_000, private readonly warmupMs = 10_000) {}

  /** `outUs` = ffmpeg's `out_time_us` (media microseconds written so far). Returns the speed over the window, or null while warming up. */
  add(wallMs: number, outUs: number): number | null {
    this.t0 ??= wallMs;
    if (wallMs - this.t0 < this.warmupMs) return null; // connecting / probing: not part of the measurement at all
    this.points = [...this.points.filter((p) => wallMs - p.wall <= this.windowMs), { wall: wallMs, out: outUs }];
    const first = this.points[0];
    const last = this.points[this.points.length - 1];
    if (!first || !last) return null;
    const dw = last.wall - first.wall;
    if (dw < this.windowMs * 0.6) return null;
    return (last.out - first.out) / 1000 / dw;
  }
}

export type Decision = 'down' | 'up' | null;

/**
 * Picks the quality like a video player would, but on the sending side: it watches how fast ffmpeg manages to push the stream and steps down
 * when it SUSTAINABLY falls behind or the connection keeps dropping, and carefully tries a better level again after a long healthy period.
 * Conservative on purpose: every change restarts ffmpeg, which is a cut for the viewers. Pure (time is passed in), so it is unit-tested.
 */
export class LiveQualityController {
  private idx = 0;
  private crashes: number[] = [];
  private lastChange = -Infinity;
  private belowSince: number | null = null;
  private healthySince: number | null = null;
  private upAfter: number;
  private lastUpAt = -Infinity;

  constructor(private readonly ladder: readonly LiveQuality[] = LIVE_LADDER, private readonly opt: AdaptOptions = DEFAULT_ADAPT, startAt = 0) {
    this.idx = Math.min(Math.max(startAt, 0), ladder.length - 1);
    this.upAfter = opt.upAfterMs;
  }

  get quality(): LiveQuality {
    return this.ladder[this.idx] as LiveQuality;
  }

  get level(): number {
    return this.idx;
  }

  /** A new ffmpeg process started: the history of the previous one is meaningless. */
  attemptStarted(now: number): void {
    this.belowSince = null;
    this.healthySince = null;
    void now;
  }

  /** `speed` is the CURRENT speed (see SpeedMeter), never ffmpeg's cumulative one. */
  observe(speed: number, now: number): Decision {
    if (!Number.isFinite(speed) || speed <= 0) return null;
    if (speed < this.opt.slowSpeed) {
      this.healthySince = null;
      this.belowSince ??= now;
      if (now - this.belowSince >= this.opt.sustainMs) return this.down(now, speed);
      return null;
    }
    this.belowSince = null;
    if (speed >= 0.97) {
      this.healthySince ??= now;
      if (now - this.healthySince >= this.upAfter) return this.up(now);
    } else {
      this.healthySince = null;
    }
    return null;
  }

  /** ffmpeg exited by itself (not because we changed the level). Repeated drops step the quality down. */
  crashed(now: number): Decision {
    this.crashes = [...this.crashes.filter((t) => now - t <= this.opt.crashWindowMs), now];
    this.healthySince = null;
    this.belowSince = null;
    if (this.crashes.length >= this.opt.crashesToDegrade) {
      this.crashes = [];
      return this.down(now, 0, true);
    }
    return null;
  }

  private down(now: number, speed: number, force = false): Decision {
    if (this.idx >= this.ladder.length - 1) return null;
    const since = now - this.lastChange;
    if (!force) {
      if (since < this.opt.cooldownMs) return null;
      // slow but not starving, and lowering the bitrate a moment ago did not fix it: the bottleneck is elsewhere, stop restarting
      if (speed >= this.opt.starvedSpeed && since < this.opt.repeatDownAfterMs && this.lastChange > -Infinity) return null;
    }
    // the better level we just left failed soon after we tried it: wait longer before trying again
    if (now - this.lastUpAt < this.upAfter) this.upAfter = Math.min(this.opt.maxUpAfterMs, this.upAfter * 2);
    this.idx++;
    this.lastChange = now;
    this.belowSince = null;
    this.healthySince = null;
    return 'down';
  }

  private up(now: number): Decision {
    if (this.idx === 0 || now - this.lastChange < this.opt.cooldownMs) return null;
    this.idx--;
    this.lastChange = now;
    this.lastUpAt = now;
    this.belowSince = null;
    this.healthySince = null;
    return 'up';
  }
}
