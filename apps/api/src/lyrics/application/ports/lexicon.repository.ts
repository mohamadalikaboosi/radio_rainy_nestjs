import { LexiconStatus, Lexicon, LearnedPair, LexiconRow } from '../../domain/lexicon';
import { LyricsLanguage } from '../../domain/language-detect';

/**
 * Persian/English spelling corrections learned from every successfully aligned song ("training" without a GPU):
 * what Whisper wrote vs what the official lyrics say. Trusted entries make future alignments more accurate.
 */
export abstract class LexiconRepository {
  abstract lexicon(lang: LyricsLanguage | string): Promise<Lexicon>;
  abstract invalidate(): void;
  abstract learn(lang: string, pairs: readonly LearnedPair[]): Promise<number>;
  abstract list(opts: { lang?: string; status?: LexiconStatus; limit: number; offset: number }): Promise<{ total: number; items: LexiconRow[] }>;
  abstract setStatus(lang: string, asrWord: string, lyricWord: string, status: LexiconStatus): Promise<boolean>;
  abstract remove(lang: string, asrWord: string, lyricWord: string): Promise<boolean>;
  abstract stats(): Promise<{ lang: string; entries: number; trusted: number; approved: number; rejected: number }[]>;
}
