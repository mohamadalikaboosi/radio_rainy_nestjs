import { AppConfig, isWhisperEnabled } from '../config/app-config';
import { TranscriptionProvider } from './transcription.types';
import { WhisperTranscriptionProvider } from './whisper-transcription.provider';

/** Returns null when Whisper is not configured: callers must then skip transcription silently (no errors, no retries). */
export function createTranscriptionProvider(cfg: AppConfig): TranscriptionProvider | null {
  if (!isWhisperEnabled(cfg) || !cfg.WHISPER_URL) return null;
  return new WhisperTranscriptionProvider({
    url: cfg.WHISPER_URL,
    model: cfg.WHISPER_MODEL,
    apiKey: cfg.WHISPER_API_KEY,
    language: cfg.WHISPER_LANGUAGE,
    timeoutMs: cfg.WHISPER_TIMEOUT_SECONDS * 1000,
  });
}
