import { RadioConfigRepository, RadioConfigWithMeta } from '../application/ports/radio-config.repository';
import { Injectable } from '@nestjs/common';
import { TxHandle } from '../../shared/kernel/transaction';
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

  async lock(tx: TxHandle, channelId: string): Promise<number | null> {
    const r = await (tx as Queryable).query<{ version: number }>('SELECT version FROM radio_configuration WHERE channel_id = $1 FOR UPDATE', [channelId]);
    return r.rows[0]?.version ?? null;
  }

  async hashtagIds(tx: TxHandle, tags: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(tags)];
    if (unique.length === 0) return new Map();
    const r = await (tx as Queryable).query<{ id: string; normalized_value: string }>('SELECT id, normalized_value FROM hashtags WHERE normalized_value = ANY($1::text[])', [unique]);
    return new Map(r.rows.map((x) => [x.normalized_value, x.id]));
  }

  async updateSettings(tx: TxHandle, channelId: string, s: { mode: string; hashtagMatchMode: string; recentTrackWindow: number; fallbackToGlobal: boolean; enabled: boolean }, actor: string): Promise<void> {
    await (tx as Queryable).query(
      `UPDATE radio_configuration SET mode=$1, hashtag_match_mode=$2, recent_track_window=$3, fallback_to_global=$4, enabled=$5,
              version = version + 1, updated_by=$6, updated_at=now() WHERE channel_id = $7`,
      [s.mode, s.hashtagMatchMode, s.recentTrackWindow, s.fallbackToGlobal, s.enabled, actor, channelId],
    );
  }

  async replaceHashtagSelection(tx: TxHandle, channelId: string, entries: readonly { hashtagId: string; weight: number }[]): Promise<void> {
    const q = tx as Queryable;
    await q.query('DELETE FROM radio_hashtag_selection WHERE channel_id = $1', [channelId]);
    for (const [i, e] of entries.entries()) {
      await q.query('INSERT INTO radio_hashtag_selection (channel_id, hashtag_id, weight, position) VALUES ($1,$2,$3,$4) ON CONFLICT (channel_id, hashtag_id) DO UPDATE SET weight=$3, position=$4', [channelId, e.hashtagId, e.weight, i]);
    }
  }

  async bumpVersion(tx: TxHandle, channelId: string, actor: string): Promise<void> {
    await (tx as Queryable).query('UPDATE radio_configuration SET version = version + 1, updated_by = $1, updated_at = now() WHERE channel_id = $2', [actor, channelId]);
  }

  async insertRule(tx: TxHandle, channelId: string, r: { name: string; priority: number; matchMode: string; weight: number; enabled: boolean }): Promise<string> {
    const res = await (tx as Queryable).query<{ id: string }>('INSERT INTO radio_rules (channel_id, name, priority, match_mode, weight, enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [channelId, r.name, r.priority, r.matchMode, r.weight, r.enabled]);
    return res.rows[0]?.id ?? '';
  }

  async updateRule(tx: TxHandle, channelId: string, ruleId: string, r: { name: string; priority: number; matchMode: string; weight: number; enabled: boolean }): Promise<void> {
    await (tx as Queryable).query('UPDATE radio_rules SET name=$3, priority=$4, match_mode=$5, weight=$6, enabled=$7, updated_at=now() WHERE id=$1 AND channel_id=$2', [ruleId, channelId, r.name, r.priority, r.matchMode, r.weight, r.enabled]);
  }

  async replaceRuleHashtags(tx: TxHandle, ruleId: string, tags: readonly { hashtagId: string; kind: 'INCLUDE' | 'EXCLUDE' }[]): Promise<void> {
    const q = tx as Queryable;
    await q.query('DELETE FROM radio_rule_hashtags WHERE rule_id = $1', [ruleId]);
    for (const t of tags) await q.query('INSERT INTO radio_rule_hashtags (rule_id, hashtag_id, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ruleId, t.hashtagId, t.kind]);
  }

  async deleteRule(tx: TxHandle, channelId: string, ruleId: string): Promise<void> {
    await (tx as Queryable).query('DELETE FROM radio_rules WHERE id = $1 AND channel_id = $2', [ruleId, channelId]);
  }
}
