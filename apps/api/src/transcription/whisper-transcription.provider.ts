import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { TranscriptionError } from './transcription.errors';
import { AudioInput, Transcript, TranscriptionProvider, TranscriptSegment, TranscriptWord } from './transcription.types';

export interface WhisperProviderOptions {
  url: string;
  model: string;
  apiKey?: string;
  language?: string;
  timeoutMs: number;
}

export type WhisperFetch = (
  url: string,
  init: { method: string; body: FormData; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const num = z.coerce.number();
const responseSchema = z.object({
  language: z.string().optional(),
  text: z.string().optional(),
  segments: z
    .array(
      z.object({
        start: num,
        end: num,
        text: z.string(),
        words: z.array(z.object({ word: z.string(), start: num, end: num, probability: num.optional() })).optional(),
      }),
    )
    .optional(),
  words: z.array(z.object({ word: z.string(), start: num, end: num, probability: num.optional() })).optional(),
});

/**
 * Whisper-compatible HTTP provider (OpenAI `/v1/audio/transcriptions` shape: OpenAI, faster-whisper-server,
 * whisper.cpp server, Groq, ...). Requests word + segment timestamps; the alignment layer degrades gracefully
 * if the server only returns segments.
 */
export class WhisperTranscriptionProvider implements TranscriptionProvider {
  private readonly logger = new Logger(WhisperTranscriptionProvider.name);

  constructor(
    private readonly opt: WhisperProviderOptions,
    private readonly fetchFn: WhisperFetch = (u, i) => fetch(u, i),
  ) {}

  async transcribe(input: AudioInput, signal?: AbortSignal): Promise<Transcript> {
    const started = Date.now();
    const form = new FormData();
    // File-backed blob: the audio is streamed from disk, not held in RAM.
    form.append('file', await openAsBlob(input.filePath), basename(input.filePath));
    form.append('model', this.opt.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    form.append('temperature', '0');
    const language = input.language ?? this.opt.language;
    if (language) form.append('language', language);

    const timeout = AbortSignal.timeout(this.opt.timeoutMs);
    const headers: Record<string, string> = {};
    if (this.opt.apiKey) headers.Authorization = `Bearer ${this.opt.apiKey}`; // never logged

    let res;
    try {
      res = await this.fetchFn(this.opt.url, {
        method: 'POST',
        body: form,
        headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new TranscriptionError(`Whisper unreachable: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    const body = await res.text();
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      throw new TranscriptionError(`Whisper HTTP ${res.status}: ${body.slice(0, 200)}`, retryable);
    }
    const transcript = this.parse(body);
    this.logger.log({
      msg: 'transcription done',
      trackId: input.trackId,
      model: this.opt.model,
      segments: transcript.segments.length,
      words: transcript.words?.length ?? 0,
      ms: Date.now() - started,
    });
    return transcript;
  }

  private parse(body: string): Transcript {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new TranscriptionError('Whisper returned non-JSON response', false);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) throw new TranscriptionError('Whisper response has unexpected shape', false);
    const r = parsed.data;

    const segments: TranscriptSegment[] = (r.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
    const rawWords = r.words ?? (r.segments ?? []).flatMap((s) => s.words ?? []);
    const words: TranscriptWord[] = rawWords.map((w) => ({
      start: w.start,
      end: w.end,
      text: w.word.trim(),
      ...(w.probability !== undefined ? { probability: w.probability } : {}),
    }));
    if (segments.length === 0 && words.length === 0 && r.text) {
      throw new TranscriptionError('Whisper returned text without timestamps; cannot align', false);
    }
    return {
      language: r.language,
      segments,
      ...(words.length > 0 ? { words } : {}),
      provider: 'openai-compatible',
      model: this.opt.model,
    };
  }
}
