import { TrackQueryRepository, TrackQuery, TrackListItem } from '../../application/ports/track-query.repository';
import { Injectable } from '@nestjs/common';
import { normalizeHashtag } from '../../domain/caption-parser';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';

const SORT_SQL: Record<TrackQuery['sort'], string> = {
  createdAt: 't.created_at',
  title: 'lower(t.title)',
  artist: 'lower(t.artist)',
  lastPlayedAt: 't.last_played_at',
  playCount: 't.play_count',
};

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

@Injectable()
export class PgTrackQueryRepository implements TrackQueryRepository {
  constructor(private readonly db: DatabaseService) {}

  async search(f: TrackQuery): Promise<{ total: number; page: number; pageSize: number; items: TrackListItem[] }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown): string => `$${params.push(v)}`;

    if (f.channel) where.push(`t.telegram_channel_id = ${p(f.channel)}`);
    if (f.q) where.push(`(coalesce(t.title,'') || ' ' || coalesce(t.artist,'') || ' ' || coalesce(t.album,'')) ILIKE ${p(`%${escapeLike(f.q)}%`)}`);
    if (f.artist) where.push(`lower(t.artist) = lower(${p(f.artist)})`);
    if (f.album) where.push(`lower(t.album) = lower(${p(f.album)})`);
    if (f.hashtag) {
      where.push(`EXISTS (SELECT 1 FROM track_hashtags th JOIN hashtags h ON h.id = th.hashtag_id WHERE th.track_id = t.id AND h.normalized_value = ${p(normalizeHashtag(f.hashtag.replace(/^#/, '')))})`);
    }
    if (f.lyricsStatus) where.push(`t.lyrics_status = ${p(f.lyricsStatus)}`);
    if (f.enabled !== undefined) where.push(`t.enabled = ${p(f.enabled)}`);
    switch (f.playback) {
      case 'PLAYABLE': where.push(`t.status = 'READY' AND t.enabled AND t.deleted_at IS NULL`); break;
      case 'DISABLED': where.push('NOT t.enabled'); break;
      case 'FAILED': where.push(`t.status = 'FAILED'`); break;
      case 'UNAVAILABLE': where.push(`t.status = 'UNAVAILABLE'`); break;
      default: break;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM tracks t ${w}`, params)).rows[0]?.n ?? 0);

    const dir = f.order === 'asc' ? 'ASC' : 'DESC';
    const limit = p(f.pageSize);
    const offset = p((f.page - 1) * f.pageSize);
    const rows = await this.db.query<{
      id: string; title: string; artist: string | null; album: string | null; duration: number | null; hashtags: string[]; lyrics_status: string;
      enabled: boolean; status: string; play_count: number; last_played_at: Date | null; telegram_channel_id: string; telegram_message_id: number; telegram_post_url: string | null; lyrics_url: string | null;
    }>(
      `SELECT t.id, t.title, t.artist, t.album, t.duration, t.lyrics_status, t.enabled, t.status, t.play_count, t.last_played_at,
              t.telegram_channel_id, t.telegram_message_id, t.telegram_post_url, t.lyrics_url,
              COALESCE((SELECT array_agg(h.value ORDER BY h.normalized_value) FROM track_hashtags th JOIN hashtags h ON h.id = th.hashtag_id WHERE th.track_id = t.id), '{}') AS hashtags
         FROM tracks t ${w} ORDER BY ${SORT_SQL[f.sort]} ${dir} NULLS LAST, t.id LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return {
      total,
      page: f.page,
      pageSize: f.pageSize,
      items: rows.rows.map((r) => ({
        id: r.id, title: r.title, artist: r.artist, album: r.album, duration: r.duration, hashtags: r.hashtags, lyricsStatus: r.lyrics_status, enabled: r.enabled,
        status: r.status, playCount: r.play_count, lastPlayedAt: r.last_played_at, channelId: r.telegram_channel_id, telegramMessageId: r.telegram_message_id, telegramPostUrl: r.telegram_post_url, lyricsUrl: r.lyrics_url,
      })),
    };
  }
}
