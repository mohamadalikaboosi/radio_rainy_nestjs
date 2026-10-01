import { RtmpTarget, PublishHooks, RtmpPublisher } from '../application/ports/telegram-live';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { drawtextFilter, NowPlayingOverlay } from './now-playing-text';

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
