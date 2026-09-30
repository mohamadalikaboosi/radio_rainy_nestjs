import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegPreprocessor } from './audio-preprocessor';

const posix = process.platform !== 'win32';

(posix ? describe : describe.skip)('FfmpegPreprocessor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffp-'));
  const fake = join(dir, 'ffmpeg');
  const argsFile = join(dir, 'args.txt');
  writeFileSync(fake, `#!/bin/sh\necho "$@" > ${argsFile}\nexit 0\n`);
  chmodSync(fake, 0o755);
  const failing = join(dir, 'ffmpeg-fail');
  writeFileSync(failing, '#!/bin/sh\necho "Invalid data found" >&2\nexit 3\n');
  chmodSync(failing, 0o755);

  it('converts to mono FLAC at the configured sample rate (48 kHz by default in the panel)', async () => {
    await new FfmpegPreprocessor(fake).toWhisperInput('in.mp3', 'out.flac', { sampleRate: 48000 });
    const args = readFileSync(argsFile, 'utf8');
    expect(args).toContain('-ar 48000');
    expect(args).toContain('-ac 1');
    expect(args).toContain('-c:a flac');
    await new FfmpegPreprocessor(fake).toWhisperInput('in.mp3', 'out.flac', { sampleRate: 16000 });
    expect(readFileSync(argsFile, 'utf8')).toContain('-ar 16000');
  });

  it('reports a missing ffmpeg as a non-retryable error and failures with stderr', async () => {
    await expect(new FfmpegPreprocessor('/nonexistent/ffmpeg').toWhisperInput('a', 'b', { sampleRate: 48000 })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('not found') });
    await expect(new FfmpegPreprocessor(failing).toWhisperInput('a', 'b', { sampleRate: 48000 })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('Invalid data found') });
  });
});
