import { spawn } from 'node:child_process';
import { Logger } from '@nestjs/common';
import { Writable } from 'node:stream';
import { ChannelRepository } from '../channels/channel.repository';
import { Broadcaster } from '../streaming/broadcaster';
import { HttpListenerSink } from '../streaming/http-listener-sink';
import { drawtextFilter, NowPlayingOverlay } from './now-playing-text';

/** RTMP ingest of a Telegram channel's live stream (the "Stream with..." feature of Telegram voice chats). */
export interface RtmpTarget {
  url: string;
  key: string;
}

export interface TelegramLiveApi {
  /** Starts the channel's live stream (creating it if needed) and returns the RTMP server URL + stream key. */
  openLiveStream(channelId: string, title: string): Promise<RtmpTarget>;
  /** Ends the live stream (voice chat) of the channel. Best effort. */
  closeLiveStream(channelId: string): Promise<void>;
}

export interface PublishHooks {
  /** Called once ffmpeg has really written data to Telegram (not merely started). */
  onActive?: () => void;
  /** Every line ffmpeg printed (warnings/errors), for the log. */
  onLog?: (line: string) => void;
}

/** The process that pushes audio to Telegram. Abstracted so tests never spawn ffmpeg. */
export interface RtmpPublisher {
  /** Runs until the process exits or `signal` aborts. `input` is the MP3 radio stream. */
  publish(target: RtmpTarget, input: (sink: Writable) => () => void, signal: AbortSignal, hooks?: PublishHooks): Promise<{ code: number | null; stderr: string }>;
}

/** Pure: the ffmpeg arguments used to publish MP3 audio (stdin) + a still frame to Telegram over RTMP(S). */
export function buildFfmpegRtmpArgs(target: RtmpTarget, audioBitrateKbps = 128, overlay?: NowPlayingOverlay): string[] {
  const base = target.url.endsWith('/') ? target.url : `${target.url}/`;
  return [
    '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats',
    // ONE realtime clock for both inputs (-re): Telegram drops a connection that is fed faster than real time
    '-re', '-f', 'lavfi', '-i', 'color=c=0x0f1216:s=1280x720:r=25', // Telegram requires a video track: a static dark frame
    '-re', '-thread_queue_size', '1024', '-f', 'mp3', '-i', 'pipe:0',
    '-map', '0:v', '-map', '1:a',
    ...(overlay ? ['-vf', drawtextFilter(overlay)] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-b:v', '600k', '-maxrate', '600k', '-bufsize', '1200k', // keyframe every 2 s, constant rate
    '-c:a', 'aac', '-b:a', `${audioBitrateKbps}k`, '-ar', '48000', '-ac', '2',
    '-max_muxing_queue_size', '1024',
    '-flvflags', 'no_duration_filesize', '-f', 'flv', `${base}${target.key}`,
  ];
}

export class FfmpegRtmpPublisher implements RtmpPublisher {
  /** Set when this ffmpeg build has no `drawtext`: the stream then continues without the text instead of not starting at all. */
  private overlayBroken = false;

  constructor(private readonly ffmpegPath = 'ffmpeg', private readonly bitrateKbps = 128, private readonly overlay?: NowPlayingOverlay) {}

  publish(target: RtmpTarget, input: (sink: Writable) => () => void, signal: AbortSignal, hooks: PublishHooks = {}): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve({ code: null, stderr: '' });
      const proc = spawn(this.ffmpegPath, buildFfmpegRtmpArgs(target, this.bitrateKbps, this.overlayBroken ? undefined : this.overlay), { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr = (stderr + text).slice(-1500);
        for (const line of text.split(/\r?\n/)) if (line.trim()) hooks.onLog?.(line.split(target.key).join('<stream-key>'));
      });
      // `-progress`: `total_size` is the number of bytes written to the output; > 0 means Telegram accepted the connection and the data
      let active = false;
      proc.stdout.on('data', (d: Buffer) => {
        if (active) return;
        const m = /total_size=(\d+)/.exec(d.toString());
        if (m && Number(m[1]) > 0) {
          active = true;
          hooks.onActive?.();
        }
      });
      proc.stdin.on('error', () => undefined); // EPIPE when ffmpeg exits first
      const detach = input(proc.stdin);
      const kill = (): void => {
        proc.kill('SIGKILL');
      };
      signal.addEventListener('abort', kill, { once: true });
      proc.on('error', (err: NodeJS.ErrnoException) => {
        detach();
        reject(new Error(err.code === 'ENOENT' ? `ffmpeg not found at "${this.ffmpegPath}"` : err.message));
      });
      proc.on('close', (code) => {
        if (this.overlay && !this.overlayBroken && /No such filter.*drawtext|drawtext.*(not found|Error initializing)|Cannot find a valid font|Could not load font/i.test(stderr)) {
          this.overlayBroken = true;
          hooks.onLog?.('this ffmpeg cannot draw text (drawtext/font missing): going on without the now-playing text');
        }
        detach();
        signal.removeEventListener('abort', kill);
        resolve({ code, stderr });
      });
    });
  }
}

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
    while (!signal.aborted) {
      const startedAt = Date.now();
      try {
        await this.channels.setLiveStatus(this.channelId, 'STARTING', null);
        const target = await this.api.openLiveStream(this.channelId, this.title);
        if (signal.aborted) return;
        this.logger.log({ msg: 'telegram live: publishing', channelId: this.channelId, server: target.url });
        const attempt = new AbortController();
        const onOuterAbort = (): void => attempt.abort();
        signal.addEventListener('abort', onOuterAbort, { once: true });
        let active = false;
        let hung = false;
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
        };
        const res = await this.publisher.publish(target, (sink) => this.attach(sink), attempt.signal, hooks).finally(() => {
          clearTimeout(watchdog);
          signal.removeEventListener('abort', onOuterAbort);
        });
        if (hung) throw new Error(`ffmpeg connected but Telegram accepted no data within ${Math.round(this.opt.activeTimeoutMs / 1000)} s (RTMPS handshake stuck?) ${res.stderr.trim().split(target.key).join('<stream-key>')}`.trim());
        if (signal.aborted) return;
        throw new Error(`ffmpeg exited (${res.code}) ${res.stderr.trim().split(target.key).join('<stream-key>')}`);
      } catch (err) {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
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
