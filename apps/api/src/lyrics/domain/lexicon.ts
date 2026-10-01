export type LexiconStatus = 'LEARNED' | 'APPROVED' | 'REJECTED';

/** ASR word -> lyric spellings known to mean the same word. Used by the aligner as "counts as a match". */
export interface Lexicon {
  equivalent(asrWord: string, lyricWord: string): boolean;
}

export const EMPTY_LEXICON: Lexicon = { equivalent: () => false };

export function lexiconFrom(map: ReadonlyMap<string, ReadonlySet<string>>): Lexicon {
  return { equivalent: (a, l) => map.get(a)?.has(l) === true };
}

export interface LearnedPair {
  asr: string;
  lyric: string;
}

export interface LexiconRow {
  lang: string;
  asrWord: string;
  lyricWord: string;
  count: number;
  status: LexiconStatus;
  updatedAt: Date;
}

/** A learned pair is trusted after it was observed this many times (or when an admin/LLM approved it). */
export const MIN_OBSERVATIONS = 2;
