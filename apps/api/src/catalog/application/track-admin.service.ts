import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LyricsPipeline } from '../../lyrics/application/lyrics-pipeline';
import { LyricsRepository } from '../../lyrics/application/ports/lyrics.repository';
import { TelegramTrackDiscovery } from './track-discovery';
import { TrackRepository } from './ports/track.repository';
import { ActorContext } from '../../radio/application/radio-configuration.service';
import { AuditService } from '../../administration/application/ports/audit.service';

@Injectable()
export class TrackAdminService {
  constructor(
    private readonly tracks: TrackRepository,
    private readonly lyrics: LyricsRepository,
    private readonly pipeline: LyricsPipeline,
    private readonly discovery: TelegramTrackDiscovery,
    private readonly audit: AuditService,
  ) {}

  async detail(id: string): Promise<unknown> {
    const track = await this.tracks.findById(id);
    if (!track) throw new NotFoundException('Track not found');
    const [hashtags, lyrics, synced, x] = await Promise.all([this.tracks.hashtagsOf(id), this.lyrics.getLyrics(id), this.lyrics.getLatestSynced(id), this.tracks.adminExtra(id)]);
    return {
      ...track,
      captionRaw: x?.captionRaw ?? null,
      lyricsError: x?.lyricsError ?? null,
      deletedAt: x?.deletedAt ?? null,
      consecutiveFailures: x?.consecutiveFailures ?? 0,
      hashtags,
      lyrics: lyrics ? { sourceUrl: lyrics.sourceUrl, status: lyrics.status, error: lyrics.error, rawText: lyrics.rawText, fetchedAt: lyrics.fetchedAt } : null,
      syncedLyrics: synced ? { version: synced.version, quality: synced.quality, algorithmVersion: synced.algorithmVersion, lines: synced.lines, createdAt: synced.createdAt } : null,
    };
  }

  /** Idempotent and race-safe: a single conditional UPDATE decides whether anything changed. */
  async setEnabled(id: string, enabled: boolean, ctx: ActorContext): Promise<{ id: string; enabled: boolean; changed: boolean }> {
    if (!(await this.tracks.setEnabled(id, enabled))) {
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
    const res = await this.discovery.refreshMessage(track.telegramChannelId, track.telegramMessageId);
    if (!res) {
      await this.tracks.markDeleted(id);
    }
    const outcome = res?.outcome ?? 'unavailable';
    await this.audit.record({ actor: ctx.actor, action: 'track.refresh-metadata', entityType: 'track', entityId: id, after: { outcome }, requestId: ctx.requestId });
    return { outcome };
  }
}
