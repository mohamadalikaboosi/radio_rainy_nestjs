import { RadioStateRepository, RadioStateRow } from '../application/ports/radio-state.repository';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { RadioStatus } from '../domain/radio.types';

interface Row {
  status: RadioStatus;
  status_reason: string | null;
  current_track_id: string | null;
  current_history_id: string | null;
  started_at: Date | null;
  next_track_id: string | null;
  rotation_cursor: number;
  configuration_version: number;
  transition_seq: string;
  ad_id: string | null;
  ad_started_at: Date | null;
}

/** Per-station playback state. Every method is scoped by the Telegram channel id. */
@Injectable()
export class PgRadioStateRepository implements RadioStateRepository {
  constructor(private readonly db: DatabaseService) {}

  async get(channelId: string): Promise<RadioStateRow> {
    const r = (
      await this.db.query<Row>(
        `SELECT s.status, s.status_reason, s.current_track_id, s.current_history_id, s.started_at, s.next_track_id, s.rotation_cursor,
                c.version AS configuration_version, s.transition_seq, s.ad_id, s.ad_started_at
           FROM radio_state s JOIN radio_configuration c ON c.channel_id = s.channel_id WHERE s.channel_id = $1`,
        [channelId],
      )
    ).rows[0];
    if (!r) throw new Error(`radio_state row missing for channel ${channelId}`);
    return {
      status: r.status,
      statusReason: r.status_reason,
      currentTrackId: r.current_track_id,
      currentHistoryId: r.current_history_id,
      startedAt: r.started_at,
      nextTrackId: r.next_track_id,
      rotationCursor: r.rotation_cursor,
      configurationVersion: r.configuration_version,
      transitionSeq: Number(r.transition_seq),
      adId: r.ad_id,
      adStartedAt: r.ad_started_at,
    };
  }

  /** Marks a new track as playing and bumps transition_seq (the optimistic token for skip / play-next). */
  async beginTrack(channelId: string, trackId: string, historyId: string, startedAt: Date): Promise<number> {
    const r = await this.db.query<{ transition_seq: string }>(
      `UPDATE radio_state SET status = 'PLAYING', status_reason = NULL, current_track_id = $2, current_history_id = $3, started_at = $4,
              transition_seq = transition_seq + 1, ad_id = NULL, ad_started_at = NULL, updated_at = now() WHERE channel_id = $1 RETURNING transition_seq`,
      [channelId, trackId, historyId, startedAt],
    );
    return Number(r.rows[0]?.transition_seq ?? 0);
  }

  async setStatus(channelId: string, status: RadioStatus, reason: string | null): Promise<void> {
    await this.db.query(
      `UPDATE radio_state SET status = $2, status_reason = $3,
              current_track_id = CASE WHEN $2 = 'PLAYING' THEN current_track_id ELSE NULL END,
              current_history_id = CASE WHEN $2 = 'PLAYING' THEN current_history_id ELSE NULL END,
              started_at = CASE WHEN $2 = 'PLAYING' THEN started_at ELSE NULL END,
              next_track_id = CASE WHEN $2 = 'PLAYING' THEN next_track_id ELSE NULL END, updated_at = now() WHERE channel_id = $1`,
      [channelId, status, reason],
    );
  }

  /** An ad is on air (the public API reports it instead of the track). */
  async setAd(channelId: string, adId: string | null, startedAt: Date | null): Promise<void> {
    await this.db.query('UPDATE radio_state SET ad_id = $2, ad_started_at = $3, updated_at = now() WHERE channel_id = $1', [channelId, adId, startedAt]);
  }

  async setNext(channelId: string, trackId: string | null): Promise<void> {
    await this.db.query('UPDATE radio_state SET next_track_id = $2, updated_at = now() WHERE channel_id = $1', [channelId, trackId]);
  }

  async setRotationCursor(channelId: string, cursor: number): Promise<void> {
    await this.db.query('UPDATE radio_state SET rotation_cursor = $2 WHERE channel_id = $1', [channelId, cursor]);
  }
}
