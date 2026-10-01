import { ChannelRepository, LiveStatus, ChannelRow } from '../../application/ports/channel.repository';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { ChannelDirectory } from '../../application/ports/telegram.types';

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
  live_rtmp_url: string | null;
  live_rtmp_key_set: boolean;
  live_target_rev: number;
  owner_account_id: string | null;
  created_at: Date;
}

const COLS = 'telegram_channel_id, reference, title, username, slug, started, telegram_live_enabled, live_status, live_error, live_rtmp_url, (live_rtmp_key_enc IS NOT NULL) AS live_rtmp_key_set, live_target_rev, owner_account_id, created_at';
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
  liveRtmpUrl: r.live_rtmp_url,
  liveRtmpKeySet: r.live_rtmp_key_set,
  liveTargetRev: r.live_target_rev,
  ownerAccountId: r.owner_account_id,
  createdAt: r.created_at,
});

@Injectable()
export class PgChannelRepository implements ChannelDirectory , ChannelRepository{
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

  /** `keyEnc` is already encrypted. Both null clears the manual target. Bumps the revision so a running stream reconnects. */
  async setLiveTarget(id: string, url: string | null, keyEnc: string | null): Promise<boolean> {
    const r = await this.db.query('UPDATE channels SET live_rtmp_url = $2, live_rtmp_key_enc = $3, live_target_rev = live_target_rev + 1, updated_at = now() WHERE telegram_channel_id = $1', [id, url, keyEnc]);
    return (r.rowCount ?? 0) > 0;
  }

  async getLiveTarget(id: string): Promise<{ url: string; keyEnc: string } | null> {
    const r = await this.db.query<{ live_rtmp_url: string | null; live_rtmp_key_enc: string | null }>('SELECT live_rtmp_url, live_rtmp_key_enc FROM channels WHERE telegram_channel_id = $1', [id]);
    const row = r.rows[0];
    return row?.live_rtmp_url && row.live_rtmp_key_enc ? { url: row.live_rtmp_url, keyEnc: row.live_rtmp_key_enc } : null;
  }

  async setOwner(id: string, accountId: string | null): Promise<boolean> {
    return ((await this.db.query('UPDATE channels SET owner_account_id = $2, updated_at = now() WHERE telegram_channel_id = $1', [id, accountId])).rowCount ?? 0) > 0;
  }

  async ownedBy(accountId: string): Promise<ChannelRow[]> {
    return (await this.db.query<Row>(`SELECT ${COLS} FROM channels WHERE owner_account_id = $1 ORDER BY created_at`, [accountId])).rows.map(map);
  }

  async setLiveStatus(id: string, status: LiveStatus, error: string | null = null): Promise<void> {
    await this.db.query('UPDATE channels SET live_status = $2, live_error = $3, updated_at = now() WHERE telegram_channel_id = $1', [id, status, error]);
  }
}
