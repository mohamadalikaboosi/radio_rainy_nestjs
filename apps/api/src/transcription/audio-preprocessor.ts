import { spawn } from 'node:child_process';
import { TranscriptionError } from './transcription.errors';

export interface PreprocessOptions {
  /** Sample rate of the audio handed to Whisper (default 48 kHz, configurable in the panel). */
  sampleRate: number;
}

export interface AudioPreprocessor {
  /** Converts any input audio to mono FLAC at `sampleRate`. */
  toWhisperInput(inputPath: string, outputPath: string, opts: PreprocessOptions, signal?: AbortSignal): Promise<void>;
}

export class FfmpegPreprocessor implements AudioPreprocessor {
  constructor(private readonly ffmpegPath = 'ffmpeg') {}

  toWhisperInput(inputPath: string, outputPath: string, opts: PreprocessOptions, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, ['-nostdin', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', String(opts.sampleRate), '-c:a', 'flac', outputPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
        signal,
      });
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-2000);
      });
      proc.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') reject(new TranscriptionError(`ffmpeg not found at "${this.ffmpegPath}"`, false));
        else reject(new TranscriptionError(`ffmpeg failed to start: ${err.message}`, true));
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new TranscriptionError(`ffmpeg exited with ${code}: ${stderr.trim().slice(-300)}`, false));
      });
    });
  }
}
