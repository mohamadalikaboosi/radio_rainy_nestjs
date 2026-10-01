export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
  probability?: number;
}

export interface Transcript {
  language?: string;
  segments: TranscriptSegment[];
  words?: TranscriptWord[];
  provider: string;
  model: string;
}

export interface AudioInput {
  trackId: string;
  /** Local file path of preprocessed audio (16 kHz mono). Streamed to the provider, never loaded whole into RAM. */
  filePath: string;
  language?: string;
}

export interface TranscriptionProvider {
  transcribe(input: AudioInput, signal?: AbortSignal): Promise<Transcript>;
}

export const TRANSCRIPTION_PROVIDER = Symbol('TRANSCRIPTION_PROVIDER');
