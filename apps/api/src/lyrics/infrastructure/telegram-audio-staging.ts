import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TelegramGateway } from '../../catalog/application/ports/telegram.types';
import { AudioStaging, StagedAudio } from '../application/ports/audio-staging';
import { AudioPreprocessor } from './audio-preprocessor';

/** Downloads the track from Telegram to a temp file (streamed, never fully in RAM) and converts it with ffmpeg. */
export class TelegramAudioStaging implements AudioStaging {
  constructor(private readonly gateway: TelegramGateway, private readonly preprocessor: AudioPreprocessor, private readonly tmpDir: string) {}

  async stage(input: { trackId: string; channelId: string; messageId: number; sampleRate: number }, signal?: AbortSignal): Promise<StagedAudio> {
    const work = join(this.tmpDir, `${input.trackId}-${randomUUID()}`);
    await mkdir(work, { recursive: true });
    const raw = join(work, 'source');
    const prepared = join(work, 'prepared.flac');
    const dispose = (): Promise<void> => rm(work, { recursive: true, force: true });
    try {
      await pipeline(Readable.from(this.gateway.download(input.channelId, input.messageId, { signal })), createWriteStream(raw));
      await this.preprocessor.toWhisperInput(raw, prepared, { sampleRate: input.sampleRate }, signal);
    } catch (err) {
      await dispose().catch(() => undefined);
      throw err;
    }
    return { filePath: prepared, dispose };
  }
}
