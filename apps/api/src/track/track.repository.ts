import { Injectable } from '@nestjs/common';
import { DatabaseService, Queryable } from '../database/database.service';
import { ParsedCaption } from '../telegram/caption-parser';
import { TelegramAudioMessage } from '../telegram/telegram.types';
import { LyricsStatus, mapTrack, Track, TRACK_COLUMNS, TrackRow } from './track.types';

export type UpsertOutcome = 'created' | 'updated' | 'unchanged' | 'restored';

export interface UpsertResult {
  trackId: string;
  outcome: UpsertOutcome;
  /** true for new tracks with a URL, and when the URL changed: lyrics need (re)fetching. */
  lyricsNeedsFetch: boolean;
}

interface ExistingRow {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  lyrics_url: string | null;
  caption_raw: string | null;
  status: string;
  deleted_at: Date | null;
}

@Injectable()
export class TrackRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Idempotent: the (channel, message) unique key guarantees a single row however often sync runs. */
  async upsertFromTelegram(msg: TelegramAudioMessage, parsed: ParsedCaption): Promise<UpsertResult> {
    return this.db.tx(async (q) => {
      const existing = (
        await q.query<ExistingRow>(
          `SELECT id, title, artist, album, duration, lyrics_url, caption_raw, status, deleted_at
             FROM tracks WHERE telegram_channel_id = $1 AND telegram_message_id = $2 FOR UPDATE`,
          [msg.channelId, msg.messageId],
        )
      ).rows[0];

      const lyricsUrl = parsed.lyricsUrl ?? null;
      const duration = msg.audio.duration ?? null;

      if (!existing) {
        const ins = await q.query<{ id: string }>(
          `INSERT INTO tracks (telegram_channel_id, telegram_message_id, title, artist, album, duration, mime_type, file_size,
                               telegram_file_reference, telegram_post_url, lyrics_url, caption_raw, lyrics_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (telegram_channel_id, telegram_message_id) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [
            msg.channelId,
            msg.messageId,
            parsed.title,
            parsed.artist ?? null,
            parsed.album ?? null,
            duration,
            msg.audio.mimeType,
            msg.audio.size,
            msg.audio.fileReference,
            msg.postUrl ?? null,
            lyricsUrl,
            msg.caption,
            lyricsUrl ? 'LYRICS_PENDING' : 'LYRICS_NONE',
          ],
        );
        const id = ins.rows[0]?.id ?? '';
        await this.syncHashtags(q, id, parsed);
        return { trackId: id, outcome: 'created' as const, lyricsNeedsFetch: lyricsUrl !== null };
      }

      const wasGone = existing.status === 'UNAVAILABLE' || existing.deleted_at !== null;
      const urlChanged = existing.lyrics_url !== lyricsUrl;
      const fieldsChanged =
        existing.title !== parsed.title ||
        existing.artist !== (parsed.artist ?? null) ||
        existing.album !== (parsed.album ?? null) ||
        existing.duration !== duration ||
        urlChanged ||
        existing.caption_raw !== msg.caption;

      await q.query(
        `UPDATE tracks SET title=$2, artist=$3, album=$4, duration=$5, mime_type=$6, file_size=$7, telegram_file_reference=$8,
                telegram_post_url=$9, lyrics_url=$10, caption_raw=$11,
                lyrics_status = CASE WHEN $12::boolean THEN (CASE WHEN $10::text IS NULL THEN 'LYRICS_NONE' ELSE 'LYRICS_PENDING' END) ELSE lyrics_status END,
                status = CASE WHEN status IN ('UNAVAILABLE', 'FAILED') THEN 'READY' ELSE status END,
                consecutive_failures = CASE WHEN status = 'FAILED' THEN 0 ELSE consecutive_failures END,
                deleted_at = NULL,
                updated_at = CASE WHEN $13::boolean THEN now() ELSE updated_at END
          WHERE id = $1`,
        [
          existing.id,
          parsed.title,
          parsed.artist ?? null,
          parsed.album ?? null,
          duration,
          msg.audio.mimeType,
          msg.audio.size,
          msg.audio.fileReference,
          msg.postUrl ?? null,
          lyricsUrl,
          msg.caption,
          urlChanged,
          fieldsChanged || wasGone,
        ],
      );
      const hashtagsChanged = await this.syncHashtags(q, existing.id, parsed);
      const outcome: UpsertOutcome = wasGone ? 'restored' : fieldsChanged || hashtagsChanged ? 'updated' : 'unchanged';
      return { trackId: existing.id, outcome, lyricsNeedsFetch: urlChanged && lyricsUrl !== null };
    });
  }

  /** Replaces the track's hashtag set. Returns true if the set changed. */
  private async syncHashtags(q: Queryable, trackId: string, parsed: ParsedCaption): Promise<boolean> {
    const before = new Set(
      (
        await q.query<{ normalized_value: string }>(
          `SELECT h.normalized_value FROM track_hashtags th JOIN hashtags h ON h.id = th.hashtag_id WHERE th.track_id = $1`,
          [trackId],
        )
      ).rows.map((r) => r.normalized_value),
    );
    const wanted = new Set(parsed.hashtags.map((h) => h.normalized));
    const same = before.size === wanted.size && [...wanted].every((h) => before.has(h));
    if (same) return false;

    const ids: string[] = [];
    for (const h of parsed.hashtags) {
      const r = await q.query<{ id: string }>(
        `INSERT INTO hashtags (value, normalized_value) VALUES ($1, $2)
         ON CONFLICT (normalized_value) DO UPDATE SET normalized_value = EXCLUDED.normalized_value RETURNING id`,
        [h.value, h.normalized],
      );
      const id = r.rows[0]?.id;
      if (id) ids.push(id);
    }
    await q.query(`DELETE FROM track_hashtags WHERE track_id = $1 AND hashtag_id <> ALL($2::uuid[])`, [trackId, ids]);
    if (ids.length > 0) {
      await q.query(
        `INSERT INTO track_hashtags (track_id, hashtag_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        [trackId, ids],
      );
    }
    return true;
  }

  async listActiveMessageIds(channelId: string): Promise<{ id: string; messageId: number }[]> {
    const r = await this.db.query<{ id: string; telegram_message_id: number }>(
      `SELECT id, telegram_message_id FROM tracks WHERE telegram_channel_id = $1 AND deleted_at IS NULL ORDER BY telegram_message_id`,
      [channelId],
    );
    return r.rows.map((x) => ({ id: x.id, messageId: x.telegram_message_id }));
  }

  async markUnavailable(channelId: string, messageIds: readonly number[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    const r = await this.db.query(
      `UPDATE tracks SET status = 'UNAVAILABLE', deleted_at = now(), updated_at = now()
        WHERE telegram_channel_id = $1 AND telegram_message_id = ANY($2::int[]) AND deleted_at IS NULL`,
      [channelId, messageIds],
    );
    return r.rowCount ?? 0;
  }

  async getSyncState(channelId: string): Promise<{ lastMessageId: number }> {
    const r = await this.db.query<{ last_message_id: number }>('SELECT last_message_id FROM sync_state WHERE channel_id = $1', [channelId]);
    return { lastMessageId: r.rows[0]?.last_message_id ?? 0 };
  }

  async saveSyncState(channelId: string, lastMessageId: number, full: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO sync_state (channel_id, last_message_id, last_full_sync_at, updated_at)
       VALUES ($1, $2, CASE WHEN $3::boolean THEN now() END, now())
       ON CONFLICT (channel_id) DO UPDATE SET last_message_id = GREATEST(sync_state.last_message_id, $2),
         last_full_sync_at = CASE WHEN $3::boolean THEN now() ELSE sync_state.last_full_sync_at END, updated_at = now()`,
      [channelId, lastMessageId, full],
    );
  }

  async findById(id: string): Promise<Track | null> {
    const r = await this.db.query<TrackRow>(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = $1`, [id]);
    const row = r.rows[0];
    return row ? mapTrack(row) : null;
  }

  /** Telegram identity needed to download audio and to key transcript caches. */
  async getFileIdentity(trackId: string): Promise<{ messageId: number; channelId: string; fileReference: string; fileSize: number | null } | null> {
    const r = await this.db.query<{ telegram_message_id: number; telegram_channel_id: string; telegram_file_reference: string; file_size: string | null }>(
      'SELECT telegram_message_id, telegram_channel_id, telegram_file_reference, file_size FROM tracks WHERE id = $1',
      [trackId],
    );
    const x = r.rows[0];
    return x
      ? { messageId: x.telegram_message_id, channelId: x.telegram_channel_id, fileReference: x.telegram_file_reference, fileSize: x.file_size === null ? null : Number(x.file_size) }
      : null;
  }

  async setLyricsStatus(trackId: string, status: LyricsStatus, error: string | null = null): Promise<void> {
    await this.db.query('UPDATE tracks SET lyrics_status = $2, lyrics_error = $3, updated_at = now() WHERE id = $1', [trackId, status, error]);
  }

  /** Playback bookkeeping: reset failures on success, mark FAILED after `maxFailures` consecutive errors. */
  async recordPlaybackResult(trackId: string, ok: boolean, maxFailures = 3): Promise<void> {
    if (ok) {
      await this.db.query('UPDATE tracks SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0', [trackId]);
      return;
    }
    await this.db.query(
      `UPDATE tracks SET consecutive_failures = consecutive_failures + 1,
              status = CASE WHEN consecutive_failures + 1 >= $2 AND status = 'READY' THEN 'FAILED' ELSE status END, updated_at = now()
        WHERE id = $1`,
      [trackId, maxFailures],
    );
  }

  async setLyricsLanguage(trackId: string, lang: string): Promise<void> {
    await this.db.query('UPDATE tracks SET lyrics_language = $2 WHERE id = $1 AND lyrics_language IS DISTINCT FROM $2', [trackId, lang]);
  }

  async getLyricsLanguage(trackId: string): Promise<'fa' | 'en' | 'mixed' | 'unknown' | null> {
    const r = await this.db.query<{ lyrics_language: 'fa' | 'en' | 'mixed' | 'unknown' | null }>('SELECT lyrics_language FROM tracks WHERE id = $1', [trackId]);
    return r.rows[0]?.lyrics_language ?? null;
  }

  /** What identifies the stored audio of a message: document id + size come from the file reference. */
  async getAudioIdentity(channelId: string, messageId: number): Promise<{ fileReference: string; fileSize: number | null } | null> {
    const r = await this.db.query<{ telegram_file_reference: string; file_size: string | null }>(
      'SELECT telegram_file_reference, file_size FROM tracks WHERE telegram_channel_id = $1 AND telegram_message_id = $2',
      [channelId, messageId],
    );
    const x = r.rows[0];
    return x ? { fileReference: x.telegram_file_reference, fileSize: x.file_size === null ? null : Number(x.file_size) } : null;
  }
}
