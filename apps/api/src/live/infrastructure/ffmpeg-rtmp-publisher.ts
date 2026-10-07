import { RtmpTarget, PublishHooks, RtmpPublisher } from '../application/ports/telegram-live';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { LIVE_LADDER, LiveQuality, SpeedMeter } from '../domain/live-quality';
import { lowerPriority } from '../../shared/infrastructure/process-priority';

/** The live encoder's audio input: what `buildPcmDecoderArgs` produces. */
const PCM = ['-f', 's16le', '-ar', '48000', '-ac', '2'];

/**
 * Pure: the first stage, radio MP3 (stdin) -> raw 48 kHz stereo PCM (stdout). The tracks of a station differ in sample rate (44.1 / 48 kHz)
 * and channels; when the live encoder decoded the MP3 itself, every such change rebuilt its audio filters and the timestamps restarted:
 * with `aresample=first_pts=0` it padded the WHOLE time since the start of the live with silence at one timestamp (217 s after a 44.1 -> 48 kHz
 * switch), which threw Telegram's player off - the picture and the sound of the previous song stuck. Raw PCM has no timestamps, so the
 * encoder's clock is just the sample count and a track change is invisible to it.
 */
export function buildPcmDecoderArgs(): string[] {
  return ['-nostdin', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0', '-vn', ...PCM, 'pipe:1'];
}

/** The raw PCM muxer complains (harmlessly, nothing is lost) when its input changes format: not worth a log line per packet. */
const BENIGN_DECODER_LINE = /non monotonically increasing dts|Header missing|Invalid data found when processing input/;

/**
 * Pure: the ffmpeg arguments used to publish 48 kHz PCM audio (stdin, see `buildPcmDecoderArgs`) + a picture to Telegram over RTMP(S).
 * Best practice for an audio radio on a video platform: the video is ONE still PNG (`slideFile`, re-read for every frame so the picture can
 * change without a restart) at a few frames per second, so the encoder costs almost no CPU and the bitrate is all audio.
 */
export function buildFfmpegRtmpArgs(target: RtmpTarget, quality: LiveQuality = LIVE_LADDER[0] as LiveQuality, slideFile?: string): string[] {
  const base = target.url.endsWith('/') ? target.url : `${target.url}/`;
  const q = quality;
  return [
    '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1', '-nostats',
    // ONE realtime clock for both inputs (-re): Telegram drops a connection that is fed faster than real time.
    // A tiny read-ahead for the picture: every queued frame is a stale copy of the slide (64 frames held the old title for 12.8 s).
    ...(slideFile ? ['-re', '-thread_queue_size', '4', '-f', 'image2', '-loop', '1', '-framerate', String(q.fps), '-i', slideFile] : ['-re', '-f', 'lavfi', '-i', `color=c=0x0f1216:s=1280x720:r=${q.fps}`]), // Telegram requires a video track
    '-re', '-thread_queue_size', '1024', ...PCM, '-i', 'pipe:0',
    '-map', '0:v', '-map', '1:a',
    '-vf', `scale=${q.width}:${q.height}:flags=bilinear,format=yuv420p`,
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
      // radio MP3 -> decoder -> 48 kHz PCM -> encoder -> Telegram (see buildPcmDecoderArgs for why there are two processes)
      const decoder = spawn(this.ffmpegPath, buildPcmDecoderArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
      const proc = spawn(this.ffmpegPath, buildFfmpegRtmpArgs(target, quality, this.slideFile), { stdio: ['pipe', 'pipe', 'pipe'] });
      lowerPriority(decoder);
      lowerPriority(proc);
      let stderr = '';
      decoder.stderr.on('data', (d: Buffer) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (!line.trim() || BENIGN_DECODER_LINE.test(line)) continue;
          stderr = `${stderr}decoder: ${line}\n`.slice(-1500);
          hooks.onLog?.(`decoder: ${line}`);
        }
      });
      proc.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr = (stderr + text).slice(-1500);
        for (const line of text.split(/\r?\n/)) if (line.trim()) hooks.onLog?.(line.split(target.key).join('<stream-key>'));
      });
      // `-progress`: `total_size` is the number of bytes written to the output; > 0 means Telegram accepted the connection and the data
      let active = false;
      let pending = '';
      let outUs: number | null = null;
      const meter = new SpeedMeter();
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
          const t = /^out_time_us=(\d+)/.exec(line);
          if (t) outUs = Number(t[1]);
          // end of one progress block: the CURRENT speed over a sliding window (ffmpeg's own `speed=` is an average since the start)
          if (line.startsWith('progress=') && active && outUs !== null) {
            const speed = meter.add(Date.now(), outUs);
            if (speed !== null) hooks.onSpeed?.(speed);
          }
        }
      });
      // EPIPE when the next process exits first; a decoder that dies ends the encoder's input, so the encoder exits and is reported
      proc.stdin.on('error', () => undefined);
      decoder.stdin.on('error', () => undefined);
      decoder.stdout.pipe(proc.stdin);
      decoder.on('close', (code) => {
        if (code !== 0 && code !== null) stderr = `${stderr}decoder exited (${code})\n`.slice(-1500);
      });
      const detach = input(decoder.stdin);
      const kill = (): void => {
        proc.kill('SIGKILL');
        decoder.kill('SIGKILL');
      };
      signal.addEventListener('abort', kill, { once: true });
      let failed = false;
      const fail = (err: NodeJS.ErrnoException): void => {
        if (failed) return;
        failed = true;
        detach();
        kill();
        reject(new Error(err.code === 'ENOENT' ? `ffmpeg not found at "${this.ffmpegPath}"` : err.message));
      };
      proc.on('error', fail);
      decoder.on('error', fail);
      proc.on('close', (code) => {
        detach();
        decoder.kill('SIGKILL');
        signal.removeEventListener('abort', kill);
        resolve({ code, stderr });
      });
    });
  }
}
