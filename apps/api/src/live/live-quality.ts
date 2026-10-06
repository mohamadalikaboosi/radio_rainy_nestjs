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
  /** Average encoding speed below this over `windowMs` means the uplink cannot keep up (1.0 = exactly real time). */
  slowSpeed: number;
  windowMs: number;
  /** A level is only changed this long after the previous change. */
  cooldownMs: number;
  /** First time: this long of a healthy stream before trying a better level again. Doubles each time the better level failed quickly. */
  upAfterMs: number;
  maxUpAfterMs: number;
  /** Unexpected exits within this window count as "the connection is unstable". */
  crashWindowMs: number;
  crashesToDegrade: number;
}

export const DEFAULT_ADAPT: AdaptOptions = { slowSpeed: 0.92, windowMs: 10_000, cooldownMs: 20_000, upAfterMs: 120_000, maxUpAfterMs: 15 * 60_000, crashWindowMs: 90_000, crashesToDegrade: 2 };

export type Decision = 'down' | 'up' | null;

/**
 * Picks the quality like a video player would, but on the sending side: it watches how fast ffmpeg manages to push the stream
 * (`speed` of ffmpeg's progress: 1.0x = real time) and steps down when it falls behind or the connection keeps dropping, and
 * carefully tries a better level again after a long healthy period. Pure (time is passed in), so it is unit-tested.
 */
export class LiveQualityController {
  private idx = 0;
  private samples: { at: number; speed: number }[] = [];
  private crashes: number[] = [];
  private lastChange = -Infinity;
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

  /** A new ffmpeg process started: speed history of the previous one is meaningless. */
  attemptStarted(now: number): void {
    this.samples = [];
    this.healthySince = now;
  }

  observe(speed: number, now: number): Decision {
    if (!Number.isFinite(speed) || speed <= 0) return null;
    this.samples = [...this.samples.filter((s) => now - s.at <= this.opt.windowMs), { at: now, speed }];
    const span = now - (this.samples[0]?.at ?? now);
    const avg = this.samples.reduce((a, s) => a + s.speed, 0) / this.samples.length;
    if (span >= this.opt.windowMs * 0.8 && avg < this.opt.slowSpeed) return this.down(now);
    if (avg >= 0.98 && this.healthySince !== null && now - this.healthySince >= this.upAfter) return this.up(now);
    return null;
  }

  /** ffmpeg exited by itself (not because we changed the level). Repeated drops step the quality down. */
  crashed(now: number): Decision {
    this.crashes = [...this.crashes.filter((t) => now - t <= this.opt.crashWindowMs), now];
    this.healthySince = null;
    if (this.crashes.length >= this.opt.crashesToDegrade) {
      this.crashes = [];
      return this.down(now, true);
    }
    return null;
  }

  private down(now: number, force = false): Decision {
    if (this.idx >= this.ladder.length - 1) return null;
    if (!force && now - this.lastChange < this.opt.cooldownMs) return null;
    // the better level we just left failed soon after we tried it: wait longer before trying again
    if (now - this.lastUpAt < this.upAfter) this.upAfter = Math.min(this.opt.maxUpAfterMs, this.upAfter * 2);
    this.idx++;
    this.lastChange = now;
    this.samples = [];
    this.healthySince = now;
    return 'down';
  }

  private up(now: number): Decision {
    if (this.idx === 0 || now - this.lastChange < this.opt.cooldownMs) return null;
    this.idx--;
    this.lastChange = now;
    this.lastUpAt = now;
    this.samples = [];
    this.healthySince = now;
    return 'up';
  }
}
