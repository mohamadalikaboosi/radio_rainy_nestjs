import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { LanguageData, RetrainCandidate, TrainingRow } from '../application/ports/language-data';

export class PgLanguageData implements LanguageData {
  constructor(private readonly db: DatabaseService) {}

  async tracksByLanguage(): Promise<{ language: string | null; tracks: number }[]> {
    const r = await this.db.query<{ lang: string | null; n: string }>(`SELECT lyrics_language AS lang, count(*) AS n FROM tracks GROUP BY 1 ORDER BY 1`);
    return r.rows.map((x) => ({ language: x.lang, tracks: Number(x.n) }));
  }

  async transcribedTrackCount(): Promise<number> {
    return Number((await this.db.query<{ n: string }>('SELECT count(DISTINCT track_id) AS n FROM transcripts')).rows[0]?.n ?? 0);
  }

  async retrainCandidates(limit: number, offset: number): Promise<RetrainCandidate[]> {
    const rows = await this.db.query<{ track_id: string; id: string; version: number | null }>(
      `SELECT t.track_id, t.id, (SELECT max(version) FROM synced_lyrics s WHERE s.track_id = t.track_id) AS version
         FROM (SELECT DISTINCT ON (track_id) track_id, id FROM transcripts ORDER BY track_id, created_at DESC) t
         JOIN lyrics l ON l.track_id = t.track_id AND l.raw_text IS NOT NULL
        ORDER BY t.track_id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.rows.map((r) => ({ trackId: r.track_id, transcriptId: r.id, version: r.version }));
  }

  async trainingBatch(afterTrackId: string, limit: number): Promise<TrainingRow[]> {
    const r = await this.db.query<{ id: string; lang: string | null; raw: string; segments: unknown; lines: unknown }>(
      `SELECT t.id, t.lyrics_language AS lang, l.raw_text AS raw,
              (SELECT segments FROM transcripts tr WHERE tr.track_id = t.id ORDER BY created_at DESC LIMIT 1) AS segments,
              (SELECT lines FROM synced_lyrics s WHERE s.track_id = t.id ORDER BY version DESC LIMIT 1) AS lines
         FROM tracks t JOIN lyrics l ON l.track_id = t.id AND l.raw_text IS NOT NULL
        WHERE t.id > $1 AND EXISTS (SELECT 1 FROM synced_lyrics s WHERE s.track_id = t.id) ORDER BY t.id LIMIT $2`,
      [afterTrackId, limit],
    );
    return r.rows;
  }
}
