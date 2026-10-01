import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable, Logger } from '@nestjs/common';
import { LyricsRepository } from './ports/lyrics.repository';
import { TelegramGateway } from '../../catalog/application/ports/telegram.types';
import { TrackRepository } from '../../catalog/application/ports/track.repository';
import { AudioPreprocessor } from '../infrastructure/audio-preprocessor';
import { whisperLanguage } from '../domain/language-detect';
import { TranscriptionSource } from './ports/transcription-source';

export type TranscribeOutcome = { kind: 'DONE'; transcriptId: string; cached: boolean } | { kind: 'DISABLED' } | { kind: 'TRACK_MISSING' };

/** Audio identity for caching: Telegram document id + size (no download needed to decide a cache hit). */
export function audioHashFrom(fileReference: string, fileSize: number | null): string {
  let docId = fileReference;
  try {
    const parsed = JSON.parse(fileReference) as { id?: string };
    if (parsed.id) docId = parsed.id;
  } catch {
    // reference isn't JSON (older rows / tests): use it verbatim
  }
  return createHash('sha256').update(`${docId}:${fileSize ?? 0}`).digest('hex');
}

@Injectable()
export class TrackTranscriptionService {
  private readonly logger = new Logger(TrackTranscriptionService.name);

  constructor(
    private readonly source: TranscriptionSource,
    private readonly gateway: TelegramGateway,
    private readonly preprocessor: AudioPreprocessor,
    private readonly tracks: TrackRepository,
    private readonly lyrics: LyricsRepository,
    private readonly tmpDir: string,
  ) {}

  async isEnabled(): Promise<boolean> {
    return (await this.source.current()) !== null;
  }

  async transcribeTrack(trackId: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<TranscribeOutcome> {
    const runtime = await this.source.current();
    if (!runtime) return { kind: 'DISABLED' };
    const ident = await this.tracks.getFileIdentity(trackId);
    if (!ident) return { kind: 'TRACK_MISSING' };
    const hash = audioHashFrom(ident.fileReference, ident.fileSize);

    // Cache: retries and re-alignments never re-run Whisper for the same audio + model.
    if (!opts.force) {
      const cached = await this.lyrics.getTranscript(trackId, hash, runtime.identity.provider, runtime.identity.model);
      if (cached) {
        this.logger.log({ msg: 'transcript cache hit', trackId });
        return { kind: 'DONE', transcriptId: cached.id, cached: true };
      }
    }

    const work = join(this.tmpDir, `${trackId}-${randomUUID()}`);
    await mkdir(work, { recursive: true });
    const raw = join(work, 'source');
    const prepared = join(work, 'prepared.flac');
    const started = Date.now();
    try {
      // Streamed to disk: no whole-file buffering in RAM.
      await pipeline(Readable.from(this.gateway.download(ident.channelId, ident.messageId, { signal: opts.signal })), createWriteStream(raw));
      await this.preprocessor.toWhisperInput(raw, prepared, { sampleRate: runtime.sampleRate }, opts.signal);
      // Per-track language (detected from the lyrics: Persian/English) beats the global hint; mixed/unknown = auto-detect.
      const language = whisperLanguage(await this.tracks.getLyricsLanguage(trackId)) ?? (runtime.language || undefined);
      const transcript = await runtime.provider.transcribe({ trackId, filePath: prepared, language }, opts.signal);
      const id = await this.lyrics.saveTranscript(trackId, hash, transcript);
      this.logger.log({ msg: 'track transcribed', trackId, language, sampleRate: runtime.sampleRate, segments: transcript.segments.length, ms: Date.now() - started });
      return { kind: 'DONE', transcriptId: id, cached: false };
    } finally {
      await rm(work, { recursive: true, force: true }).catch((e: unknown) => this.logger.warn({ msg: 'tmp cleanup failed', err: String(e) }));
    }
  }
}
