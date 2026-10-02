import { spawn } from 'node:child_process';
import { Logger } from '@nestjs/common';
import { Writable } from 'node:stream';
import { ChannelRepository } from '../channels/channel.repository';
import { Broadcaster } from '../streaming/broadcaster';
import { HttpListenerSink } from '../streaming/http-listener-sink';
import { Decision, LiveQuality, LiveQualityController, LIVE_LADDER } from './live-quality';
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
  /** ffmpeg's encoding speed (1.0 = exactly real time); well below 1 means the uplink cannot keep up. */
  onSpeed?: (speed: number) => void;
}

/** The process that pushes audio to Telegram. Abstracted so tests never spawn ffmpeg. */
export interface RtmpPublisher {
  /** Runs until the process exits or `signal` aborts. `input` is the MP3 radio stream. */
  publish(target: RtmpTarget, input: (sink: Writable) => () => void, signal: AbortSignal, hooks?: PublishHooks, quality?: LiveQuality): Promise<{ code: number | null; stderr: string }>;
}

/**
 * Pure: the ffmpeg arguments used to publish MP3 audio (stdin) + a picture to Telegram over RTMP(S).
 * `slideFile` is a PNG that ffmpeg re-reads for every frame (so the picture can change without a restart); without it a dark frame is generated.
 */
export function buildFfmpegRtmpArgs(target: RtmpTarget, quality: LiveQuality = LIVE_LADDER[0] as LiveQuality, overlay?: NowPlayingOverlay, slideFile?: string): string[] {
  const base = target.url.endsWith('/') ? target.url : `${target.url}/`;
  const q = quality;
  const inFps = Math.min(q.fps, 5); // a still picture: decoding it 5 times a second is plenty, `fps=` fills the rest
  const filters = [`scale=${q.width}:${q.height}`, `fps=${q.fps}`, ...(overlay ? [drawtextFilter(overlay, q.height / 720)] : [])].join(',');
  return [
    '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats',
    // ONE realtime clock for both inputs (-re): Telegram drops a connection that is fed faster than real time
    ...(slideFile ? ['-re', '-f', 'image2', '-loop', '1', '-framerate', String(inFps), '-i', slideFile] : ['-re', '-f', 'lavfi', '-i', `color=c=0x0f1216:s=1280x720:r=${inFps}`]), // Telegram requires a video track
    '-re', '-thread_queue_size', '1024', '-f', 'mp3', '-i', 'pipe:0',
    '-map', '0:v', '-map', '1:a',
    '-vf', filters,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-g', String(q.fps * 2), '-keyint_min', String(q.fps * 2), '-sc_threshold', '0', '-b:v', `${q.videoKbps}k`, '-maxrate', `${q.videoKbps}k`, '-bufsize', `${q.videoKbps * 2}k`, // keyframe every 2 s, constant rate
    '-c:a', 'aac', '-b:a', `${q.audioKbps}k`, '-ar', '48000', '-ac', '2',
    '-max_muxing_queue_size', '1024',
    '-flvflags', 'no_duration_filesize', '-f', 'flv', `${base}${target.key}`,
  ];
}

export class FfmpegRtmpPublisher implements RtmpPublisher {
  /** Set when this ffmpeg build has no `drawtext`: the stream then continues without the text instead of not starting at all. */
  private overlayBroken = false;

  constructor(private readonly ffmpegPath = 'ffmpeg', private readonly overlay?: NowPlayingOverlay, private readonly slideFile?: string) {}

  publish(target: RtmpTarget, input: (sink: Writable) => () => void, signal: AbortSignal, hooks: PublishHooks = {}, quality: LiveQuality = LIVE_LADDER[0] as LiveQuality): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve({ code: null, stderr: '' });
      const proc = spawn(this.ffmpegPath, buildFfmpegRtmpArgs(target, quality, this.overlayBroken ? undefined : this.overlay, this.slideFile), { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr = (stderr + text).slice(-1500);
        for (const line of text.split(/\r?\n/)) if (line.trim()) hooks.onLog?.(line.split(target.key).join('<stream-key>'));
      });
      // `-progress`: `total_size` is the number of bytes written to the output; > 0 means Telegram accepted the connection and the data
      let active = false;
      let pending = '';
      proc.stdout.on('data', (d: Buffer) => {
        pending += d.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!active) {
            const m = /^total_size=(\d+)/.exec(line);
            if (m && Number(m[1]) > 0) {
              active = true;
              hooks.onActive?.();
            }
          }
          const sp = /^speed=\s*([\d.]+)x/.exec(line);
          if (sp && active) hooks.onSpeed?.(Number(sp[1]));
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
