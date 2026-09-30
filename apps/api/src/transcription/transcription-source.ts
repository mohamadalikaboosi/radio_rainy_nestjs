import { SettingsService } from '../settings/settings.service';
import { TranscriptionProvider } from './transcription.types';
import { WhisperTranscriptionProvider } from './whisper-transcription.provider';

/** What the transcription pipeline needs right now (settings can change at any time from the admin panel). */
export interface TranscriptionRuntime {
  provider: TranscriptionProvider;
  identity: { provider: string; model: string };
  /** Language hint configured in the panel (used when the track's language is unknown/mixed). */
  language: string | undefined;
  sampleRate: number;
}

export interface TranscriptionSource {
  /** null = Whisper is not configured: the pipeline skips transcription silently. */
  current(): Promise<TranscriptionRuntime | null>;
}

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
