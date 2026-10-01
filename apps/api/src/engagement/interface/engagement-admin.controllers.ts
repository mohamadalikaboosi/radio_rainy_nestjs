import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard, AdminRequest } from '../../administration/interface/admin.guard';
import { AuditService } from '../../administration/application/audit.service';
import { ChannelRepository } from '../../catalog/application/ports/channel.repository';
import { ZodPipe } from '../../shared/interface/zod.pipe';
import { AdInput, AdsRepository } from '../application/ports/ads.repository';
import { EngagementSettings, EngagementSettingsRepository } from '../application/ports/engagement-settings.repository';
import { engagementSchema } from '../application/ports/engagement-settings.repository';
import { inspectMp3 } from '../domain/mp3-info';
import { isAllowedImage, isAudio, readRawBody } from './raw-body';
import { SponsorInput, SponsorsRepository } from '../application/ports/sponsors.repository';
import { TagPollRepository } from '../application/ports/tag-poll.repository';
import { TagVoteService } from '../application/tag-vote.service';

const ChannelIdPipe = new ZodPipe(z.string().regex(/^\d{1,20}$/, 'invalid channel id'));
const OptionalChannelQuery = new ZodPipe(z.object({ channelId: z.string().regex(/^\d{1,20}$/).optional() }));
const MAX_AUDIO = 10 * 1024 * 1024;
const MAX_IMAGE = 1536 * 1024;

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) link');
const channelField = z.string().regex(/^\d{1,20}$/).nullable();

const adCreate = z.object({
  channelId: channelField.default(null),
  name: z.string().trim().min(1).max(100),
  weight: z.number().int().min(1).max(100).default(1),
  enabled: z.boolean().default(true),
  linkUrl: httpUrl.nullable().default(null),
  ctaLabel: z.string().trim().max(40).nullable().default(null),
});
const adPatch = adCreate.partial();

const sponsorCreate = z.object({
  channelId: channelField.default(null),
  name: z.string().trim().min(1).max(100),
  tagline: z.string().trim().max(160).nullable().default(null),
  url: httpUrl,
  ctaLabel: z.string().trim().min(1).max(40).default('Visit'),
  weight: z.number().int().min(1).max(100).default(1),
  enabled: z.boolean().default(true),
  startsAt: z.string().datetime().nullable().default(null),
  endsAt: z.string().datetime().nullable().default(null),
});
const sponsorPatch = sponsorCreate.partial();

const actor = (req: AdminRequest): { actor: string; requestId: string | null } => ({ actor: req.admin.email, requestId: req.id === undefined ? null : String(req.id) });

@Controller('admin/ads')
@UseGuards(AdminGuard)
export class AdminAdsController {
  constructor(private readonly ads: AdsRepository, private readonly audit: AuditService) {}

  @Get()
  list(@Query(OptionalChannelQuery) q: { channelId?: string }) {
    return this.ads.list(q.channelId);
  }

  @Post()
  async create(@Body(new ZodPipe(adCreate)) body: AdInput, @Req() req: AdminRequest) {
    const ad = await this.ads.create(body);
    await this.audit.record({ ...actor(req), action: 'ad.create', entityType: 'ad', entityId: ad.id, after: ad });
    return ad;
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(adPatch)) body: Partial<AdInput>, @Req() req: AdminRequest) {
    const before = await this.ads.get(id);
    const ad = await this.ads.update(id, body);
    if (!ad) throw new NotFoundException('Unknown ad');
    await this.audit.record({ ...actor(req), action: 'ad.update', entityType: 'ad', entityId: id, before, after: ad });
    return ad;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AdminRequest): Promise<void> {
    if (!(await this.ads.remove(id))) throw new NotFoundException('Unknown ad');
    await this.audit.record({ ...actor(req), action: 'ad.delete', entityType: 'ad', entityId: id });
  }

  /** Raw upload (Content-Type: audio/*). MP3 is inspected for its bitrate/duration; other formats are transcoded live by ffmpeg. */
  @Put(':id/audio')
  async audio(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & AdminRequest) {
    const mime = String(req.headers['content-type'] ?? '');
    if (!isAudio(mime)) throw new BadRequestException('Send the file with an audio/* Content-Type');
    const data = await readRawBody(req, MAX_AUDIO);
    if (data.length === 0) throw new BadRequestException('Empty file');
    const cleanMime = mime.split(';')[0]?.trim().toLowerCase() ?? 'audio/mpeg';
    let bps: number | null = null;
    let duration: number | null = null;
    if (/^audio\/(mpeg|mp3|mpeg3|x-mpeg-3)$/.test(cleanMime)) {
      const info = inspectMp3(data);
      if (!info) throw new BadRequestException('Not a valid MP3 file');
      bps = info.bytesPerSec;
      duration = Math.round(info.durationSeconds * 10) / 10;
    }
    if (!(await this.ads.setAudio(id, data, cleanMime, bps, duration))) throw new NotFoundException('Unknown ad');
    await this.audit.record({ ...actor(req), action: 'ad.audio', entityType: 'ad', entityId: id, after: { mime: cleanMime, size: data.length, duration } });
    return this.ads.get(id);
  }

  @Put(':id/image')
  async image(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & AdminRequest) {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!isAllowedImage(mime)) throw new BadRequestException('Image must be png, jpeg, webp or gif');
    const data = await readRawBody(req, MAX_IMAGE);
    if (data.length === 0) throw new BadRequestException('Empty file');
    if (!(await this.ads.setImage(id, data, mime))) throw new NotFoundException('Unknown ad');
    await this.audit.record({ ...actor(req), action: 'ad.image', entityType: 'ad', entityId: id, after: { mime, size: data.length } });
    return this.ads.get(id);
  }

  @Delete(':id/image')
  @HttpCode(204)
  async removeImage(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    if (!(await this.ads.setImage(id, null, null))) throw new NotFoundException('Unknown ad');
  }
}

@Controller('admin/sponsors')
@UseGuards(AdminGuard)
export class AdminSponsorsController {
  constructor(private readonly sponsors: SponsorsRepository, private readonly audit: AuditService) {}

  @Get()
  list(@Query(OptionalChannelQuery) q: { channelId?: string }) {
    return this.sponsors.list(q.channelId);
  }

  @Post()
  async create(@Body(new ZodPipe(sponsorCreate)) body: SponsorInput, @Req() req: AdminRequest) {
    const s = await this.sponsors.create(body);
    await this.audit.record({ ...actor(req), action: 'sponsor.create', entityType: 'sponsor', entityId: s.id, after: s });
    return s;
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sponsorPatch)) body: Partial<SponsorInput>, @Req() req: AdminRequest) {
    const before = await this.sponsors.get(id);
    const s = await this.sponsors.update(id, body);
    if (!s) throw new NotFoundException('Unknown sponsor');
    await this.audit.record({ ...actor(req), action: 'sponsor.update', entityType: 'sponsor', entityId: id, before, after: s });
    return s;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AdminRequest): Promise<void> {
    if (!(await this.sponsors.remove(id))) throw new NotFoundException('Unknown sponsor');
    await this.audit.record({ ...actor(req), action: 'sponsor.delete', entityType: 'sponsor', entityId: id });
  }

  @Put(':id/logo')
  async logo(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & AdminRequest) {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!isAllowedImage(mime)) throw new BadRequestException('Image must be png, jpeg, webp or gif');
    const data = await readRawBody(req, MAX_IMAGE);
    if (data.length === 0) throw new BadRequestException('Empty file');
    if (!(await this.sponsors.setLogo(id, data, mime))) throw new NotFoundException('Unknown sponsor');
    return this.sponsors.get(id);
  }

  @Delete(':id/logo')
  @HttpCode(204)
  async removeLogo(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    if (!(await this.sponsors.setLogo(id, null, null))) throw new NotFoundException('Unknown sponsor');
  }
}

@Controller('admin/channels/:channelId')
@UseGuards(AdminGuard)
export class AdminEngagementController {
  constructor(
    private readonly settings: EngagementSettingsRepository,
    private readonly polls: TagPollRepository,
    private readonly votes: TagVoteService,
    private readonly audit: AuditService,
    private readonly channels: ChannelRepository,
  ) {}

  @Get('engagement')
  get(@Param('channelId', ChannelIdPipe) id: string) {
    return this.settings.get(id);
  }

  @Put('engagement')
  async save(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(engagementSchema)) body: EngagementSettings, @Req() req: AdminRequest) {
    if (!(await this.channels.get(id))) throw new NotFoundException('Channel not found');
    const before = await this.settings.get(id);
    const after = await this.settings.save(id, body);
    await this.audit.record({ ...actor(req), action: 'engagement.update', entityType: 'channel', entityId: id, before, after });
    return after;
  }

  @Get('tag-votes')
  async history(@Param('channelId', ChannelIdPipe) id: string) {
    return { current: await this.votes.view(id), history: await this.polls.recent(id, 20) };
  }

  @Post('tag-votes/start')
  @HttpCode(200)
  async start(@Param('channelId', ChannelIdPipe) id: string, @Req() req: AdminRequest) {
    const poll = await this.votes.startNow(id);
    if (!poll) throw new BadRequestException('Not enough tags with playable tracks (need at least 2)');
    await this.audit.record({ ...actor(req), action: 'tagvote.start', entityType: 'channel', entityId: id, after: { options: poll.options } });
    return this.votes.view(id);
  }
}
