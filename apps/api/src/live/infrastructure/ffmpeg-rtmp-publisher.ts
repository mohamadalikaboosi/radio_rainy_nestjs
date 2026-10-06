import { RtmpTarget, PublishHooks, RtmpPublisher } from '../application/ports/telegram-live';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { LIVE_LADDER, LiveQuality } from '../domain/live-quality';
import { lowerPriority } from '../../shared/infrastructure/process-priority';

/**
 * Pure: the ffmpeg arguments used to publish MP3 audio (stdin) + a picture to Telegram over RTMP(S).
 * Best practice for an audio radio on a video platform: the video is ONE still PNG (`slideFile`, re-read for every frame so the picture can
 * change without a restart) at a few frames per second, so the encoder costs almost no CPU and the bitrate is all audio.
 */
export function buildFfmpegRtmpArgs(target: RtmpTarget, quality: LiveQuality = LIVE_LADDER[0] as LiveQuality, slideFile?: string): string[] {
  const base = target.url.endsWith('/') ? target.url : `${target.url}/`;
  const q = quality;
  return [
    '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats',
    // ONE realtime clock for both inputs (-re): Telegram drops a connection that is fed faster than real time
    ...(slideFile ? ['-re', '-f', 'image2', '-loop', '1', '-framerate', String(q.fps), '-i', slideFile] : ['-re', '-f', 'lavfi', '-i', `color=c=0x0f1216:s=1280x720:r=${q.fps}`]), // Telegram requires a video track
    '-re', '-thread_queue_size', '1024', '-f', 'mp3', '-i', 'pipe:0',
    '-map', '0:v', '-map', '1:a',
    '-vf', `scale=${q.width}:${q.height}:flags=bilinear,format=yuv420p`,
    '-af', 'aresample=async=1:first_pts=0', // silence instead of a gap if the source ever stalls: the connection never sees a hole
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage,zerolatency', '-profile:v', 'main', '-threads', '2',
    '-g', String(q.fps * 2), '-keyint_min', String(q.fps * 2), '-sc_threshold', '0', '-b:v', `${q.videoKbps}k`, '-maxrate', `${q.videoKbps}k`, '-bufsize', `${q.videoKbps * 2}k`, // keyframe every 2 s, constant rate
    '-c:a', 'aac', '-b:a', `${q.audioKbps}k`, '-ar', '48000', '-ac', '2',
    '-max_muxing_queue_size', '1024', '-flush_packets', '1',
    '-flvflags', 'no_duration_filesize', '-f', 'flv', `${base}${target.key}`,
  ];
}

export class FfmpegRtmpPublisher implements RtmpPublisher {
  constructor(private readonly ffmpegPath = 'ffmpeg', private readonly slideFile?: string) {}

  publish(target: RtmpTarget, input: (sink: Writable) => () => void, signal: AbortSignal, hooks: PublishHooks = {}, quality: LiveQuality = LIVE_LADDER[0] as LiveQuality): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve({ code: null, stderr: '' });
      const proc = spawn(this.ffmpegPath, buildFfmpegRtmpArgs(target, quality, this.slideFile), { stdio: ['pipe', 'pipe', 'pipe'] });
      lowerPriority(proc);
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
        detach();
        signal.removeEventListener('abort', kill);
        resolve({ code, stderr });
      });
    });
  }
}
