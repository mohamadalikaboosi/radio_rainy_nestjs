import { Logger } from '@nestjs/common';
import { hasMpegFrameSync } from '../../engagement/domain/mp3-info';
import { StationMetrics } from './radio-metrics';
import { computePosition } from '../domain/playback-position';
import { RadioScheduler } from './radio-scheduler';
import { RadioStateRepository } from './ports/radio-state.repository';
import { Broadcaster } from '../domain/broadcaster';
import { TelegramFloodWaitError, TelegramNotReadyError } from '../../catalog/application/ports/telegram.types';
import { newTimeline, pace, Timeline } from '../domain/pacer';
import { TrackRepository } from '../../catalog/application/ports/track.repository';
import { Track } from '../../catalog/domain/track.types';
import { OpenedAudio, PrefetchedAudio, TrackAudioPipeline } from './audio-pipeline';
import { EndReason, PlaybackHistoryRepository } from './ports/playback-history.repository';

export interface EngineOptions {
  burstSeconds: number;
  sliceBytes: number;
  /** Start selecting/prefetching the next track when this many seconds remain. */
  preselectSeconds: number;
  prefetchBytes: number;
  /** Wait for the whole next track to be downloaded before it goes on air (bounded; a slow download then simply streams while it plays). */
  bufferWholeTrack?: boolean;
  /** How long to wait before re-checking when nothing is playable. */
  idleRetryMs: number;
  maxBackoffMs: number;
  /** How long a transition waits for the pre-fetched track's first bytes before replacing it with another one. */
  prefetchTimeoutMs?: number;
  /** Reject tracks whose first bytes contain no MPEG audio frame (corrupt/garbage downloads) before they go on air. */
  validateAudio?: boolean;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CurrentPlayback {
  track: Track;
  startedAt: Date;
  historyId: string;
  seq: number;
  bytesPerSec: number;
}

export type PlaybackStatus = 'PLAYING' | 'BUFFERING' | 'TRANSITIONING' | 'IDLE' | 'AD' | 'ERROR' | 'STOPPED';

/** Snapshot of the canonical timeline: `position` is derived from `startedAt` and the clock, never counted per listener. */
export interface PlaybackState {
  status: PlaybackStatus;
  trackId: string | null;
  startedAt: number | null;
  duration: number | null;
  position: number;
  /** Seconds of audio already sent beyond real time (how much the listeners' buffers can absorb). */
  bufferedSeconds: number;
  seq: number;
}

export type PlaybackEvent =
  | { type: 'track-started'; trackId: string; seq: number }
  | { type: 'track-ended'; trackId: string; reason: EndReason }
  | { type: 'transition'; gapMs: number; audible: boolean }
  | { type: 'ad-started'; adId: string }
  | { type: 'ad-ended'; adId: string }
  | { type: 'prefetch-failover'; trackId: string; reason: 'FAILED' | 'TIMEOUT' | 'CORRUPT' };
export type PlaybackListener = (event: PlaybackEvent) => void;

export type SkipStatus = 'SKIPPED' | 'ALREADY_SKIPPING' | 'NOT_PLAYING' | 'STALE';

interface Plan {
  track: Track;
  audio: PrefetchedAudio;
  ac: AbortController;
  configVersion: number;
}

export interface PlayableAd {
  id: string;
  name: string;
  open(signal: AbortSignal): OpenedAudio;
}

/** Audio ads played between tracks. Optional: an engine without it never plays ads. */
export interface AdSource {
  /** Play an ad after this many tracks (0 = ads off). */
  everyN(channelId: string): Promise<number>;
  pick(channelId: string): Promise<PlayableAd | null>;
  played(adId: string): Promise<void>;
}

export interface EngineDeps {
  /** Telegram channel id of the station this engine plays. */
  channelId: string;
  scheduler: RadioScheduler;
  state: RadioStateRepository;
  history: PlaybackHistoryRepository;
  tracks: TrackRepository;
  audio: TrackAudioPipeline;
  broadcaster: Broadcaster;
  options: EngineOptions;
  ads?: AdSource;
  metrics?: StationMetrics;
}

/**
 * The single radio "player". Select -> open -> pace -> broadcast -> record, forever.
 * Exactly one engine runs at a time (leader lock); all mutations of "what plays next" go through this
 * class, which serializes them, so skip / play-next can never start two simultaneous transitions.
 */
const MAX_SELECT_ATTEMPTS = 3;
const isOutage = (err: unknown): boolean => err instanceof TelegramNotReadyError || err instanceof TelegramFloodWaitError;

export class PlaybackEngine {
  private readonly logger = new Logger(PlaybackEngine.name);
  private readonly timeline: Timeline;
  private loopPromise: Promise<void> | null = null;
  private stopping = false;
  private wakeResolve: (() => void) | null = null;

  private currentPlayback: CurrentPlayback | null = null;
  private currentAbort: AbortController | null = null;
  private abortReason: EndReason | null = null;
  private forcedTrackId: string | null = null;
  private status: PlaybackStatus = 'STOPPED';
  private readonly listeners = new Set<PlaybackListener>();
  private lastSliceAt: number | null = null;
  private lastAheadMs = 0;
  private adAbort: AbortController | null = null;
  private tracksSinceAd = 0;
  private plan: Plan | null = null;
  private planPromise: Promise<void> | null = null;

  constructor(private readonly d: EngineDeps) {
    this.timeline = newTimeline(d.options.now());
  }

  get current(): CurrentPlayback | null {
    return this.currentPlayback;
  }

  get running(): boolean {
    return this.loopPromise !== null && !this.stopping;
  }

  /** The canonical playback state. Position comes from the server clock and the track's start time. */
  getState(): PlaybackState {
    const cur = this.currentPlayback;
    const now = this.d.options.now();
    const ahead = this.timeline.anchor + this.timeline.sentSeconds * 1000 - now;
    return {
      status: this.status,
      trackId: cur?.track.id ?? null,
      startedAt: cur ? cur.startedAt.getTime() : null,
      duration: cur?.track.duration ?? null,
      position: cur ? computePosition(cur.startedAt, now, cur.track.duration) : 0,
      bufferedSeconds: Math.max(0, ahead / 1000),
      seq: cur?.seq ?? 0,
    };
  }

  /** Observe what the engine does (metrics, logs, live views). Listener errors never affect playback. */
  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: PlaybackEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        this.logger.warn({ msg: 'playback listener failed', err: String(err) });
      }
    }
  }

  /** Every byte on air goes through here: one place tracks the send time and how far ahead of real time the listeners are. */
  private send(slice: Buffer): void {
    const now = this.d.options.now();
    this.lastAheadMs = Math.max(0, this.timeline.anchor + this.timeline.sentSeconds * 1000 - now);
    this.lastSliceAt = now;
    this.d.metrics?.recordBuffer(this.lastAheadMs / 1000);
    this.d.broadcaster.push(slice);
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.status = 'TRANSITIONING';
    this.loopPromise = this.loop().catch((err: unknown) => this.logger.error({ msg: 'playback loop crashed', err: String(err) }));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abortCurrent('SHUTDOWN');
    this.wake();
    await this.loopPromise;
    this.loopPromise = null;
    await this.discardPlan();
    this.status = 'STOPPED';
    this.d.broadcaster.endAll();
  }

  wake(): void {
    this.wakeResolve?.();
  }

  /** Idempotent: repeated calls during one transition collapse into one. `expectedSeq` guards against stale UI clicks. */
  skip(expectedSeq?: number): SkipStatus {
    if (this.adAbort && !this.adAbort.signal.aborted) {
      this.adAbort.abort();
      return 'SKIPPED';
    }
    const cur = this.currentPlayback;
    if (!cur || !this.currentAbort) return 'NOT_PLAYING';
    if (expectedSeq !== undefined && expectedSeq !== cur.seq) return 'STALE';
    if (this.currentAbort.signal.aborted) return 'ALREADY_SKIPPING';
    this.abortCurrent('SKIPPED');
    return 'SKIPPED';
  }

  /** Plays `trackId` next (and cuts the current track). Without an id it is a skip that respects the radio configuration. */
  playNext(trackId?: string): SkipStatus {
    if (trackId) this.forcedTrackId = trackId;
    if (this.adAbort && !this.adAbort.signal.aborted) {
      this.adAbort.abort();
      return 'SKIPPED';
    }
    if (!this.currentAbort) {
      this.wake();
      return 'NOT_PLAYING';
    }
    if (this.currentAbort.signal.aborted) return 'ALREADY_SKIPPING';
    this.abortCurrent('ADMIN');
    return 'SKIPPED';
  }

  /** Plays `trackId` right after the current track ends (no cut). Replaces any earlier queued/preselected next track. */
  queueNext(trackId: string): void {
    this.forcedTrackId = trackId;
    void this.discardPlan().then(() => this.d.state.setNext(this.d.channelId, trackId)).catch((e: unknown) => this.logger.warn({ msg: 'queue-next bookkeeping failed', err: String(e) }));
  }

  /** Configuration changed: any preselected "next" track may no longer be eligible. */
  invalidatePlan(): void {
    void this.discardPlan();
    this.wake();
  }

  private abortCurrent(reason: EndReason): void {
    this.adAbort?.abort();
    if (this.currentAbort && !this.currentAbort.signal.aborted) {
      this.abortReason = reason;
      this.currentAbort.abort();
    }
  }

  // ---- main loop ----

  private async loop(): Promise<void> {
    const o = this.d.options;
    let failures = 0;
    while (!this.stopping) {
      await this.maybePlayAd();
      if (this.stopping) break;
      const plan = await this.takeNext();
      if (!plan) continue;
      const outcome = await this.playOne(plan);
      if (outcome === 'OUTAGE') {
        // Telegram itself is unavailable (not logged in / flood wait): not the tracks' fault, so don't penalize them.
        await this.d.state.setStatus(this.d.channelId, 'ERROR', 'Telegram unavailable');
        failures = Math.min(failures + 1, 6);
        await this.idle(Math.min(o.maxBackoffMs, 1000 * 2 ** failures));
      } else if (outcome === 'ERROR') {
        failures++;
        if (failures >= 3) await this.d.state.setStatus(this.d.channelId, 'ERROR', 'Repeated playback failures (Telegram unreachable?)');
        await this.idle(Math.min(o.maxBackoffMs, 250 * 2 ** failures));
      } else if (outcome === 'OK') {
        failures = 0;
      }
    }
  }

  /** Between two tracks: plays an ad when `everyN` tracks have been played since the last one. Never blocks the radio on failure. */
  private async maybePlayAd(): Promise<void> {
    const ads = this.d.ads;
    if (!ads || this.tracksSinceAd === 0) return;
    let ad: PlayableAd | null = null;
    try {
      const every = await ads.everyN(this.d.channelId);
      if (every <= 0 || this.tracksSinceAd < every) return;
      ad = await ads.pick(this.d.channelId);
    } catch (err) {
      this.logger.warn({ msg: 'ad selection failed; continuing with music', err: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.tracksSinceAd = 0; // even without an ad: don't re-check after every single track
    if (!ad) return;
    await this.playAd(ad, ads);
  }

  private async playAd(ad: PlayableAd, ads: AdSource): Promise<void> {
    const o = this.d.options;
    const ac = new AbortController();
    this.adAbort = ac;
    const startSent = this.timeline.sentSeconds;
    let started = false;
    let audio: PrefetchedAudio | null = null;
    try {
      audio = new PrefetchedAudio(ad.open(ac.signal), o.prefetchBytes);
      for await (const slice of pace(audio.bytes, { bytesPerSec: audio.bytesPerSec, burstSeconds: o.burstSeconds, sliceBytes: o.sliceBytes, now: o.now, sleep: o.sleep, signal: ac.signal, timeline: this.timeline, ...this.paceHooks() })) {
        if (!started) {
          started = true;
          await this.d.state.setAd(this.d.channelId, ad.id, new Date(this.timeline.anchor + startSent * 1000));
          this.status = 'AD';
          this.emit({ type: 'ad-started', adId: ad.id });
          this.logger.log({ msg: 'ad started', channelId: this.d.channelId, adId: ad.id, name: ad.name, listeners: this.d.broadcaster.listenerCount });
        }
        this.send(slice);
      }
    } catch (err) {
      this.logger.warn({ msg: 'ad playback failed; continuing with music', adId: ad.id, err: err instanceof Error ? err.message : String(err) });
    } finally {
      this.adAbort = null;
      await audio?.cancel().catch((e: unknown) => this.logger.warn({ msg: 'ad cancel failed', err: String(e) }));
      if (started) {
        this.status = 'TRANSITIONING';
        await this.d.state.setAd(this.d.channelId, null, null).catch((e: unknown) => this.logger.warn({ msg: 'clear ad failed', err: String(e) }));
        this.emit({ type: 'ad-ended', adId: ad.id }); // after the state row is cleared: subscribers read it
        await ads.played(ad.id).catch((e: unknown) => this.logger.warn({ msg: 'ad play count failed', err: String(e) }));
      }
    }
  }

  private paceHooks(): { onUnderrun: () => void; onSourceRead: (bytes: number, ms: number) => void } {
    return {
      onUnderrun: () => {
        this.d.metrics?.recordUnderrun();
        this.status = 'BUFFERING';
        this.logger.warn({ msg: 'buffer underrun: the audio source could not keep up', channelId: this.d.channelId });
      },
      onSourceRead: (bytes, ms) => this.d.metrics?.recordDownload(bytes, ms),
    };
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        this.wakeResolve = null;
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakeResolve = done;
    });
  }

  /** Returns the plan to play, or null after idling (nothing playable). */
  private async takeNext(): Promise<Plan | null> {
    try {
      if (this.planPromise) await this.planPromise;
      const forced = this.forcedTrackId;
      this.forcedTrackId = null;
      if (forced) {
        await this.discardPlan();
        const p = await this.prepare(forced, (await this.d.state.get(this.d.channelId)).configurationVersion);
        if (p) return p;
      }
      const exclude: string[] = [];
      if (this.plan) {
        const version = (await this.d.state.get(this.d.channelId)).configurationVersion;
        // The preselected track may have been disabled/removed since it was chosen.
        const fresh = await this.d.tracks.findById(this.plan.track.id);
        const stillPlayable = fresh !== null && fresh.status === 'READY' && fresh.enabled;
        if (this.plan.configVersion === version && stillPlayable) {
          const p = this.plan;
          this.plan = null;
          await this.d.state.setNext(this.d.channelId, null);
          const bad = await this.verify(p, 0); // already waited for in the background; never wait again while the radio is silent
          if (bad === null || (bad === 'FAILED' && isOutage(p.audio.failure))) return p; // an outage is handled (with back-off) by playOne
          await this.rejectPlan(p, bad);
          exclude.push(p.track.id);
        } else {
          await this.discardPlan();
        }
      }
      // Never block the radio on one broken track: try a few others right away.
      for (let attempt = 0; attempt < MAX_SELECT_ATTEMPTS; attempt++) {
        const sel = await this.d.scheduler.selectNext(this.d.channelId, exclude);
        if (!sel.trackId) {
          await this.d.state.setStatus(this.d.channelId, sel.reason === 'RADIO_DISABLED' ? 'STOPPED' : 'IDLE', sel.reason);
          this.status = sel.reason === 'RADIO_DISABLED' ? 'STOPPED' : 'IDLE';
          this.logger.warn({ msg: 'nothing to play', reason: sel.reason });
          await this.idle(this.d.options.idleRetryMs);
          return null;
        }
        const p = await this.prepare(sel.trackId, sel.configVersion);
        if (!p) {
          exclude.push(sel.trackId);
          continue;
        }
        const bad = await this.verify(p);
        if (bad === null || (bad === 'FAILED' && isOutage(p.audio.failure))) return p;
        await this.rejectPlan(p, bad);
        exclude.push(sel.trackId);
      }
      await this.idle(50);
      return null;
    } catch (err) {
      this.logger.error({ msg: 'failed to pick next track', err: err instanceof Error ? err.message : String(err) });
      await this.idle(Math.min(this.d.options.maxBackoffMs, 1000));
      return null;
    }
  }

  /** Opens the audio and starts a bounded read-ahead. */
  private async prepare(trackId: string, configVersion: number): Promise<Plan | null> {
    const track = await this.d.tracks.findById(trackId);
    if (!track || track.status !== 'READY' || !track.enabled) {
      this.logger.warn({ msg: 'selected track not playable', trackId });
      return null;
    }
    const ac = new AbortController();
    const audio = new PrefetchedAudio(this.d.audio.open(track, ac.signal), this.d.options.prefetchBytes);
    void audio.start();
    return { track, audio, ac, configVersion };
  }

  private async discardPlan(): Promise<void> {
    if (this.planPromise) await this.planPromise;
    const p = this.plan;
    this.plan = null;
    if (!p) return;
    p.ac.abort();
    await p.audio.cancel().catch((e: unknown) => this.logger.warn({ msg: 'plan cancel failed', err: String(e) }));
    await this.d.state.setNext(this.d.channelId, null).catch((e: unknown) => this.logger.warn({ msg: 'clear next failed', err: String(e) }));
  }

  /** @param remainingSeconds how long the current track still plays: the whole next track may take that long to download. */
  private planNext(remainingSeconds = 0): void {
    if (this.plan || this.planPromise || this.forcedTrackId) return;
    this.planPromise = (async () => {
      try {
        const exclude: string[] = [];
        for (let attempt = 0; attempt < MAX_SELECT_ATTEMPTS; attempt++) {
          const sel = await this.d.scheduler.selectNext(this.d.channelId, exclude);
          if (!sel.trackId) return;
          const p = await this.prepare(sel.trackId, sel.configVersion);
          if (!p) {
            exclude.push(sel.trackId);
            continue;
          }
          if (this.stopping) {
            p.ac.abort();
            await p.audio.cancel();
            return;
          }
          // The next track must be READY (first bytes in hand) before the current one ends; if it cannot be, pick another now.
          const bad = await this.verify(p, Math.max(0, remainingSeconds - 3) * 1000);
          if (bad === null) {
            this.plan = p;
            await this.d.state.setNext(this.d.channelId, p.track.id);
            return;
          }
          if (bad === 'FAILED' && isOutage(p.audio.failure)) {
            p.ac.abort();
            await p.audio.cancel().catch(() => undefined);
            return; // Telegram itself is down: the transition (and its back-off) deals with it
          }
          await this.rejectPlan(p, bad);
          exclude.push(sel.trackId);
        }
      } catch (err) {
        this.logger.warn({ msg: 'preselect failed; will select at transition', err: err instanceof Error ? err.message : String(err) });
      } finally {
        this.planPromise = null;
      }
    })();
  }

  /**
   * Waits (bounded) for a prepared track's first bytes and sanity-checks them. Returns why it is unusable, or null.
   * With `bufferWholeTrack` it then also waits up to `fullWaitMs` for the COMPLETE download; running out of that time is not a failure
   * (the track keeps downloading while it plays), so a slow Telegram can never leave the radio silent.
   */
  private async verify(p: Plan, fullWaitMs?: number): Promise<'FAILED' | 'TIMEOUT' | 'CORRUPT' | null> {
    const whole = this.d.options.bufferWholeTrack === true;
    const timeout = this.d.options.prefetchTimeoutMs ?? 15_000;
    const ready = whole ? await p.audio.whenHead(timeout) : await p.audio.whenReady(timeout);
    if (ready !== 'READY') return ready;
    if (this.d.options.validateAudio) {
      const head = p.audio.head(64 * 1024);
      if (head.length > 0 && !hasMpegFrameSync(head)) return 'CORRUPT';
    }
    if (whole) {
      const full = await p.audio.whenReady(fullWaitMs ?? timeout);
      if (full === 'FAILED') return 'FAILED';
    }
    return null;
  }

  /** Throws a prepared track away. Broken audio counts against the track (it is disabled after repeated failures); a slow one does not. */
  private async rejectPlan(p: Plan, reason: 'FAILED' | 'TIMEOUT' | 'CORRUPT'): Promise<void> {
    this.d.metrics?.recordFailover();
    if (reason === 'FAILED') this.d.metrics?.recordDownloadFailure();
    this.logger.warn({ msg: 'prepared track rejected; choosing another', channelId: this.d.channelId, trackId: p.track.id, title: p.track.title, reason, err: reason === 'FAILED' ? String(p.audio.failure) : undefined });
    this.emit({ type: 'prefetch-failover', trackId: p.track.id, reason });
    p.ac.abort();
    await p.audio.cancel().catch((e: unknown) => this.logger.warn({ msg: 'rejected plan cancel failed', err: String(e) }));
    if (reason !== 'TIMEOUT') await this.d.tracks.recordPlaybackResult(p.track.id, false).catch((e: unknown) => this.logger.error({ msg: 'record result failed', err: String(e) }));
  }

  private async playOne(plan: Plan): Promise<'OK' | 'ERROR' | 'OUTAGE' | 'ABORTED'> {
    const { track, audio, ac } = plan;
    const o = this.d.options;
    this.currentAbort = ac;
    this.abortReason = null;
    const startSent = this.timeline.sentSeconds;
    let historyId: string | null = null;
    let reason: EndReason = 'FINISHED';
    let failed = false;
    let outage = false;
    let bytes = 0;
    try {
      for await (const slice of pace(audio.bytes, {
        bytesPerSec: audio.bytesPerSec,
        burstSeconds: o.burstSeconds,
        sliceBytes: o.sliceBytes,
        now: o.now,
        sleep: o.sleep,
        signal: ac.signal,
        timeline: this.timeline,
        ...this.paceHooks(),
      })) {
        if (historyId === null) {
          const gapMs = this.lastSliceAt === null ? null : this.d.options.now() - this.lastSliceAt;
          if (gapMs !== null) {
            const audible = gapMs > this.lastAheadMs;
            this.d.metrics?.recordTransition(gapMs, audible);
            this.emit({ type: 'transition', gapMs, audible });
            if (audible) this.logger.warn({ msg: 'audible gap between tracks', channelId: this.d.channelId, gapMs, coveredMs: Math.round(this.lastAheadMs) });
          }
          const startedAt = new Date(this.timeline.anchor + startSent * 1000);
          historyId = await this.d.history.start(track.id, startedAt);
          const seq = await this.d.state.beginTrack(this.d.channelId, track.id, historyId, startedAt);
          this.currentPlayback = { track, startedAt, historyId, seq, bytesPerSec: audio.bytesPerSec };
          this.tracksSinceAd++;
          this.emit({ type: 'track-started', trackId: track.id, seq });
          this.logger.log({ msg: 'playback started', channelId: this.d.channelId, trackId: track.id, title: track.title, artist: track.artist, seq, listeners: this.d.broadcaster.listenerCount });
        }
        bytes += slice.length;
        this.status = 'PLAYING';
        this.send(slice);
        if (track.duration !== null && this.timeline.sentSeconds - startSent >= track.duration - o.preselectSeconds) this.planNext(Math.max(0, track.duration - (this.timeline.sentSeconds - startSent)));
      }
      if (ac.signal.aborted) reason = this.abortReason ?? 'ADMIN';
      else if (bytes === 0) throw new Error('track produced no audio data');
    } catch (err) {
      failed = true;
      outage = isOutage(err);
      reason = 'ERROR';
      this.d.metrics?.recordDownloadFailure();
      if (historyId === null) this.d.metrics?.recordTransitionFailure();
      this.status = outage ? 'ERROR' : 'TRANSITIONING';
      this.logger.error({ msg: outage ? 'telegram unavailable, cannot stream' : 'streaming error, skipping track', trackId: track.id, title: track.title, bytes, err: err instanceof Error ? err.message : String(err) });
    } finally {
      this.currentAbort = null;
      await audio.cancel().catch((e: unknown) => this.logger.warn({ msg: 'audio cancel failed', err: String(e) }));
      if (historyId) await this.d.history.end(historyId, reason).catch((e: unknown) => this.logger.error({ msg: 'history end failed', err: String(e) }));
    }
    if (!outage) await this.d.tracks.recordPlaybackResult(track.id, !failed).catch((e: unknown) => this.logger.error({ msg: 'record result failed', err: String(e) }));
    this.logger.log({ msg: 'playback ended', trackId: track.id, reason, bytes });
    if (historyId) this.emit({ type: 'track-ended', trackId: track.id, reason });
    if (this.status === 'PLAYING' || this.status === 'BUFFERING') this.status = 'TRANSITIONING';
    if (outage) return 'OUTAGE';
    return failed ? 'ERROR' : reason === 'FINISHED' ? 'OK' : 'ABORTED';
  }
}
