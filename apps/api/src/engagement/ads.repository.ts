import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface AdSummary {
  id: string;
  channelId: string | null;
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

const SUMMARY_COLUMNS = `id, channel_id, name, weight, enabled, link_url, cta_label, audio_mime, audio_size, duration_seconds,
  (audio IS NOT NULL) AS has_audio, (image IS NOT NULL) AS has_image, plays, clicks, last_played_at, created_at`;

const toSummary = (r: Row): AdSummary => ({
  id: r.id,
  channelId: r.channel_id,
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

  /** Enabled ads with audio that may play on this station. Used by the engine. */
  async playableIds(channelId: string): Promise<{ id: string; weight: number }[]> {
    const r = await this.db.query<{ id: string; weight: number }>(`SELECT id, weight FROM ads WHERE enabled AND audio IS NOT NULL AND (channel_id IS NULL OR channel_id = $1)`, [channelId]);
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

  async recordPlay(id: string): Promise<void> {
    await this.db.query('UPDATE ads SET plays = plays + 1, last_played_at = now() WHERE id = $1', [id]);
  }

  /** Public view data for the ad on air (no blobs). */
  async onAir(id: string): Promise<{ id: string; name: string; linkUrl: string | null; ctaLabel: string | null; hasImage: boolean; durationSeconds: number | null } | null> {
    const a = await this.get(id);
    return a ? { id: a.id, name: a.name, linkUrl: a.linkUrl, ctaLabel: a.ctaLabel, hasImage: a.hasImage, durationSeconds: a.durationSeconds } : null;
  }

  /** Counts a click and returns the target (only ever an http(s) URL chosen by the admin). */
  async click(id: string): Promise<string | null> {
    const r = await this.db.query<{ link_url: string | null }>('UPDATE ads SET clicks = clicks + 1 WHERE id = $1 RETURNING link_url', [id]);
    return r.rows[0]?.link_url ?? null;
  }
}
