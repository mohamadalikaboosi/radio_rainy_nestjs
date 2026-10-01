import { RadioConfigRepository, RadioConfigWithMeta } from '../application/ports/radio-config.repository';
import { Injectable } from '@nestjs/common';
import { DatabaseService, Queryable } from '../../shared/infrastructure/database/database.service';
import { HashtagMatchMode, HashtagSelection, RadioMode, RadioRuleSnapshot, TrackCandidate } from '../domain/radio.types';

@Injectable()
export class PgRadioConfigRepository implements RadioConfigRepository {
  constructor(private readonly db: DatabaseService) {}

  async getSnapshot(channelId: string, q: Queryable = this.db): Promise<RadioConfigWithMeta> {
    const cfg = (
      await q.query<{ mode: RadioMode; hashtag_match_mode: HashtagMatchMode; recent_track_window: number; fallback_to_global: boolean; enabled: boolean; version: number }>(
        'SELECT mode, hashtag_match_mode, recent_track_window, fallback_to_global, enabled, version FROM radio_configuration WHERE channel_id = $1',
        [channelId],
      )
    ).rows[0];
    if (!cfg) throw new Error(`radio_configuration row missing for channel ${channelId}`);

    const hashtags = (
      await q.query<{ normalized_value: string; weight: number }>(
        `SELECT h.normalized_value, s.weight FROM radio_hashtag_selection s JOIN hashtags h ON h.id = s.hashtag_id WHERE s.channel_id = $1 ORDER BY s.position, h.normalized_value`,
        [channelId],
      )
    ).rows.map<HashtagSelection>((r) => ({ hashtag: r.normalized_value, weight: r.weight }));

    const ruleRows = (
      await q.query<{ id: string; name: string; priority: number; match_mode: HashtagMatchMode; weight: number; enabled: boolean; kind: 'INCLUDE' | 'EXCLUDE' | null; normalized_value: string | null }>(
        `SELECT r.id, r.name, r.priority, r.match_mode, r.weight, r.enabled, rh.kind, h.normalized_value
           FROM radio_rules r
           LEFT JOIN radio_rule_hashtags rh ON rh.rule_id = r.id
           LEFT JOIN hashtags h ON h.id = rh.hashtag_id
         WHERE r.channel_id = $1
          ORDER BY r.priority, r.id`,
        [channelId],
      )
    ).rows;
    const rules = new Map<string, { rule: RadioRuleSnapshot; include: string[]; exclude: string[] }>();
    for (const r of ruleRows) {
      let entry = rules.get(r.id);
      if (!entry) {
        entry = { rule: { id: r.id, name: r.name, priority: r.priority, matchMode: r.match_mode, weight: r.weight, enabled: r.enabled, include: [], exclude: [] }, include: [], exclude: [] };
        rules.set(r.id, entry);
      }
      if (r.normalized_value) (r.kind === 'EXCLUDE' ? entry.exclude : entry.include).push(r.normalized_value);
    }

    return {
      enabled: cfg.enabled,
      version: cfg.version,
      snapshot: {
        mode: cfg.mode,
        hashtagMatchMode: cfg.hashtag_match_mode,
        recentTrackWindow: cfg.recent_track_window,
        hashtags,
        fallbackToGlobal: cfg.fallback_to_global,
        rules: [...rules.values()].map((e) => ({ ...e.rule, include: e.include, exclude: e.exclude })),
      },
    };
  }

  /** Eligibility base set: enabled + audio READY + still on Telegram. Hashtag matching is the engine's job. */
  async loadCandidates(channelId: string, q: Queryable = this.db): Promise<TrackCandidate[]> {
    const r = await q.query<{ id: string; hashtags: string[] }>(
      `SELECT t.id, COALESCE(array_agg(h.normalized_value) FILTER (WHERE h.id IS NOT NULL), '{}') AS hashtags
         FROM tracks t
         LEFT JOIN track_hashtags th ON th.track_id = t.id
         LEFT JOIN hashtags h ON h.id = th.hashtag_id
        WHERE t.telegram_channel_id = $1 AND t.status = 'READY' AND t.enabled AND t.deleted_at IS NULL
        GROUP BY t.id`,
      [channelId],
    );
    return r.rows.map((x) => ({ id: x.id, hashtags: x.hashtags }));
  }

  /** Applies the env default only while nobody has configured the radio yet. */
  async applyDefaultWindow(channelId: string, window: number): Promise<void> {
    await this.db.query('UPDATE radio_configuration SET recent_track_window = $2 WHERE channel_id = $1 AND updated_by IS NULL', [channelId, window]);
  }
}
