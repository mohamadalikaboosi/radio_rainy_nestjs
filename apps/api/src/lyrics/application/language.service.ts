import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LyricsAlignmentService } from './lyrics-alignment.service';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { LlmClient, LlmNotConfiguredError } from '../infrastructure/llm-client';
import { LexiconRepository } from './lexicon';

export interface ReviewResult {
  reviewed: number;
  approved: number;
  rejected: number;
  skipped: number;
}

const SYSTEM_PROMPT = `You are a linguist for Persian (Farsi) and English song lyrics.
You get pairs [asr, lyric]: "asr" is how a speech recognizer spelled a word, "lyric" is how the official lyrics spell it.
Decide for each pair whether they are the SAME word (spelling variant, colloquial/dialect form, diacritics, transliteration, ZWNJ or Arabic/Persian letter variant)
or DIFFERENT words. Reply with ONLY a JSON array like [{"id":1,"same":true},{"id":2,"same":false}].`;

export function parseReview(raw: string): Map<number, boolean> {
  const out = new Map<number, boolean>();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  try {
    const arr = JSON.parse(raw.slice(start, end + 1)) as { id?: unknown; same?: unknown }[];
    for (const x of arr) if (typeof x.id === 'number' && typeof x.same === 'boolean') out.set(x.id, x.same);
  } catch {
    return out;
  }
  return out;
}

/** Learning loop for Persian/English: LLM-assisted review of learned spellings, re-training and dataset export. */
@Injectable()
export class LanguageService {
  private readonly logger = new Logger(LanguageService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly lexicon: LexiconRepository,
    private readonly alignment: Pick<LyricsAlignmentService, 'alignTrack'>,
    private readonly llm: LlmClient,
  ) {}

  async stats(): Promise<unknown> {
    const tracks = await this.db.query<{ lang: string | null; n: string }>(`SELECT lyrics_language AS lang, count(*) AS n FROM tracks GROUP BY 1 ORDER BY 1`);
    return { lexicon: await this.lexicon.stats(), tracksByLanguage: tracks.rows.map((r) => ({ language: r.lang ?? 'undetected', tracks: Number(r.n) })) };
  }

  /** Asks the configured LLM which learned (asr → lyric) pairs are real spelling variants; approves/rejects accordingly. */
  async reviewWithLlm(lang: 'fa' | 'en' | 'mixed', limit: number): Promise<ReviewResult> {
    const candidates = await this.lexicon.list({ lang, status: 'LEARNED', limit, offset: 0 });
    if (candidates.items.length === 0) return { reviewed: 0, approved: 0, rejected: 0, skipped: 0 };
    const numbered = candidates.items.map((c, i) => ({ id: i + 1, asr: c.asrWord, lyric: c.lyricWord }));
    let answer: string;
    try {
      answer = await this.llm.chat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Language: ${lang === 'fa' ? 'Persian' : lang === 'en' ? 'English' : 'Persian/English mix'}\n${JSON.stringify(numbered.map((n) => ({ id: n.id, asr: n.asr, lyric: n.lyric })))}` },
      ]);
    } catch (err) {
      if (err instanceof LlmNotConfiguredError) throw new BadRequestException(err.message);
      throw err;
    }
    const verdicts = parseReview(answer);
    const res: ReviewResult = { reviewed: numbered.length, approved: 0, rejected: 0, skipped: 0 };
    for (const n of numbered) {
      const same = verdicts.get(n.id);
      if (same === undefined) {
        res.skipped++;
        continue;
      }
      await this.lexicon.setStatus(lang, n.asr, n.lyric, same ? 'APPROVED' : 'REJECTED');
      if (same) res.approved++;
      else res.rejected++;
    }
    this.logger.log({ msg: 'llm lexicon review', lang, ...res });
    return res;
  }

  /** Re-aligns already transcribed songs with the current lexicon (no Whisper involved) and learns from improved results. */
  async retrain(limit: number, offset: number): Promise<{ processed: number; improved: number; learned: number; total: number }> {
    const total = Number((await this.db.query<{ n: string }>('SELECT count(DISTINCT track_id) AS n FROM transcripts')).rows[0]?.n ?? 0);
    const rows = await this.db.query<{ track_id: string; id: string; version: number | null }>(
      `SELECT t.track_id, t.id, (SELECT max(version) FROM synced_lyrics s WHERE s.track_id = t.track_id) AS version
         FROM (SELECT DISTINCT ON (track_id) track_id, id FROM transcripts ORDER BY track_id, created_at DESC) t
         JOIN lyrics l ON l.track_id = t.track_id AND l.raw_text IS NOT NULL
        ORDER BY t.track_id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    let improved = 0;
    let learned = 0;
    for (const r of rows.rows) {
      const out = await this.alignment.alignTrack(r.track_id, r.id);
      if (out.kind === 'ALIGNED') {
        learned += out.learned;
        if (r.version !== null && out.synced.version > r.version) improved++;
      }
    }
    return { processed: rows.rows.length, improved, learned, total };
  }

  /** JSONL training set (lyrics + ASR transcript + timed lines) for fine-tuning a Persian/English speech model elsewhere. */
  async *exportJsonl(): AsyncGenerator<string> {
    let last = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const r = await this.db.query<{ id: string; lang: string | null; raw: string; segments: unknown; lines: unknown }>(
        `SELECT t.id, t.lyrics_language AS lang, l.raw_text AS raw,
                (SELECT segments FROM transcripts tr WHERE tr.track_id = t.id ORDER BY created_at DESC LIMIT 1) AS segments,
                (SELECT lines FROM synced_lyrics s WHERE s.track_id = t.id ORDER BY version DESC LIMIT 1) AS lines
           FROM tracks t JOIN lyrics l ON l.track_id = t.id AND l.raw_text IS NOT NULL
          WHERE t.id > $1 AND EXISTS (SELECT 1 FROM synced_lyrics s WHERE s.track_id = t.id) ORDER BY t.id LIMIT 100`,
        [last],
      );
      if (r.rows.length === 0) return;
      for (const row of r.rows) yield `${JSON.stringify({ trackId: row.id, language: row.lang, lyrics: row.raw, asrSegments: row.segments, alignedLines: row.lines })}\n`;
      last = r.rows[r.rows.length - 1]?.id ?? last;
    }
  }
}
