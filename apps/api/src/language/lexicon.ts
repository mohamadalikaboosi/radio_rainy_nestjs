import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LyricsLanguage } from './language-detect';

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
const CACHE_MS = 30_000;

/**
 * Persian/English spelling corrections learned from every successfully aligned song ("training" without a GPU):
 * what Whisper wrote vs what the official lyrics say. Trusted entries make future alignments more accurate.
 */
@Injectable()
export class LexiconRepository {
  private readonly cache = new Map<string, { at: number; lex: Lexicon }>();

  constructor(private readonly db: DatabaseService) {}

  async lexicon(lang: LyricsLanguage | string): Promise<Lexicon> {
    const hit = this.cache.get(lang);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.lex;
    const r = await this.db.query<{ asr_word: string; lyric_word: string }>(
      `SELECT asr_word, lyric_word FROM lexicon_entries WHERE lang = $1 AND status <> 'REJECTED' AND (status = 'APPROVED' OR count >= $2)`,
      [lang, MIN_OBSERVATIONS],
    );
    const map = new Map<string, Set<string>>();
    for (const row of r.rows) (map.get(row.asr_word) ?? map.set(row.asr_word, new Set()).get(row.asr_word))?.add(row.lyric_word);
    const lex = lexiconFrom(map);
    this.cache.set(lang, { at: Date.now(), lex });
    return lex;
  }

  invalidate(): void {
    this.cache.clear();
  }

  async learn(lang: string, pairs: readonly LearnedPair[]): Promise<number> {
    const unique = new Map<string, LearnedPair>();
    for (const p of pairs) if (p.asr !== p.lyric) unique.set(`${p.asr}\u0000${p.lyric}`, p);
    if (unique.size === 0) return 0;
    await this.db.tx(async (q) => {
      for (const p of unique.values()) {
        await q.query(
          `INSERT INTO lexicon_entries (lang, asr_word, lyric_word) VALUES ($1,$2,$3)
           ON CONFLICT (lang, asr_word, lyric_word) DO UPDATE SET count = lexicon_entries.count + 1, updated_at = now()`,
          [lang, p.asr, p.lyric],
        );
      }
    });
    this.invalidate();
    return unique.size;
  }

  async list(opts: { lang?: string; status?: LexiconStatus; limit: number; offset: number }): Promise<{ total: number; items: LexiconRow[] }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.lang) where.push(`lang = $${params.push(opts.lang)}`);
    if (opts.status) where.push(`status = $${params.push(opts.status)}`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM lexicon_entries ${w}`, params)).rows[0]?.n ?? 0);
    const rows = await this.db.query<{ lang: string; asr_word: string; lyric_word: string; count: number; status: LexiconStatus; updated_at: Date }>(
      `SELECT lang, asr_word, lyric_word, count, status, updated_at FROM lexicon_entries ${w} ORDER BY count DESC, updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, opts.limit, opts.offset],
    );
    return { total, items: rows.rows.map((r) => ({ lang: r.lang, asrWord: r.asr_word, lyricWord: r.lyric_word, count: r.count, status: r.status, updatedAt: r.updated_at })) };
  }

  async setStatus(lang: string, asrWord: string, lyricWord: string, status: LexiconStatus): Promise<boolean> {
    const r = await this.db.query('UPDATE lexicon_entries SET status = $4, updated_at = now() WHERE lang = $1 AND asr_word = $2 AND lyric_word = $3', [lang, asrWord, lyricWord, status]);
    this.invalidate();
    return (r.rowCount ?? 0) > 0;
  }

  async remove(lang: string, asrWord: string, lyricWord: string): Promise<boolean> {
    const r = await this.db.query('DELETE FROM lexicon_entries WHERE lang = $1 AND asr_word = $2 AND lyric_word = $3', [lang, asrWord, lyricWord]);
    this.invalidate();
    return (r.rowCount ?? 0) > 0;
  }

  async stats(): Promise<{ lang: string; entries: number; trusted: number; approved: number; rejected: number }[]> {
    const r = await this.db.query<{ lang: string; entries: string; trusted: string; approved: string; rejected: string }>(
      `SELECT lang, count(*) AS entries,
              count(*) FILTER (WHERE status <> 'REJECTED' AND (status = 'APPROVED' OR count >= ${MIN_OBSERVATIONS})) AS trusted,
              count(*) FILTER (WHERE status = 'APPROVED') AS approved, count(*) FILTER (WHERE status = 'REJECTED') AS rejected
         FROM lexicon_entries GROUP BY lang ORDER BY lang`,
    );
    return r.rows.map((x) => ({ lang: x.lang, entries: Number(x.entries), trusted: Number(x.trusted), approved: Number(x.approved), rejected: Number(x.rejected) }));
  }
}
