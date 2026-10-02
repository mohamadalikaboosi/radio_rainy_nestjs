import { RtmpTarget, PublishHooks, RtmpPublisher } from '../application/ports/telegram-live';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { LIVE_LADDER, LiveQuality } from '../domain/live-quality';
import { drawtextFilter, NowPlayingOverlay } from './now-playing-text';

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
