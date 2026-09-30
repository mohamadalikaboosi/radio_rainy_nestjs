import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Sponsor {
  id: string;
  channelId: string | null;
  name: string;
  tagline: string | null;
  url: string;
  ctaLabel: string;
  hasLogo: boolean;
  weight: number;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  impressions: number;
  clicks: number;
}

export interface SponsorInput {
  channelId: string | null;
  name: string;
  tagline: string | null;
  url: string;
  ctaLabel: string;
  weight: number;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

interface Row {
  id: string;
  channel_id: string | null;
  name: string;
  tagline: string | null;
  url: string;
  cta_label: string;
  has_logo: boolean;
  weight: number;
  enabled: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  impressions: number;
  clicks: number;
}

const COLS = 'id, channel_id, name, tagline, url, cta_label, (logo IS NOT NULL) AS has_logo, weight, enabled, starts_at, ends_at, impressions, clicks';
const toSponsor = (r: Row): Sponsor => ({
  id: r.id,
  channelId: r.channel_id,
  name: r.name,
  tagline: r.tagline,
  url: r.url,
  ctaLabel: r.cta_label,
  hasLogo: r.has_logo,
  weight: r.weight,
  enabled: r.enabled,
  startsAt: r.starts_at?.toISOString() ?? null,
  endsAt: r.ends_at?.toISOString() ?? null,
  impressions: r.impressions,
  clicks: r.clicks,
});

@Injectable()
export class SponsorsRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(channelId?: string): Promise<Sponsor[]> {
    const r = await this.db.query<Row>(`SELECT ${COLS} FROM sponsors WHERE ($1::bigint IS NULL OR channel_id IS NULL OR channel_id = $1) ORDER BY created_at DESC`, [channelId ?? null]);
    return r.rows.map(toSponsor);
  }

  async get(id: string): Promise<Sponsor | null> {
    const r = await this.db.query<Row>(`SELECT ${COLS} FROM sponsors WHERE id = $1`, [id]);
    return r.rows[0] ? toSponsor(r.rows[0]) : null;
  }

  async create(i: SponsorInput): Promise<Sponsor> {
    const r = await this.db.query<Row>(
      `INSERT INTO sponsors (channel_id, name, tagline, url, cta_label, weight, enabled, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
      [i.channelId, i.name, i.tagline, i.url, i.ctaLabel, i.weight, i.enabled, i.startsAt, i.endsAt],
    );
    return toSponsor(r.rows[0] as Row);
  }

  async update(id: string, patch: Partial<SponsorInput>): Promise<Sponsor | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    const m = { ...cur, ...patch };
    const r = await this.db.query<Row>(
      `UPDATE sponsors SET channel_id=$2, name=$3, tagline=$4, url=$5, cta_label=$6, weight=$7, enabled=$8, starts_at=$9, ends_at=$10, updated_at=now() WHERE id=$1 RETURNING ${COLS}`,
      [id, m.channelId, m.name, m.tagline, m.url, m.ctaLabel, m.weight, m.enabled, m.startsAt, m.endsAt],
    );
    return r.rows[0] ? toSponsor(r.rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM sponsors WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }

  async setLogo(id: string, data: Buffer | null, mime: string | null): Promise<boolean> {
    return ((await this.db.query('UPDATE sponsors SET logo = $2, logo_mime = $3, updated_at = now() WHERE id = $1', [id, data, mime])).rowCount ?? 0) > 0;
  }

  async logo(id: string): Promise<{ data: Buffer; mime: string } | null> {
    const r = await this.db.query<{ logo: Buffer | null; logo_mime: string | null }>('SELECT logo, logo_mime FROM sponsors WHERE id = $1', [id]);
    const row = r.rows[0];
    return row?.logo && row.logo_mime ? { data: row.logo, mime: row.logo_mime } : null;
  }

  /** Sponsors to show right now on a station. */
  async active(channelId: string, now = new Date()): Promise<Sponsor[]> {
    const r = await this.db.query<Row>(
      `SELECT ${COLS} FROM sponsors WHERE enabled AND (channel_id IS NULL OR channel_id = $1) AND (starts_at IS NULL OR starts_at <= $2) AND (ends_at IS NULL OR ends_at > $2) ORDER BY created_at`,
      [channelId, now],
    );
    return r.rows.map(toSponsor);
  }

  async recordImpressions(ids: string[]): Promise<void> {
    if (ids.length > 0) await this.db.query('UPDATE sponsors SET impressions = impressions + 1 WHERE id = ANY($1::uuid[])', [ids]);
  }

  async click(id: string): Promise<string | null> {
    const r = await this.db.query<{ url: string }>('UPDATE sponsors SET clicks = clicks + 1 WHERE id = $1 RETURNING url', [id]);
    return r.rows[0]?.url ?? null;
  }
}
