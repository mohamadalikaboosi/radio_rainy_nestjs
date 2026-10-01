import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';

import type { CampaignStatus } from '../../accounts/domain/campaign-status';

/** What the ad engine needs to know about money; while billing is off nothing is ever charged or blocked. */
export interface BillingRule {
  enabled: boolean;
  pricePerPlayCents: number;
  pricePerClickCents: number;
}
const NO_BILLING: BillingRule = { enabled: false, pricePerPlayCents: 0, pricePerClickCents: 0 };

export interface AdSummary {
  id: string;
  channelId: string | null;
  accountId: string | null;
  status: CampaignStatus;
  reviewNote: string | null;
  startsAt: string | null;
  endsAt: string | null;
  maxPlays: number | null;
  name: string;
  weight: number;
  enabled: boolean;
  linkUrl: string | null;
  ctaLabel: string | null;
  hasAudio: boolean;
  audioMime: string | null;
  audioSize: number | null;
  durationSeconds: number | null;
  hasImage: boolean;
  plays: number;
  clicks: number;
  lastPlayedAt: string | null;
  createdAt: string;
}

export interface AdInput {
  channelId: string | null;
  name: string;
  weight: number;
  enabled: boolean;
  linkUrl: string | null;
  ctaLabel: string | null;
}

export interface AdAudio {
  id: string;
  name: string;
  data: Buffer;
  mime: string;
  bytesPerSec: number | null;
  linkUrl: string | null;
  ctaLabel: string | null;
  hasImage: boolean;
  durationSeconds: number | null;
}

interface Row {
  id: string;
  channel_id: string | null;
  account_id: string | null;
  status: CampaignStatus;
  review_note: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  max_plays: number | null;
  name: string;
  weight: number;
  enabled: boolean;
  link_url: string | null;
  cta_label: string | null;
  audio_mime: string | null;
  audio_size: number | null;
  duration_seconds: number | null;
  has_audio: boolean;
  has_image: boolean;
  plays: number;
  clicks: number;
  last_played_at: Date | null;
  created_at: Date;
}

const SUMMARY_COLUMNS = `id, channel_id, account_id, status, review_note, starts_at, ends_at, max_plays, name, weight, enabled, link_url, cta_label, audio_mime, audio_size, duration_seconds,
  (audio IS NOT NULL) AS has_audio, (image IS NOT NULL) AS has_image, plays, clicks, last_played_at, created_at`;

const toSummary = (r: Row): AdSummary => ({
  id: r.id,
  channelId: r.channel_id,
  accountId: r.account_id,
  status: r.status,
  reviewNote: r.review_note,
  startsAt: r.starts_at?.toISOString() ?? null,
  endsAt: r.ends_at?.toISOString() ?? null,
  maxPlays: r.max_plays,
  name: r.name,
  weight: r.weight,
  enabled: r.enabled,
  linkUrl: r.link_url,
  ctaLabel: r.cta_label,
  hasAudio: r.has_audio,
  audioMime: r.audio_mime,
  audioSize: r.audio_size,
  durationSeconds: r.duration_seconds,
  hasImage: r.has_image,
  plays: r.plays,
  clicks: r.clicks,
  lastPlayedAt: r.last_played_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

/** Never selects the audio/image blobs except where a method says so. */
@Injectable()
export class AdsRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(channelId?: string): Promise<AdSummary[]> {
    const r = await this.db.query<Row>(`SELECT ${SUMMARY_COLUMNS} FROM ads WHERE ($1::bigint IS NULL OR channel_id IS NULL OR channel_id = $1) ORDER BY created_at DESC`, [channelId ?? null]);
    return r.rows.map(toSummary);
  }

  async get(id: string): Promise<AdSummary | null> {
    const r = await this.db.query<Row>(`SELECT ${SUMMARY_COLUMNS} FROM ads WHERE id = $1`, [id]);
    return r.rows[0] ? toSummary(r.rows[0]) : null;
  }

  async create(input: AdInput): Promise<AdSummary> {
    const r = await this.db.query<Row>(
      `INSERT INTO ads (channel_id, name, weight, enabled, link_url, cta_label) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SUMMARY_COLUMNS}`,
      [input.channelId, input.name, input.weight, input.enabled, input.linkUrl, input.ctaLabel],
    );
    return toSummary(r.rows[0] as Row);
  }

  async update(id: string, input: Partial<AdInput>): Promise<AdSummary | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    const m = { ...cur, ...input };
    const r = await this.db.query<Row>(
      `UPDATE ads SET channel_id = $2, name = $3, weight = $4, enabled = $5, link_url = $6, cta_label = $7, updated_at = now() WHERE id = $1 RETURNING ${SUMMARY_COLUMNS}`,
      [id, m.channelId, m.name, m.weight, m.enabled, m.linkUrl, m.ctaLabel],
    );
    return r.rows[0] ? toSummary(r.rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM ads WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }

  async setAudio(id: string, data: Buffer, mime: string, bytesPerSec: number | null, durationSeconds: number | null): Promise<boolean> {
    const r = await this.db.query('UPDATE ads SET audio = $2, audio_mime = $3, audio_size = $4, bytes_per_sec = $5, duration_seconds = $6, updated_at = now() WHERE id = $1', [id, data, mime, data.length, bytesPerSec, durationSeconds]);
    return (r.rowCount ?? 0) > 0;
  }

  async setImage(id: string, data: Buffer | null, mime: string | null): Promise<boolean> {
    const r = await this.db.query('UPDATE ads SET image = $2, image_mime = $3, updated_at = now() WHERE id = $1', [id, data, mime]);
    return (r.rowCount ?? 0) > 0;
  }

  async image(id: string): Promise<{ data: Buffer; mime: string } | null> {
    const r = await this.db.query<{ image: Buffer | null; image_mime: string | null }>('SELECT image, image_mime FROM ads WHERE id = $1', [id]);
    const row = r.rows[0];
    return row?.image && row.image_mime ? { data: row.image, mime: row.image_mime } : null;
  }

  /**
   * Ads that may go on air on this station right now: enabled, with audio, APPROVED, inside their dates and play cap, owner active and
   * (only when billing is on) with enough credit for one more play. Admin-created ads have no owner and are never money-gated.
   */
  async playableIds(channelId: string, billing: BillingRule = NO_BILLING): Promise<{ id: string; weight: number }[]> {
    const r = await this.db.query<{ id: string; weight: number }>(
      `SELECT a.id, a.weight FROM ads a LEFT JOIN accounts ac ON ac.id = a.account_id
        WHERE a.enabled AND a.audio IS NOT NULL AND a.status = 'APPROVED'
          AND (a.channel_id IS NULL OR a.channel_id = $1)
          AND (a.starts_at IS NULL OR a.starts_at <= now()) AND (a.ends_at IS NULL OR a.ends_at > now())
          AND (a.max_plays IS NULL OR a.plays < a.max_plays)
          AND (a.account_id IS NULL OR ac.status = 'ACTIVE')
          AND (a.account_id IS NULL OR NOT $2::boolean OR ac.credit_cents >= $3)`,
      [channelId, billing.enabled, billing.pricePerPlayCents],
    );
    return r.rows;
  }

  async audio(id: string): Promise<AdAudio | null> {
    const r = await this.db.query<{ id: string; name: string; audio: Buffer; audio_mime: string; bytes_per_sec: number | null; link_url: string | null; cta_label: string | null; has_image: boolean; duration_seconds: number | null }>(
      `SELECT id, name, audio, audio_mime, bytes_per_sec, link_url, cta_label, (image IS NOT NULL) AS has_image, duration_seconds FROM ads WHERE id = $1 AND audio IS NOT NULL`,
      [id],
    );
    const a = r.rows[0];
    return a ? { id: a.id, name: a.name, data: a.audio, mime: a.audio_mime, bytesPerSec: a.bytes_per_sec, linkUrl: a.link_url, ctaLabel: a.cta_label, hasImage: a.has_image, durationSeconds: a.duration_seconds } : null;
  }

  /** Counts the play and, when billing is on and the ad belongs to an account, charges it (one transaction). */
  async recordPlay(id: string, billing: BillingRule = NO_BILLING): Promise<void> {
    await this.db.tx(async (q) => {
      const r = await q.query<{ account_id: string | null }>('UPDATE ads SET plays = plays + 1, last_played_at = now() WHERE id = $1 RETURNING account_id', [id]);
      const accountId = r.rows[0]?.account_id;
      if (billing.enabled && accountId && billing.pricePerPlayCents > 0) await this.charge(q, accountId, billing.pricePerPlayCents, 'PLAY', id);
    });
  }

  /** Public view data for the ad on air (no blobs). */
  async onAir(id: string): Promise<{ id: string; name: string; linkUrl: string | null; ctaLabel: string | null; hasImage: boolean; durationSeconds: number | null } | null> {
    const a = await this.get(id);
    return a ? { id: a.id, name: a.name, linkUrl: a.linkUrl, ctaLabel: a.ctaLabel, hasImage: a.hasImage, durationSeconds: a.durationSeconds } : null;
  }

  /** Counts a click (charging the owner when billing is on) and returns the target: only ever an http(s) URL chosen by the advertiser/admin. */
  async click(id: string, billing: BillingRule = NO_BILLING): Promise<string | null> {
    return this.db.tx(async (q) => {
      const r = await q.query<{ link_url: string | null; account_id: string | null }>('UPDATE ads SET clicks = clicks + 1 WHERE id = $1 RETURNING link_url, account_id', [id]);
      const row = r.rows[0];
      if (row && billing.enabled && row.account_id && billing.pricePerClickCents > 0) await this.charge(q, row.account_id, billing.pricePerClickCents, 'CLICK', id);
      return row?.link_url ?? null;
    });
  }

  private async charge(q: Pick<DatabaseService, 'query'>, accountId: string, cents: number, kind: 'PLAY' | 'CLICK', adId: string): Promise<void> {
    const b = await q.query<{ credit_cents: string }>('UPDATE accounts SET credit_cents = credit_cents - $2 WHERE id = $1 RETURNING credit_cents', [accountId, cents]);
    if (b.rows[0]) await q.query('INSERT INTO credit_ledger (account_id, amount_cents, balance_after, kind, ref_id) VALUES ($1, $2, $3, $4, $5)', [accountId, -cents, Number(b.rows[0].credit_cents), kind, adId]);
  }

  // ---- campaigns (ads owned by an account) ----

  async listByAccount(accountId: string): Promise<AdSummary[]> {
    const r = await this.db.query<Row>(`SELECT ${SUMMARY_COLUMNS} FROM ads WHERE account_id = $1 ORDER BY created_at DESC`, [accountId]);
    return r.rows.map(toSummary);
  }

  async countByAccount(accountId: string): Promise<number> {
    return Number((await this.db.query<{ n: string }>('SELECT count(*) AS n FROM ads WHERE account_id = $1', [accountId])).rows[0]?.n ?? 0);
  }

  async listForReview(status?: CampaignStatus): Promise<(AdSummary & { accountName: string })[]> {
    const r = await this.db.query<Row & { account_name: string }>(
      `SELECT x.*, ac.name AS account_name
         FROM (SELECT ${SUMMARY_COLUMNS}, submitted_at FROM ads WHERE account_id IS NOT NULL AND ($1::text IS NULL OR status = $1)) x
         JOIN accounts ac ON ac.id = x.account_id
        ORDER BY x.submitted_at DESC NULLS LAST, x.created_at DESC`,
      [status ?? null],
    );
    return r.rows.map((x) => ({ ...toSummary(x), accountName: x.account_name }));
  }

  async createCampaign(accountId: string, input: { name: string; channelId: string | null; linkUrl: string | null; ctaLabel: string | null; startsAt: string | null; endsAt: string | null; maxPlays: number | null }): Promise<AdSummary> {
    const r = await this.db.query<Row>(
      `INSERT INTO ads (account_id, status, channel_id, name, link_url, cta_label, starts_at, ends_at, max_plays) VALUES ($1, 'DRAFT', $2, $3, $4, $5, $6, $7, $8) RETURNING ${SUMMARY_COLUMNS}`,
      [accountId, input.channelId, input.name, input.linkUrl, input.ctaLabel, input.startsAt, input.endsAt, input.maxPlays],
    );
    return toSummary(r.rows[0] as Row);
  }

  async updateCampaign(id: string, patch: { name?: string; channelId?: string | null; linkUrl?: string | null; ctaLabel?: string | null; startsAt?: string | null; endsAt?: string | null; maxPlays?: number | null }): Promise<AdSummary | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    const m = { ...cur, ...patch };
    const r = await this.db.query<Row>(
      `UPDATE ads SET name = $2, channel_id = $3, link_url = $4, cta_label = $5, starts_at = $6, ends_at = $7, max_plays = $8, updated_at = now() WHERE id = $1 RETURNING ${SUMMARY_COLUMNS}`,
      [id, m.name, m.channelId, m.linkUrl, m.ctaLabel, m.startsAt, m.endsAt, m.maxPlays],
    );
    return r.rows[0] ? toSummary(r.rows[0]) : null;
  }

  async setStatus(id: string, status: CampaignStatus, note: string | null): Promise<AdSummary | null> {
    const r = await this.db.query<Row>(
      `UPDATE ads SET status = $2, review_note = $3, submitted_at = CASE WHEN $2 = 'PENDING' THEN now() ELSE submitted_at END, updated_at = now() WHERE id = $1 RETURNING ${SUMMARY_COLUMNS}`,
      [id, status, note],
    );
    return r.rows[0] ? toSummary(r.rows[0]) : null;
  }
}
