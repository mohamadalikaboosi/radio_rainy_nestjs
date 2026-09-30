import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RadioStatus } from './radio.types';

export interface RadioStateRow {
  status: RadioStatus;
  statusReason: string | null;
  currentTrackId: string | null;
  currentHistoryId: string | null;
  startedAt: Date | null;
  nextTrackId: string | null;
  rotationCursor: number;
  configurationVersion: number;
  transitionSeq: number;
}

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
}

@Injectable()
export class RadioStateRepository {
  constructor(private readonly db: DatabaseService) {}

  async get(): Promise<RadioStateRow> {
    const r = (
      await this.db.query<Row>(
        `SELECT s.status, s.status_reason, s.current_track_id, s.current_history_id, s.started_at, s.next_track_id, s.rotation_cursor,
                c.version AS configuration_version, s.transition_seq
           FROM radio_state s, radio_configuration c WHERE s.id = 1 AND c.id = 1`,
      )
    ).rows[0];
    if (!r) throw new Error('radio_state row missing');
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
    };
  }

  /** Marks a new track as playing and bumps transition_seq (the optimistic token for skip / play-next). */
  async beginTrack(trackId: string, historyId: string, startedAt: Date): Promise<number> {
    const r = await this.db.query<{ transition_seq: string }>(
      `UPDATE radio_state SET status = 'PLAYING', status_reason = NULL, current_track_id = $1, current_history_id = $2, started_at = $3,
              transition_seq = transition_seq + 1, updated_at = now() WHERE id = 1 RETURNING transition_seq`,
      [trackId, historyId, startedAt],
    );
    return Number(r.rows[0]?.transition_seq ?? 0);
  }

  async setStatus(status: RadioStatus, reason: string | null): Promise<void> {
    await this.db.query(
      `UPDATE radio_state SET status = $1, status_reason = $2,
              current_track_id = CASE WHEN $1 = 'PLAYING' THEN current_track_id ELSE NULL END,
              current_history_id = CASE WHEN $1 = 'PLAYING' THEN current_history_id ELSE NULL END,
              started_at = CASE WHEN $1 = 'PLAYING' THEN started_at ELSE NULL END,
              next_track_id = CASE WHEN $1 = 'PLAYING' THEN next_track_id ELSE NULL END, updated_at = now() WHERE id = 1`,
      [status, reason],
    );
  }

  async setNext(trackId: string | null): Promise<void> {
    await this.db.query('UPDATE radio_state SET next_track_id = $1, updated_at = now() WHERE id = 1', [trackId]);
  }

  async setRotationCursor(cursor: number): Promise<void> {
    await this.db.query('UPDATE radio_state SET rotation_cursor = $1 WHERE id = 1', [cursor]);
  }
}
