import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ChannelDirectory } from '../telegram/telegram.types';

export type LiveStatus = 'OFF' | 'STARTING' | 'LIVE' | 'ERROR';

/** One Telegram channel = one radio station. `id` is the Telegram channel id (string) used everywhere as the station key. */
export interface ChannelRow {
  id: string;
  reference: string;
  title: string;
  username: string | null;
  slug: string;
  started: boolean;
  telegramLiveEnabled: boolean;
  liveStatus: LiveStatus;
  liveError: string | null;
  createdAt: Date;
}

interface Row {
  telegram_channel_id: string;
  reference: string;
  title: string;
  username: string | null;
  slug: string;
  started: boolean;
  telegram_live_enabled: boolean;
  live_status: LiveStatus;
  live_error: string | null;
  created_at: Date;
}

const COLS = 'telegram_channel_id, reference, title, username, slug, started, telegram_live_enabled, live_status, live_error, created_at';
const map = (r: Row): ChannelRow => ({
  id: r.telegram_channel_id,
  reference: r.reference,
  title: r.title,
  username: r.username,
  slug: r.slug,
  started: r.started,
  telegramLiveEnabled: r.telegram_live_enabled,
  liveStatus: r.live_status,
  liveError: r.live_error,
  createdAt: r.created_at,
});

@Injectable()
export class ChannelRepository implements ChannelDirectory {
  constructor(private readonly db: DatabaseService) {}

  async list(): Promise<ChannelRow[]> {
    return (await this.db.query<Row>(`SELECT ${COLS} FROM channels ORDER BY created_at, telegram_channel_id`)).rows.map(map);
  }

  async get(id: string): Promise<ChannelRow | null> {
    const r = await this.db.query<Row>(`SELECT ${COLS} FROM channels WHERE telegram_channel_id = $1`, [id]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }

  async bySlug(slug: string): Promise<ChannelRow | null> {
    const r = await this.db.query<Row>(`SELECT ${COLS} FROM channels WHERE slug = $1`, [slug]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }

  /** Public "default" station for the legacy /radio/... URLs: the first started one, else the first one. */
  async defaultChannel(): Promise<ChannelRow | null> {
    const r = await this.db.query<Row>(`SELECT ${COLS} FROM channels ORDER BY started DESC, created_at LIMIT 1`);
    return r.rows[0] ? map(r.rows[0]) : null;
  }

  async referenceOf(id: string): Promise<string | null> {
    const r = await this.db.query<{ reference: string }>('SELECT reference FROM channels WHERE telegram_channel_id = $1', [id]);
    return r.rows[0]?.reference ?? null;
  }

  async slugExists(slug: string): Promise<boolean> {
    return ((await this.db.query('SELECT 1 FROM channels WHERE slug = $1', [slug])).rowCount ?? 0) > 0;
  }

  /** Creates the station together with its radio configuration and state rows. */
  async insert(input: { id: string; reference: string; title: string; username?: string; slug: string; recentTrackWindow: number }): Promise<ChannelRow> {
    return this.db.tx(async (q) => {
      const r = await q.query<Row>(
        `INSERT INTO channels (telegram_channel_id, reference, title, username, slug) VALUES ($1,$2,$3,$4,$5) RETURNING ${COLS}`,
        [input.id, input.reference, input.title, input.username ?? null, input.slug],
      );
      await q.query('INSERT INTO radio_configuration (channel_id, recent_track_window) VALUES ($1, $2)', [input.id, input.recentTrackWindow]);
      await q.query('INSERT INTO radio_state (channel_id) VALUES ($1)', [input.id]);
      return map(r.rows[0] as Row);
    });
  }

  async remove(id: string, deleteTracks: boolean): Promise<boolean> {
    return this.db.tx(async (q) => {
      if (deleteTracks) {
        await q.query('DELETE FROM tracks WHERE telegram_channel_id = $1', [id]);
        await q.query('DELETE FROM sync_state WHERE channel_id = $1', [id]);
      }
      const r = await q.query('DELETE FROM channels WHERE telegram_channel_id = $1', [id]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  async setStarted(id: string, started: boolean): Promise<boolean> {
    const r = await this.db.query('UPDATE channels SET started = $2, updated_at = now() WHERE telegram_channel_id = $1', [id, started]);
    return (r.rowCount ?? 0) > 0;
  }

  async setLiveEnabled(id: string, enabled: boolean): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE channels SET telegram_live_enabled = $2, live_status = CASE WHEN $2 THEN live_status ELSE 'OFF' END,
              live_error = CASE WHEN $2 THEN live_error ELSE NULL END, updated_at = now() WHERE telegram_channel_id = $1`,
      [id, enabled],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async setLiveStatus(id: string, status: LiveStatus, error: string | null = null): Promise<void> {
    await this.db.query('UPDATE channels SET live_status = $2, live_error = $3, updated_at = now() WHERE telegram_channel_id = $1', [id, status, error]);
  }
}
