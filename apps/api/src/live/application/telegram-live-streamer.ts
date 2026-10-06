import { TelegramLiveApi, PublishHooks, RtmpPublisher } from './ports/telegram-live';
import { Logger } from '@nestjs/common';
import { Writable } from 'node:stream';
import { ChannelRepository } from '../../catalog/application/ports/channel.repository';
import { Broadcaster } from '../../radio/domain/broadcaster';
import { HttpListenerSink } from '../../radio/application/http-listener-sink';
import { Decision, LiveQualityController } from '../domain/live-quality';

export interface LiveOptions {
  retryMinMs: number;
  retryMaxMs: number;
  maxBacklogBytes: number;
  /** After this long without a crash the retry delay resets. */
  stableAfterMs: number;
  /** If ffmpeg has not written any data to Telegram this long after starting, the attempt is abandoned with an error (a hung RTMPS handshake never exits by itself). */
  activeTimeoutMs: number;
}

export const DEFAULT_LIVE_OPTIONS: LiveOptions = { retryMinMs: 3000, retryMaxMs: 60_000, maxBacklogBytes: 512 * 1024, stableAfterMs: 60_000, activeTimeoutMs: 30_000 };

/**
 * Mirrors a station's radio stream into the channel's Telegram live stream, so the music also plays inside Telegram.
 * Reconnects with backoff; reports LIVE / ERROR (with the reason) back to the channel row for the admin panel.
 */
export class TelegramLiveStreamer {
  private readonly logger = new Logger(TelegramLiveStreamer.name);
  private ac: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly channelId: string,
    private readonly title: string,
    private readonly broadcaster: Broadcaster,
    private readonly api: TelegramLiveApi,
    private readonly publisher: RtmpPublisher,
    private readonly channels: Pick<ChannelRepository, 'setLiveStatus'>,
    private readonly opt: LiveOptions = DEFAULT_LIVE_OPTIONS,
    private readonly quality = new LiveQualityController(),
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      }),
  ) {}

  get running(): boolean {
    return this.ac !== null;
  }

  start(): void {
    if (this.ac) return;
    this.ac = new AbortController();
    this.loop = this.run(this.ac.signal).catch((err: unknown) => this.logger.error({ msg: 'live loop crashed', channelId: this.channelId, err: String(err) }));
  }

  async stop(closeStream = true): Promise<void> {
    const ac = this.ac;
    if (!ac) return;
    this.ac = null;
    ac.abort();
    await this.loop;
    this.loop = null;
    if (closeStream) await this.api.closeLiveStream(this.channelId).catch((e: unknown) => this.logger.warn({ msg: 'closing live stream failed', channelId: this.channelId, err: String(e) }));
    await this.channels.setLiveStatus(this.channelId, 'OFF', null).catch((e: unknown) => this.logger.warn({ msg: 'live status update failed', err: String(e) }));
  }

  private async run(signal: AbortSignal): Promise<void> {
    let delay = this.opt.retryMinMs;
    let resume = false; // restarting only to change the quality: the status stays LIVE, no back-off
    while (!signal.aborted) {
      const startedAt = Date.now();
      try {
        if (!resume) await this.channels.setLiveStatus(this.channelId, 'STARTING', null);
        resume = false;
        const target = await this.api.openLiveStream(this.channelId, this.title);
        if (signal.aborted) return;
        this.logger.log({ msg: 'telegram live: publishing', channelId: this.channelId, server: target.url });
        const attempt = new AbortController();
        const onOuterAbort = (): void => attempt.abort();
        signal.addEventListener('abort', onOuterAbort, { once: true });
        let active = false;
        let hung = false;
        let adapting: Decision = null;
        let lastSpeedLog = 0;
        const q = this.quality.quality;
        this.quality.attemptStarted(Date.now());
        const watchdog = setTimeout(() => {
          if (active || signal.aborted) return;
          hung = true;
          attempt.abort();
        }, this.opt.activeTimeoutMs);
        const hooks: PublishHooks = {
          onActive: () => {
            if (signal.aborted) return;
            active = true;
            clearTimeout(watchdog);
            this.logger.log({ msg: 'telegram live stream started', channelId: this.channelId });
            void this.channels.setLiveStatus(this.channelId, 'LIVE', null).catch((e: unknown) => this.logger.warn({ msg: 'live status update failed', err: String(e) }));
          },
          onLog: (line) => this.logger.warn({ msg: 'ffmpeg', channelId: this.channelId, line }),
          onSpeed: (speed) => {
            if (Date.now() - lastSpeedLog > 30_000) {
              lastSpeedLog = Date.now();
              this.logger.log({ msg: 'telegram live: encoder speed', channelId: this.channelId, speed, quality: this.quality.quality.name });
            }
            if (adapting || signal.aborted) return;
            const d = this.quality.observe(speed, Date.now());
            if (!d) return;
            adapting = d;
            this.logger.warn({ msg: `telegram live: connection ${d === 'down' ? 'too slow' : 'healthy'}; ${d === 'down' ? 'lowering' : 'raising'} the quality`, channelId: this.channelId, from: q.name, to: this.quality.quality.name, speed });
            attempt.abort();
          },
        };
        this.logger.log({ msg: 'telegram live: quality', channelId: this.channelId, quality: q.name, videoKbps: q.videoKbps, audioKbps: q.audioKbps });
        const res = await this.publisher.publish(target, (sink) => this.attach(sink), attempt.signal, hooks, q).finally(() => {
          clearTimeout(watchdog);
          signal.removeEventListener('abort', onOuterAbort);
        });
        if (adapting && !signal.aborted) {
          resume = true;
          continue;
        }
        if (hung) throw new Error(`ffmpeg connected but Telegram accepted no data within ${Math.round(this.opt.activeTimeoutMs / 1000)} s (RTMPS handshake stuck?) ${res.stderr.trim().split(target.key).join('<stream-key>')}`.trim());
        if (signal.aborted) return;
        throw new Error(`ffmpeg exited (${res.code}) ${res.stderr.trim().split(target.key).join('<stream-key>')}`);
      } catch (err) {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        if (this.quality.crashed(Date.now()) === 'down') this.logger.warn({ msg: 'telegram live: the connection keeps dropping; lowering the quality', channelId: this.channelId, to: this.quality.quality.name });
        this.logger.warn({ msg: 'telegram live stream failed; will retry', channelId: this.channelId, err: message, retryInMs: delay });
        await this.channels.setLiveStatus(this.channelId, 'ERROR', message.slice(0, 1200)).catch((e: unknown) => this.logger.warn({ msg: 'live status update failed', err: String(e) }));
        if (Date.now() - startedAt > this.opt.stableAfterMs) delay = this.opt.retryMinMs;
        await this.sleep(delay, signal);
        delay = Math.min(this.opt.retryMaxMs, delay * 2);
      }
    }
  }

  /** Feeds the radio stream to the publisher. Slow/dead consumers are dropped (never grows memory, never blocks listeners). */
  private attach(sink: Writable): () => void {
    const unsubscribe = this.broadcaster.subscribe(new HttpListenerSink(sink, this.opt.maxBacklogBytes, (reason) => this.logger.warn({ msg: 'live sink dropped', channelId: this.channelId, reason })));
    return unsubscribe;
  }
}
