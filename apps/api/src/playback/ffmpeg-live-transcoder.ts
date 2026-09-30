import { spawn } from 'node:child_process';
import { LiveTranscoder } from './audio-pipeline';

/** ffmpeg stdin -> stdout MP3 encoder. Killed on abort; stdin feeding respects backpressure. */
export class FfmpegLiveTranscoder implements LiveTranscoder {
  constructor(private readonly ffmpegPath = 'ffmpeg') {}

  async *toMp3(source: AsyncIterable<Uint8Array>, bitrateKbps: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const proc = spawn(
      this.ffmpegPath,
      ['-nostdin', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', `${bitrateKbps}k`, '-ar', '44100', '-ac', '2', '-f', 'mp3', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-1000);
    });
    let spawnError: Error | undefined;
    proc.on('error', (e) => {
      spawnError = e;
    });
    const kill = (): void => {
      proc.kill('SIGKILL');
    };
    signal?.addEventListener('abort', kill, { once: true });
    // ffmpeg may exit early (bad input); EPIPE on stdin is then expected and reported through exit status.
    proc.stdin.on('error', () => undefined);

    const feed = (async () => {
      try {
        for await (const chunk of source) {
          if (!proc.stdin.write(chunk)) await new Promise<void>((r) => proc.stdin.once('drain', r));
        }
      } finally {
        proc.stdin.end();
      }
    })();
    feed.catch(() => kill());

    try {
      for await (const out of proc.stdout) yield out as Buffer;
      const code: number | null = await new Promise((resolve) => (proc.exitCode !== null ? resolve(proc.exitCode) : proc.once('close', resolve)));
      if (spawnError) throw new Error(`ffmpeg failed to start: ${spawnError.message}`);
      if (code !== 0 && !signal?.aborted) throw new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`);
    } finally {
      signal?.removeEventListener('abort', kill);
      kill();
      await feed.catch(() => undefined);
    }
  }
}
