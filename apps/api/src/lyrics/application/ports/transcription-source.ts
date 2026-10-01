import { TranscriptionProvider } from '../../domain/transcription.types';




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
