import { Logger } from '@nestjs/common';
import { RadioScheduler } from '../radio/radio-scheduler';
import { RadioStateRepository } from '../radio/radio-state.repository';
import { Broadcaster } from '../streaming/broadcaster';
import { newTimeline, pace, Timeline } from '../streaming/pacer';
import { TrackRepository } from '../track/track.repository';
import { Track } from '../track/track.types';
import { PrefetchedAudio, TrackAudioPipeline } from './audio-pipeline';
import { EndReason, PlaybackHistoryRepository } from './playback-history.repository';

export interface EngineOptions {
  burstSeconds: number;
  sliceBytes: number;
  /** Start selecting/prefetching the next track when this many seconds remain. */
  preselectSeconds: number;
  prefetchBytes: number;
  /** How long to wait before re-checking when nothing is playable. */
  idleRetryMs: number;
  maxBackoffMs: number;
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

export type SkipStatus = 'SKIPPED' | 'ALREADY_SKIPPING' | 'NOT_PLAYING' | 'STALE';

interface Plan {
  track: Track;
  audio: PrefetchedAudio;
  ac: AbortController;
  configVersion: number;
}

export interface EngineDeps {
  scheduler: RadioScheduler;
  state: RadioStateRepository;
  history: PlaybackHistoryRepository;
  tracks: TrackRepository;
  audio: TrackAudioPipeline;
  broadcaster: Broadcaster;
  options: EngineOptions;
}

/**
 * The single radio "player". Select -> open -> pace -> broadcast -> record, forever.
 * Exactly one engine runs at a time (leader lock); all mutations of "what plays next" go through this
 * class, which serializes them, so skip / play-next can never start two simultaneous transitions.
 */
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

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopPromise = this.loop().catch((err: unknown) => this.logger.error({ msg: 'playback loop crashed', err: String(err) }));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abortCurrent('SHUTDOWN');
    this.wake();
    await this.loopPromise;
    this.loopPromise = null;
    await this.discardPlan();
    this.d.broadcaster.endAll();
  }

  wake(): void {
    this.wakeResolve?.();
  }

  /** Idempotent: repeated calls during one transition collapse into one. `expectedSeq` guards against stale UI clicks. */
  skip(expectedSeq?: number): SkipStatus {
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
    if (!this.currentAbort) {
      this.wake();
      return 'NOT_PLAYING';
    }
    if (this.currentAbort.signal.aborted) return 'ALREADY_SKIPPING';
    this.abortCurrent('ADMIN');
    return 'SKIPPED';
  }

  /** Configuration changed: any preselected "next" track may no longer be eligible. */
  invalidatePlan(): void {
    void this.discardPlan();
    this.wake();
  }

  private abortCurrent(reason: EndReason): void {
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
      const plan = await this.takeNext();
      if (!plan) continue;
      const outcome = await this.playOne(plan);
      if (outcome === 'ERROR') {
        failures++;
        if (failures >= 3) await this.d.state.setStatus('ERROR', 'Repeated playback failures (Telegram unreachable?)');
        await this.idle(Math.min(o.maxBackoffMs, 250 * 2 ** failures));
      } else if (outcome === 'OK') {
        failures = 0;
      }
    }
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
        const p = await this.prepare(forced, (await this.d.state.get()).configurationVersion);
        if (p) return p;
      }
      if (this.plan) {
        const version = (await this.d.state.get()).configurationVersion;
        if (this.plan.configVersion === version) {
          const p = this.plan;
          this.plan = null;
          await this.d.state.setNext(null);
          return p;
        }
        await this.discardPlan();
      }
      const sel = await this.d.scheduler.selectNext();
      if (!sel.trackId) {
        await this.d.state.setStatus(sel.reason === 'RADIO_DISABLED' ? 'STOPPED' : 'IDLE', sel.reason);
        this.logger.warn({ msg: 'nothing to play', reason: sel.reason });
        await this.idle(this.d.options.idleRetryMs);
        return null;
      }
      const p = await this.prepare(sel.trackId, sel.configVersion);
      if (!p) await this.idle(50);
      return p;
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
    await this.d.state.setNext(null).catch((e: unknown) => this.logger.warn({ msg: 'clear next failed', err: String(e) }));
  }

  private planNext(): void {
    if (this.plan || this.planPromise) return;
    this.planPromise = (async () => {
      try {
        const sel = await this.d.scheduler.selectNext();
        if (!sel.trackId) return;
        const p = await this.prepare(sel.trackId, sel.configVersion);
        if (!p) return;
        if (this.stopping) {
          p.ac.abort();
          await p.audio.cancel();
          return;
        }
        this.plan = p;
        await this.d.state.setNext(p.track.id);
      } catch (err) {
        this.logger.warn({ msg: 'preselect failed; will select at transition', err: err instanceof Error ? err.message : String(err) });
      } finally {
        this.planPromise = null;
      }
    })();
  }

  private async playOne(plan: Plan): Promise<'OK' | 'ERROR' | 'ABORTED'> {
    const { track, audio, ac } = plan;
    const o = this.d.options;
    this.currentAbort = ac;
    this.abortReason = null;
    const startSent = this.timeline.sentSeconds;
    let historyId: string | null = null;
    let reason: EndReason = 'FINISHED';
    let failed = false;
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
      })) {
        if (historyId === null) {
          const startedAt = new Date(this.timeline.anchor + startSent * 1000);
          historyId = await this.d.history.start(track.id, startedAt);
          const seq = await this.d.state.beginTrack(track.id, historyId, startedAt);
          this.currentPlayback = { track, startedAt, historyId, seq, bytesPerSec: audio.bytesPerSec };
          this.logger.log({ msg: 'playback started', trackId: track.id, title: track.title, artist: track.artist, seq, listeners: this.d.broadcaster.listenerCount });
        }
        bytes += slice.length;
        this.d.broadcaster.push(slice);
        if (track.duration !== null && this.timeline.sentSeconds - startSent >= track.duration - o.preselectSeconds) this.planNext();
      }
      if (ac.signal.aborted) reason = this.abortReason ?? 'ADMIN';
      else if (bytes === 0) throw new Error('track produced no audio data');
    } catch (err) {
      failed = true;
      reason = 'ERROR';
      this.logger.error({ msg: 'streaming error, skipping track', trackId: track.id, title: track.title, bytes, err: err instanceof Error ? err.message : String(err) });
    } finally {
      this.currentAbort = null;
      await audio.cancel().catch((e: unknown) => this.logger.warn({ msg: 'audio cancel failed', err: String(e) }));
      if (historyId) await this.d.history.end(historyId, reason).catch((e: unknown) => this.logger.error({ msg: 'history end failed', err: String(e) }));
    }
    await this.d.tracks.recordPlaybackResult(track.id, !failed).catch((e: unknown) => this.logger.error({ msg: 'record result failed', err: String(e) }));
    this.logger.log({ msg: 'playback ended', trackId: track.id, reason, bytes });
    return failed ? 'ERROR' : reason === 'FINISHED' ? 'OK' : 'ABORTED';
  }
}
