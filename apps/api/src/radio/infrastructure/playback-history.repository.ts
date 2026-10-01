import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';

export type EndReason = 'FINISHED' | 'SKIPPED' | 'ERROR' | 'ADMIN' | 'SHUTDOWN';

@Injectable()
export class PlaybackHistoryRepository {
  constructor(private readonly db: DatabaseService) {}

  async start(trackId: string, startedAt: Date): Promise<string> {
    return this.db.tx(async (q) => {
      const r = await q.query<{ id: string }>('INSERT INTO playback_history (track_id, started_at) VALUES ($1, $2) RETURNING id', [trackId, startedAt]);
      await q.query('UPDATE tracks SET play_count = play_count + 1, last_played_at = $2 WHERE id = $1', [trackId, startedAt]);
      return r.rows[0]?.id ?? '';
    });
  }

  async end(historyId: string, reason: EndReason): Promise<void> {
    await this.db.query('UPDATE playback_history SET ended_at = now(), end_reason = $2 WHERE id = $1 AND ended_at IS NULL', [historyId, reason]);
  }

  /** Most recent first. */
  async recentTrackIds(channelId: string, limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    const r = await this.db.query<{ track_id: string }>(
      `SELECT p.track_id FROM playback_history p JOIN tracks t ON t.id = p.track_id
        WHERE t.telegram_channel_id = $1 ORDER BY p.started_at DESC, p.id DESC LIMIT $2`,
      [channelId, limit],
    );
    return r.rows.map((x) => x.track_id);
  }

  /** Closes rows left open by a crashed process. */
  async closeDangling(): Promise<number> {
    const r = await this.db.query(`UPDATE playback_history SET ended_at = now(), end_reason = 'ERROR' WHERE ended_at IS NULL`);
    return r.rowCount ?? 0;
  }

  async list(channelId: string, limit: number): Promise<{ id: string; trackId: string; title: string; artist: string | null; startedAt: Date; endedAt: Date | null; endReason: string | null }[]> {
    const r = await this.db.query<{ id: string; track_id: string; title: string; artist: string | null; started_at: Date; ended_at: Date | null; end_reason: string | null }>(
      `SELECT p.id, p.track_id, t.title, t.artist, p.started_at, p.ended_at, p.end_reason
         FROM playback_history p JOIN tracks t ON t.id = p.track_id WHERE t.telegram_channel_id = $1 ORDER BY p.started_at DESC LIMIT $2`,
      [channelId, limit],
    );
    return r.rows.map((x) => ({ id: x.id, trackId: x.track_id, title: x.title, artist: x.artist, startedAt: x.started_at, endedAt: x.ended_at, endReason: x.end_reason }));
  }
}
