import { TranscriptionRuntime, TranscriptionSource } from '../application/ports/transcription-source';
import { SettingsService } from '../../administration/application/settings.service';
import { WhisperTranscriptionProvider } from './whisper-transcription.provider';

/** Builds the Whisper provider from the panel/env settings and rebuilds it only when they change. */
export class SettingsTranscriptionSource implements TranscriptionSource {
  private built: { key: string; runtime: TranscriptionRuntime } | null = null;

  constructor(private readonly settings: Pick<SettingsService, 'whisper'>) {}

  async current(): Promise<TranscriptionRuntime | null> {
    const w = await this.settings.whisper();
    if (!w) return null;
    const key = JSON.stringify([w.url, w.model, w.apiKey, w.language, w.sampleRate, w.timeoutSeconds]);
    if (this.built?.key !== key) {
      this.built = {
        key,
        runtime: {
          provider: new WhisperTranscriptionProvider({ url: w.url, model: w.model, apiKey: w.apiKey, language: undefined, timeoutMs: w.timeoutSeconds * 1000 }),
          identity: { provider: 'openai-compatible', model: w.model },
          language: w.language,
          sampleRate: w.sampleRate,
        },
      };
    }
    return this.built.runtime;
  }
}
