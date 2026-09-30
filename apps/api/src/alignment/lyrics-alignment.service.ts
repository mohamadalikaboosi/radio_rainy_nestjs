import { Injectable, Logger } from '@nestjs/common';
import { detectLanguage } from '../language/language-detect';
import { LexiconRepository } from '../language/lexicon';
import { LyricsRepository, StoredSyncedLyrics } from '../lyrics/lyrics.repository';
import { TrackRepository } from '../track/track.repository';
import { ALIGNMENT_ALGORITHM_VERSION, alignLyrics, AlignmentFailureReason } from './lyrics-aligner';

export type AlignOutcome =
  | { kind: 'ALIGNED'; synced: StoredSyncedLyrics; learned: number }
  | { kind: 'FAILED'; reason: AlignmentFailureReason | 'NO_LYRICS' | 'NO_TRANSCRIPT'; quality: number };

@Injectable()
export class LyricsAlignmentService {
  private readonly logger = new Logger(LyricsAlignmentService.name);

  constructor(
    private readonly lyrics: LyricsRepository,
    private readonly lexicons: Pick<LexiconRepository, 'lexicon' | 'learn'>,
    private readonly tracks: Pick<TrackRepository, 'getLyricsLanguage'>,
  ) {}

  async alignTrack(trackId: string, transcriptId: string, opts: { learn?: boolean } = {}): Promise<AlignOutcome> {
    const stored = await this.lyrics.getLyrics(trackId);
    if (!stored?.rawText) return { kind: 'FAILED', reason: 'NO_LYRICS', quality: 0 };
    const transcript = await this.lyrics.getTranscriptById(transcriptId);
    if (!transcript) return { kind: 'FAILED', reason: 'NO_TRANSCRIPT', quality: 0 };

    const lang = (await this.tracks.getLyricsLanguage(trackId)) ?? detectLanguage(stored.rawText);
    const lexicon = await this.lexicons.lexicon(lang);
    const started = Date.now();
    const result = alignLyrics(stored.rawText, transcript, {}, lexicon);
    if (!result.ok) {
      this.logger.warn({ msg: 'alignment failed', trackId, reason: result.reason, quality: result.quality });
      return { kind: 'FAILED', reason: result.reason, quality: result.quality };
    }
    const before = await this.lyrics.getLatestSynced(trackId);
    const synced = await this.lyrics.saveSynced(trackId, result.lines, result.quality, ALIGNMENT_ALGORITHM_VERSION, transcriptId);
    // Learn only from a *new* alignment: re-running the same one must not inflate observation counts.
    let learned = 0;
    if (opts.learn !== false && lang !== 'unknown' && synced.version !== before?.version) learned = await this.lexicons.learn(lang, result.learned);
    this.logger.log({ msg: 'alignment done', trackId, lang, version: synced.version, quality: result.quality, lines: result.lines.length, learned, ms: Date.now() - started });
    return { kind: 'ALIGNED', synced, learned };
  }
}
