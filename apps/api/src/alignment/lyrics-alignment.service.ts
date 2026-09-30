import { Injectable, Logger } from '@nestjs/common';
import { LyricsRepository, StoredSyncedLyrics } from '../lyrics/lyrics.repository';
import { ALIGNMENT_ALGORITHM_VERSION, alignLyrics, AlignmentFailureReason } from './lyrics-aligner';

export type AlignOutcome =
  | { kind: 'ALIGNED'; synced: StoredSyncedLyrics }
  | { kind: 'FAILED'; reason: AlignmentFailureReason | 'NO_LYRICS' | 'NO_TRANSCRIPT'; quality: number };

@Injectable()
export class LyricsAlignmentService {
  private readonly logger = new Logger(LyricsAlignmentService.name);

  constructor(private readonly lyrics: LyricsRepository) {}

  async alignTrack(trackId: string, transcriptId: string): Promise<AlignOutcome> {
    const stored = await this.lyrics.getLyrics(trackId);
    if (!stored?.rawText) return { kind: 'FAILED', reason: 'NO_LYRICS', quality: 0 };
    const transcript = await this.lyrics.getTranscriptById(transcriptId);
    if (!transcript) return { kind: 'FAILED', reason: 'NO_TRANSCRIPT', quality: 0 };

    const started = Date.now();
    const result = alignLyrics(stored.rawText, transcript);
    if (!result.ok) {
      this.logger.warn({ msg: 'alignment failed', trackId, reason: result.reason, quality: result.quality });
      return { kind: 'FAILED', reason: result.reason, quality: result.quality };
    }
    const synced = await this.lyrics.saveSynced(trackId, result.lines, result.quality, ALIGNMENT_ALGORITHM_VERSION, transcriptId);
    this.logger.log({ msg: 'alignment done', trackId, version: synced.version, quality: result.quality, lines: result.lines.length, ms: Date.now() - started });
    return { kind: 'ALIGNED', synced };
  }
}
