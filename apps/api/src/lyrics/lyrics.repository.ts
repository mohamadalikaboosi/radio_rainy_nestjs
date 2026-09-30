import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { AlignedLine } from '../alignment/lyrics-aligner';
import { DatabaseService } from '../database/database.service';
import { Transcript } from '../transcription/transcription.types';

export interface StoredLyrics {
  trackId: string;
  sourceUrl: string;
  rawText: string | null;
  status: 'PENDING' | 'FETCHED' | 'FAILED';
  error: string | null;
  fetchedAt: Date | null;
  expiresAt: Date | null;
}

export interface StoredSyncedLyrics {
  id: string;
  trackId: string;
  version: number;
  lines: AlignedLine[];
  quality: number;
  algorithmVersion: string;
  createdAt: Date;
}

export interface StoredTranscript extends Transcript {
  id: string;
}

interface LyricsRow {
  track_id: string;
  source_url: string;
  raw_text: string | null;
  status: StoredLyrics['status'];
  error: string | null;
  fetched_at: Date | null;
  expires_at: Date | null;
}

const mapLyrics = (r: LyricsRow): StoredLyrics => ({
  trackId: r.track_id,
  sourceUrl: r.source_url,
  rawText: r.raw_text,
  status: r.status,
  error: r.error,
  fetchedAt: r.fetched_at,
  expiresAt: r.expires_at,
});

@Injectable()
export class LyricsRepository {
  constructor(private readonly db: DatabaseService) {}

  async getLyrics(trackId: string): Promise<StoredLyrics | null> {
    const r = await this.db.query<LyricsRow>(
      'SELECT track_id, source_url, raw_text, status, error, fetched_at, expires_at FROM lyrics WHERE track_id = $1',
      [trackId],
    );
    return r.rows[0] ? mapLyrics(r.rows[0]) : null;
  }

  /** Same Telegraph page reused by other tracks: avoids fetching it again while the cache is fresh. */
  async findFreshRawByUrl(url: string): Promise<string | null> {
    const r = await this.db.query<{ raw_text: string }>(
      `SELECT raw_text FROM lyrics WHERE source_url = $1 AND status = 'FETCHED' AND raw_text IS NOT NULL AND expires_at > now()
        ORDER BY fetched_at DESC LIMIT 1`,
      [url],
    );
    return r.rows[0]?.raw_text ?? null;
  }

  async saveFetched(trackId: string, url: string, rawText: string, ttlSeconds: number): Promise<void> {
    const hash = createHash('sha256').update(rawText).digest('hex');
    await this.db.query(
      `INSERT INTO lyrics (track_id, source_url, raw_text, content_hash, status, error, fetched_at, expires_at)
       VALUES ($1, $2, $3, $4, 'FETCHED', NULL, now(), now() + make_interval(secs => $5))
       ON CONFLICT (track_id) DO UPDATE SET source_url = $2, raw_text = $3, content_hash = $4, status = 'FETCHED', error = NULL,
         fetched_at = now(), expires_at = now() + make_interval(secs => $5), updated_at = now()`,
      [trackId, url, rawText, hash, ttlSeconds],
    );
  }

  async saveFetchFailure(trackId: string, url: string, error: string): Promise<void> {
    await this.db.query(
      `INSERT INTO lyrics (track_id, source_url, status, error) VALUES ($1, $2, 'FAILED', $3)
       ON CONFLICT (track_id) DO UPDATE SET source_url = $2, status = 'FAILED', error = $3, updated_at = now()`,
      [trackId, url, error],
    );
  }

  async getTranscript(trackId: string, audioHash: string, provider: string, model: string): Promise<StoredTranscript | null> {
    const r = await this.db.query<{ id: string; language: string | null; segments: Transcript['segments']; words: Transcript['words'] | null }>(
      `SELECT id, language, segments, words FROM transcripts WHERE track_id = $1 AND audio_hash = $2 AND provider = $3 AND model = $4`,
      [trackId, audioHash, provider, model],
    );
    const x = r.rows[0];
    return x ? { id: x.id, language: x.language ?? undefined, segments: x.segments, words: x.words ?? undefined, provider, model } : null;
  }

  async getTranscriptById(id: string): Promise<StoredTranscript | null> {
    const r = await this.db.query<{ id: string; provider: string; model: string; language: string | null; segments: Transcript['segments']; words: Transcript['words'] | null }>(
      'SELECT id, provider, model, language, segments, words FROM transcripts WHERE id = $1',
      [id],
    );
    const x = r.rows[0];
    return x ? { id: x.id, provider: x.provider, model: x.model, language: x.language ?? undefined, segments: x.segments, words: x.words ?? undefined } : null;
  }

  async saveTranscript(trackId: string, audioHash: string, t: Transcript): Promise<string> {
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO transcripts (track_id, provider, model, language, audio_hash, segments, words)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (track_id, audio_hash, provider, model) DO UPDATE SET segments = $6, words = $7, language = $4
       RETURNING id`,
      [trackId, t.provider, t.model, t.language ?? null, audioHash, JSON.stringify(t.segments), t.words ? JSON.stringify(t.words) : null],
    );
    return r.rows[0]?.id ?? '';
  }

  async getLatestSynced(trackId: string): Promise<StoredSyncedLyrics | null> {
    const r = await this.db.query<{ id: string; track_id: string; version: number; lines: AlignedLine[]; quality: number; algorithm_version: string; created_at: Date }>(
      `SELECT id, track_id, version, lines, quality, algorithm_version, created_at FROM synced_lyrics WHERE track_id = $1 ORDER BY version DESC LIMIT 1`,
      [trackId],
    );
    const x = r.rows[0];
    return x ? { id: x.id, trackId: x.track_id, version: x.version, lines: x.lines, quality: x.quality, algorithmVersion: x.algorithm_version, createdAt: x.created_at } : null;
  }

  /** Idempotent: identical lines as the latest version create no new version. */
  async saveSynced(trackId: string, lines: AlignedLine[], quality: number, algorithmVersion: string, transcriptId: string | null): Promise<StoredSyncedLyrics> {
    return this.db.tx(async (q) => {
      await q.query('SELECT id FROM tracks WHERE id = $1 FOR UPDATE', [trackId]);
      const latest = (
        await q.query<{ id: string; version: number; lines: AlignedLine[]; quality: number; algorithm_version: string; created_at: Date }>(
          'SELECT id, version, lines, quality, algorithm_version, created_at FROM synced_lyrics WHERE track_id = $1 ORDER BY version DESC LIMIT 1',
          [trackId],
        )
      ).rows[0];
      // JSONB does not preserve key order, so compare structurally.
      if (latest && isDeepStrictEqual(latest.lines, lines)) {
        return { id: latest.id, trackId, version: latest.version, lines: latest.lines, quality: latest.quality, algorithmVersion: latest.algorithm_version, createdAt: latest.created_at };
      }
      const version = (latest?.version ?? 0) + 1;
      const ins = await q.query<{ id: string; created_at: Date }>(
        `INSERT INTO synced_lyrics (track_id, version, lines, quality, algorithm_version, transcript_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
        [trackId, version, JSON.stringify(lines), quality, algorithmVersion, transcriptId],
      );
      return { id: ins.rows[0]?.id ?? '', trackId, version, lines, quality, algorithmVersion, createdAt: ins.rows[0]?.created_at ?? new Date() };
    });
  }
}
