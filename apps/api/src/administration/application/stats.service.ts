import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';

export interface HashtagStatRow {
  hashtagId: string;
  value: string;
  normalized: string;
  trackCount: number;
  playableCount: number;
  failedLyricsCount: number;
  plays: number;
  lastPlayedAt: Date | null;
  createdAt: Date;
}

/** Analytics come from a pre-aggregated table refreshed periodically, never computed per dashboard request. */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DatabaseService) {}

  start(everyMs = 60_000): void {
    void this.refresh().catch((e: unknown) => this.logger.warn({ msg: 'stats refresh failed', err: String(e) }));
    this.timer = setInterval(() => void this.refresh().catch((e: unknown) => this.logger.warn({ msg: 'stats refresh failed', err: String(e) })), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    await this.db.query(
      `INSERT INTO hashtag_stats (hashtag_id, track_count, playable_count, failed_lyrics_count, plays, last_played_at, updated_at)
       SELECT h.id, count(t.id)::int,
              count(t.id) FILTER (WHERE t.status = 'READY' AND t.enabled AND t.deleted_at IS NULL)::int,
              count(t.id) FILTER (WHERE t.lyrics_status = 'LYRICS_FAILED')::int,
              COALESCE(sum(t.play_count), 0), max(t.last_played_at), now()
         FROM hashtags h LEFT JOIN track_hashtags th ON th.hashtag_id = h.id LEFT JOIN tracks t ON t.id = th.track_id
        GROUP BY h.id
       ON CONFLICT (hashtag_id) DO UPDATE SET track_count = EXCLUDED.track_count, playable_count = EXCLUDED.playable_count,
         failed_lyrics_count = EXCLUDED.failed_lyrics_count, plays = EXCLUDED.plays, last_played_at = EXCLUDED.last_played_at, updated_at = now()`,
    );
  }

  async hashtags(): Promise<{ items: HashtagStatRow[]; refreshedAt: Date | null }> {
    const r = await this.db.query<{ id: string; value: string; normalized_value: string; created_at: Date; track_count: number | null; playable_count: number | null; failed_lyrics_count: number | null; plays: string | null; last_played_at: Date | null; updated_at: Date | null }>(
      `SELECT h.id, h.value, h.normalized_value, h.created_at, s.track_count, s.playable_count, s.failed_lyrics_count, s.plays, s.last_played_at, s.updated_at
         FROM hashtags h LEFT JOIN hashtag_stats s ON s.hashtag_id = h.id ORDER BY s.track_count DESC NULLS LAST, h.normalized_value`,
    );
    const items = r.rows.map((x) => ({
      hashtagId: x.id, value: x.value, normalized: x.normalized_value, trackCount: x.track_count ?? 0, playableCount: x.playable_count ?? 0,
      failedLyricsCount: x.failed_lyrics_count ?? 0, plays: Number(x.plays ?? 0), lastPlayedAt: x.last_played_at, createdAt: x.created_at,
    }));
    const refreshedAt = r.rows.reduce<Date | null>((m, x) => (x.updated_at && (!m || x.updated_at > m) ? x.updated_at : m), null);
    return { items, refreshedAt };
  }

  async analytics(): Promise<{
    items: HashtagStatRow[]; refreshedAt: Date | null; mostPlayed: HashtagStatRow[]; noPlayableTracks: HashtagStatRow[]; withFailedLyrics: HashtagStatRow[]; recentlyAdded: HashtagStatRow[];
  }> {
    const { items, refreshedAt } = await this.hashtags();
    return {
      items,
      refreshedAt,
      mostPlayed: [...items].sort((a, b) => b.plays - a.plays).slice(0, 10),
      noPlayableTracks: items.filter((i) => i.playableCount === 0),
      withFailedLyrics: items.filter((i) => i.failedLyricsCount > 0),
      recentlyAdded: [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 10),
    };
  }

  async tracksOf(hashtagId: string): Promise<{ id: string; title: string; artist: string | null; enabled: boolean; status: string }[]> {
    const r = await this.db.query<{ id: string; title: string; artist: string | null; enabled: boolean; status: string }>(
      'SELECT t.id, t.title, t.artist, t.enabled, t.status FROM track_hashtags th JOIN tracks t ON t.id = th.track_id WHERE th.hashtag_id = $1 ORDER BY lower(t.title) LIMIT 1000',
      [hashtagId],
    );
    return r.rows;
  }
}
