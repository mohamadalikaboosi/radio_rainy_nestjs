import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LyricsPipeline } from '../jobs/lyrics-pipeline';
import { LyricsRepository } from '../lyrics/lyrics.repository';
import { TelegramTrackDiscovery } from '../telegram/track-discovery';
import { TrackRepository } from '../track/track.repository';
import { ActorContext } from '../radio/radio-configuration.service';
import { AuditService } from './audit.service';

@Injectable()
export class TrackAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tracks: TrackRepository,
    private readonly lyrics: LyricsRepository,
    private readonly pipeline: LyricsPipeline,
    private readonly discovery: TelegramTrackDiscovery,
    private readonly audit: AuditService,
  ) {}

  async detail(id: string): Promise<unknown> {
    const track = await this.tracks.findById(id);
    if (!track) throw new NotFoundException('Track not found');
    const [hashtags, lyrics, synced, extra] = await Promise.all([
      this.db.query<{ value: string; normalized_value: string }>('SELECT h.value, h.normalized_value FROM track_hashtags th JOIN hashtags h ON h.id = th.hashtag_id WHERE th.track_id = $1 ORDER BY h.normalized_value', [id]),
      this.lyrics.getLyrics(id),
      this.lyrics.getLatestSynced(id),
      this.db.query<{ caption_raw: string | null; lyrics_error: string | null; deleted_at: Date | null; consecutive_failures: number }>('SELECT caption_raw, lyrics_error, deleted_at, consecutive_failures FROM tracks WHERE id = $1', [id]),
    ]);
    const x = extra.rows[0];
    return {
      ...track,
      captionRaw: x?.caption_raw ?? null,
      lyricsError: x?.lyrics_error ?? null,
      deletedAt: x?.deleted_at ?? null,
      consecutiveFailures: x?.consecutive_failures ?? 0,
      hashtags: hashtags.rows.map((h) => ({ value: h.value, normalized: h.normalized_value })),
      lyrics: lyrics ? { sourceUrl: lyrics.sourceUrl, status: lyrics.status, error: lyrics.error, rawText: lyrics.rawText, fetchedAt: lyrics.fetchedAt } : null,
      syncedLyrics: synced ? { version: synced.version, quality: synced.quality, algorithmVersion: synced.algorithmVersion, lines: synced.lines, createdAt: synced.createdAt } : null,
    };
  }

  /** Idempotent and race-safe: a single conditional UPDATE decides whether anything changed. */
  async setEnabled(id: string, enabled: boolean, ctx: ActorContext): Promise<{ id: string; enabled: boolean; changed: boolean }> {
    const r = await this.db.query('UPDATE tracks SET enabled = $2, updated_at = now() WHERE id = $1 AND enabled <> $2', [id, enabled]);
    if ((r.rowCount ?? 0) === 0) {
      if (!(await this.tracks.findById(id))) throw new NotFoundException('Track not found');
      return { id, enabled, changed: false };
    }
    await this.audit.record({ actor: ctx.actor, action: enabled ? 'track.enable' : 'track.disable', entityType: 'track', entityId: id, before: { enabled: !enabled }, after: { enabled }, requestId: ctx.requestId });
    return { id, enabled, changed: true };
  }

  async processLyrics(id: string, force: boolean, ctx: ActorContext): Promise<{ queued: boolean }> {
    const track = await this.tracks.findById(id);
    if (!track) throw new NotFoundException('Track not found');
    if (!track.lyricsUrl) throw new BadRequestException('Track has no lyrics URL');
    await this.pipeline.start(id, { force });
    await this.audit.record({ actor: ctx.actor, action: 'track.lyrics.process', entityType: 'track', entityId: id, after: { force, lyricsStatus: track.lyricsStatus }, requestId: ctx.requestId });
    return { queued: true };
  }

  async refreshMetadata(id: string, ctx: ActorContext): Promise<{ outcome: string }> {
    const track = await this.tracks.findById(id);
    if (!track) throw new NotFoundException('Track not found');
    const res = await this.discovery.refreshMessage(track.telegramMessageId);
    if (!res) {
      await this.db.query(`UPDATE tracks SET status = 'UNAVAILABLE', deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
    }
    const outcome = res?.outcome ?? 'unavailable';
    await this.audit.record({ actor: ctx.actor, action: 'track.refresh-metadata', entityType: 'track', entityId: id, after: { outcome }, requestId: ctx.requestId });
    return { outcome };
  }
}
