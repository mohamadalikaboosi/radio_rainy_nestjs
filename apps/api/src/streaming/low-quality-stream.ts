import { Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { Broadcaster, ListenerSink } from './broadcaster';

export interface LowQualityOptions {
  ffmpegPath: string;
  /** Bitrate of the data-saver stream (mono). */
  bitrateKbps: number;
  /** Seconds of audio kept for an instant start of a new low-quality listener. */
  prebufferSeconds: number;
  /** If ffmpeg's input queue grows beyond this it is restarted instead of letting memory grow. */
  maxBacklogBytes: number;
  restartMinMs: number;
  restartMaxMs: number;
  /** After ffmpeg could not be started at all, listeners are served the normal stream for this long. */
  brokenForMs: number;
}

export const DEFAULT_LOW: LowQualityOptions = { ffmpegPath: 'ffmpeg', bitrateKbps: 48, prebufferSeconds: 2, maxBacklogBytes: 512 * 1024, restartMinMs: 500, restartMaxMs: 10_000, brokenForMs: 60_000 };

/** The ffmpeg arguments of the data-saver encoder (pure, so it is unit-tested). Mono, 24 kHz up to 64 kbps. */
export function lowQualityArgs(bitrateKbps: number): string[] {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
    '-f', 'mp3', '-i', 'pipe:0',
    '-vn', '-map_metadata', '-1',
    '-c:a', 'libmp3lame', '-b:a', `${bitrateKbps}k`, '-ar', bitrateKbps <= 64 ? '24000' : '44100', '-ac', '1',
    '-flush_packets', '1', '-f', 'mp3', 'pipe:1',
  ];
}

type Spawn = (cmd: string, args: string[]) => ChildProcess;

/**
 * A second, lighter MP3 stream of one station for slow connections ("data saver").
 * It is ONE ffmpeg process per station (never per listener) that re-encodes the station's normal stream, shared by every low-quality
 * listener. It only runs while somebody listens: the first low listener starts it, the last one stops it. If ffmpeg is missing or keeps
 * failing, `available` turns false for a while and the controller serves the normal stream instead, so nobody is left without audio.
 */
export class LowQualityStream {
  private readonly logger = new Logger(LowQualityStream.name);
  readonly broadcaster: Broadcaster;
  private proc: ChildProcess | null = null;
  private unsubscribeMain: (() => void) | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelay: number;
  private brokenUntil = 0;
  private shuttingDown = false;

  constructor(
    private readonly main: Broadcaster,
    private readonly opt: LowQualityOptions = DEFAULT_LOW,
    private readonly spawnFn: Spawn = (c, a) => spawn(c, a, { stdio: ['pipe', 'pipe', 'pipe'] }),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.broadcaster = new Broadcaster(Math.round(((opt.bitrateKbps * 1000) / 8) * opt.prebufferSeconds));
    this.restartDelay = opt.restartMinMs;
  }

  get listenerCount(): number {
    return this.broadcaster.listenerCount;
  }

  /** false while ffmpeg cannot be used (the caller then serves the normal stream). */
  get available(): boolean {
    return this.now() >= this.brokenUntil;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** Same contract as Broadcaster.subscribe; starts the encoder with the first listener and stops it with the last. */
  subscribe(sink: ListenerSink): () => void {
    const off = this.broadcaster.subscribe(sink);
    if (this.broadcaster.listenerCount === 1) this.start();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      if (this.broadcaster.listenerCount === 0) this.stop();
    };
  }

  /** Station stopped: end every low listener and release ffmpeg. */
  shutdown(): void {
    this.shuttingDown = true;
    this.stop();
    this.broadcaster.endAll();
  }

  private start(): void {
    if (this.proc || this.shuttingDown) return;
    let proc: ChildProcess;
    try {
      proc = this.spawnFn(this.opt.ffmpegPath, lowQualityArgs(this.opt.bitrateKbps));
    } catch (err) {
      this.broken(err);
      return;
    }
    this.proc = proc;
    const startedAt = this.now();
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-500);
    });
    proc.stdin?.on('error', () => undefined); // EPIPE when ffmpeg exits first
    proc.stdout?.on('data', (chunk: Buffer) => this.broadcaster.push(chunk));
    proc.on('error', (err) => {
      if (this.proc === proc) this.proc = null;
      this.detachMain();
      this.broken(err);
    });
    proc.on('close', (code) => {
      if (this.proc !== proc) return; // stopped on purpose
      this.proc = null;
      this.detachMain();
      if (this.broadcaster.listenerCount === 0 || this.shuttingDown) return;
      this.logger.warn({ msg: 'low-quality encoder exited; restarting', code, stderr: stderr.trim() });
      // a long healthy run resets the back-off
      if (this.now() - startedAt > 30_000) this.restartDelay = this.opt.restartMinMs;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.broadcaster.listenerCount > 0) this.start();
      }, this.restartDelay);
      this.restartDelay = Math.min(this.opt.restartMaxMs, this.restartDelay * 2);
    });

    const stdin = proc.stdin;
    this.unsubscribeMain = this.main.subscribe({
      write: (chunk) => {
        if (!stdin || stdin.destroyed) return;
        if (stdin.writableLength > this.opt.maxBacklogBytes) {
          this.logger.warn({ msg: 'low-quality encoder cannot keep up; restarting it' });
          proc.kill('SIGKILL');
          return;
        }
        stdin.write(chunk);
      },
      end: () => stdin?.end(),
    });
  }

  private stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.detachMain();
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.stdin?.end();
      } catch {
        /* already closed */
      }
      proc.kill('SIGKILL');
    }
    this.restartDelay = this.opt.restartMinMs;
  }

  private detachMain(): void {
    this.unsubscribeMain?.();
    this.unsubscribeMain = null;
  }

  /** ffmpeg could not run: the low listeners are released (their player reconnects to the normal stream). */
  private broken(err: unknown): void {
    this.brokenUntil = this.now() + this.opt.brokenForMs;
    this.logger.error({ msg: 'low-quality encoder unavailable; serving the normal stream instead', err: err instanceof Error ? err.message : String(err) });
    this.broadcaster.endAll();
  }
}
