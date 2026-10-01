import { listenersOf } from '../playback/station-manager';
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../admin/audit.service';
import { ChannelRepository } from '../channels/channel.repository';
import { ZodPipe } from '../common/zod.pipe';
import { DatabaseService } from '../database/database.service';
import { AdSummary, AdsRepository } from '../engagement/ads.repository';
import { EngagementSettings, EngagementSettingsRepository, engagementSchema } from '../engagement/engagement-settings.repository';
import { isAllowedImage, isAudio, readRawBody } from '../engagement/raw-body';
import { inspectMp3 } from '../engagement/mp3-info';
import { TagPollRepository } from '../engagement/tag-poll.repository';
import { TagVoteService } from '../engagement/tag-vote.service';
import { StationManager } from '../playback/station-manager';
import { REALTIME_BUS, RealtimeBus } from '../realtime/events';
import { MessageInput, MessagesRepository, messageSchema } from '../realtime/messages.repository';
import { AccountsRepository } from './accounts.repository';
import { InvalidTransitionError, CampaignAction, transition } from './campaign-status';
import { PlatformSettings, PlatformSettingsRepository } from './platform-settings.repository';
import { PortalAuthService, loginSchema, signupSchema } from './portal-auth.service';
import { PortalGuard, PortalRequest } from './portal.guard';

export const PORTAL_AUDIT = Symbol('PORTAL_AUDIT');
const CidPipe = new ZodPipe(z.string().regex(/^\d{1,20}$/, 'invalid station id'));
const MAX_AUDIO = 10 * 1024 * 1024;
const MAX_IMAGE = 1536 * 1024;

const httpUrl = z.string().trim().max(500).url().refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) link');
const iso = z.string().datetime();
const campaignFields = {
  name: z.string().trim().min(1).max(100),
  channelId: z.string().regex(/^\d{1,20}$/).nullable(),
  linkUrl: httpUrl.nullable(),
  ctaLabel: z.string().trim().max(40).nullable(),
  startsAt: iso.nullable(),
  endsAt: iso.nullable(),
  maxPlays: z.number().int().min(1).max(100_000_000).nullable(),
};
const campaignCreate = z.object(campaignFields).partial({ channelId: true, linkUrl: true, ctaLabel: true, startsAt: true, endsAt: true, maxPlays: true });
const campaignPatch = z.object(campaignFields).partial();
const CONTENT_FIELDS = ['name', 'channelId', 'linkUrl', 'ctaLabel'] as const;

const publicPlatform = (p: PlatformSettings) => ({ billingEnabled: p.billingEnabled, selfSignupEnabled: p.selfSignupEnabled, campaignApprovalRequired: p.campaignApprovalRequired, pricePerPlayCents: p.pricePerPlayCents, pricePerClickCents: p.pricePerClickCents, currency: p.currency });

@Controller('portal/auth')
export class PortalAuthController {
  constructor(private readonly auth: PortalAuthService, private readonly platform: PlatformSettingsRepository) {}

  /** What the sign-up screen needs to know (no secrets). */
  @Get('config')
  async config() {
    return publicPlatform(await this.platform.get());
  }

  @Post('signup')
  async signup(@Body(new ZodPipe(signupSchema)) body: z.infer<typeof signupSchema>, @Req() req: Request) {
    const r = await this.auth.signup(body, req.ip ?? 'unknown');
    return { token: r.token, email: r.identity.email };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request) {
    const r = await this.auth.login(body.email, body.password, req.ip ?? 'unknown');
    return { token: r.token, email: r.identity.email };
  }
}

@Controller('portal')
@UseGuards(PortalGuard)
export class PortalController {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly ads: AdsRepository,
    private readonly channels: ChannelRepository,
    private readonly platform: PlatformSettingsRepository,
    private readonly engagement: EngagementSettingsRepository,
    private readonly polls: TagPollRepository,
    private readonly votes: TagVoteService,
    private readonly stations: StationManager,
    private readonly db: DatabaseService,
    @Inject(PORTAL_AUDIT) private readonly audit: AuditService,
    private readonly messages: MessagesRepository,
    @Inject(REALTIME_BUS) private readonly bus: RealtimeBus,
  ) {}

  private actor(req: PortalRequest): { actor: string; requestId: string | null } {
    return { actor: `account:${req.portal.email}`, requestId: req.id === undefined ? null : String(req.id) };
  }

  @Get('me')
  async me(@Req() req: PortalRequest) {
    const account = await this.accounts.get(req.portal.accountId);
    return { account, email: req.portal.email, platform: publicPlatform(await this.platform.get()) };
  }

  // ---- campaigns ----

  /** Stations a campaign can be aimed at. */
  @Get('stations/public')
  async publicStations() {
    return (await this.channels.list()).filter((c) => c.started).map((c) => ({ id: c.id, slug: c.slug, title: c.title }));
  }

  @Get('campaigns')
  list(@Req() req: PortalRequest) {
    return this.ads.listByAccount(req.portal.accountId);
  }

  private async own(id: string, req: PortalRequest): Promise<AdSummary> {
    const ad = await this.ads.get(id);
    if (!ad || ad.accountId !== req.portal.accountId) throw new NotFoundException('Unknown campaign'); // never reveal other accounts' ids
    return ad;
  }

  private async move(ad: AdSummary, action: CampaignAction, note: string | null = null): Promise<AdSummary> {
    const p = await this.platform.get();
    try {
      const next = transition(ad.status, action, { approvalRequired: p.campaignApprovalRequired, hasAudio: ad.hasAudio });
      return (await this.ads.setStatus(ad.id, next, note)) ?? ad;
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Post('campaigns')
  async create(@Body(new ZodPipe(campaignCreate)) body: z.infer<typeof campaignCreate>, @Req() req: PortalRequest) {
    const p = await this.platform.get();
    if (p.maxCampaignsPerAccount > 0 && (await this.ads.countByAccount(req.portal.accountId)) >= p.maxCampaignsPerAccount) throw new ForbiddenException(`Campaign limit reached (${p.maxCampaignsPerAccount})`);
    if (body.channelId && !(await this.channels.get(body.channelId))) throw new BadRequestException('Unknown station');
    this.checkDates(body.startsAt ?? null, body.endsAt ?? null);
    const ad = await this.ads.createCampaign(req.portal.accountId, { name: body.name, channelId: body.channelId ?? null, linkUrl: body.linkUrl ?? null, ctaLabel: body.ctaLabel ?? null, startsAt: body.startsAt ?? null, endsAt: body.endsAt ?? null, maxPlays: body.maxPlays ?? null });
    await this.audit.record({ ...this.actor(req), action: 'campaign.create', entityType: 'ad', entityId: ad.id, after: { name: ad.name } });
    return ad;
  }

  private checkDates(start: string | null, end: string | null): void {
    if (start && end && Date.parse(end) <= Date.parse(start)) throw new BadRequestException('The end date must be after the start date');
  }

  @Patch('campaigns/:id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(campaignPatch)) body: z.infer<typeof campaignPatch>, @Req() req: PortalRequest) {
    const ad = await this.own(id, req);
    if (body.channelId && !(await this.channels.get(body.channelId))) throw new BadRequestException('Unknown station');
    this.checkDates(body.startsAt === undefined ? ad.startsAt : body.startsAt, body.endsAt === undefined ? ad.endsAt : body.endsAt);
    const updated = (await this.ads.updateCampaign(id, body)) ?? ad;
    // Changing what the audience sees/hears sends an approved campaign back to review; schedule and cap changes do not.
    const content = CONTENT_FIELDS.some((f) => body[f] !== undefined && body[f] !== ad[f]);
    return content && ad.status !== 'DRAFT' ? this.move(updated, 'edit-content') : updated;
  }

  @Delete('campaigns/:id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: PortalRequest): Promise<void> {
    await this.own(id, req);
    await this.ads.remove(id);
    await this.audit.record({ ...this.actor(req), action: 'campaign.delete', entityType: 'ad', entityId: id });
  }

  @Put('campaigns/:id/audio')
  async audioUpload(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & PortalRequest) {
    const ad = await this.own(id, req);
    const mime = String(req.headers['content-type'] ?? '');
    if (!isAudio(mime)) throw new BadRequestException('Send the file with an audio/* Content-Type');
    const data = await readRawBody(req, MAX_AUDIO);
    if (data.length === 0) throw new BadRequestException('Empty file');
    const clean = mime.split(';')[0]?.trim().toLowerCase() ?? 'audio/mpeg';
    let bps: number | null = null;
    let duration: number | null = null;
    if (/^audio\/(mpeg|mp3|mpeg3|x-mpeg-3)$/.test(clean)) {
      const info = inspectMp3(data);
      if (!info) throw new BadRequestException('Not a valid MP3 file');
      bps = info.bytesPerSec;
      duration = Math.round(info.durationSeconds * 10) / 10;
    }
    await this.ads.setAudio(id, data, clean, bps, duration);
    const fresh = (await this.ads.get(id)) ?? ad;
    return fresh.status === 'DRAFT' ? fresh : this.move(fresh, 'edit-content');
  }

  @Put('campaigns/:id/image')
  async imageUpload(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & PortalRequest) {
    const ad = await this.own(id, req);
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!isAllowedImage(mime)) throw new BadRequestException('Image must be png, jpeg, webp or gif');
    const data = await readRawBody(req, MAX_IMAGE);
    if (data.length === 0) throw new BadRequestException('Empty file');
    await this.ads.setImage(id, data, mime);
    const fresh = (await this.ads.get(id)) ?? ad;
    return fresh.status === 'DRAFT' ? fresh : this.move(fresh, 'edit-content');
  }

  @Post('campaigns/:id/submit')
  @HttpCode(200)
  async submit(@Param('id', ParseUUIDPipe) id: string, @Req() req: PortalRequest) {
    const ad = await this.move(await this.own(id, req), 'submit');
    await this.audit.record({ ...this.actor(req), action: 'campaign.submit', entityType: 'ad', entityId: id, after: { status: ad.status } });
    return ad;
  }

  @Post('campaigns/:id/pause')
  @HttpCode(200)
  async pause(@Param('id', ParseUUIDPipe) id: string, @Req() req: PortalRequest) {
    return this.move(await this.own(id, req), 'pause');
  }

  @Post('campaigns/:id/resume')
  @HttpCode(200)
  async resume(@Param('id', ParseUUIDPipe) id: string, @Req() req: PortalRequest) {
    return this.move(await this.own(id, req), 'resume');
  }

  // ---- money ----

  @Get('billing')
  async billing(@Req() req: PortalRequest) {
    const [account, ledger, p] = await Promise.all([this.accounts.get(req.portal.accountId), this.accounts.ledger(req.portal.accountId), this.platform.get()]);
    return { creditCents: account?.creditCents ?? 0, ledger, platform: publicPlatform(p) };
  }

  // ---- stations owned by this account ----

  private async ownedStation(cid: string, req: PortalRequest) {
    const c = await this.channels.get(cid);
    if (!c || c.ownerAccountId !== req.portal.accountId) throw new NotFoundException('Unknown station');
    return c;
  }

  @Get('stations')
  async myStations(@Req() req: PortalRequest) {
    const owned = await this.channels.ownedBy(req.portal.accountId);
    return Promise.all(
      owned.map(async (c) => {
        const s = await this.db.query<{ plays: string; peak: number | null; avg: string | null }>(
          `SELECT (SELECT count(*) FROM playback_history h JOIN tracks t ON t.id = h.track_id WHERE t.telegram_channel_id = $1 AND h.started_at > now() - interval '24 hours') AS plays,
                  (SELECT max(listeners) FROM listener_samples WHERE channel_id = $1 AND at > now() - interval '24 hours') AS peak,
                  (SELECT avg(listeners) FROM listener_samples WHERE channel_id = $1 AND at > now() - interval '24 hours') AS avg`,
          [c.id],
        );
        const row = s.rows[0];
        return { id: c.id, slug: c.slug, title: c.title, started: c.started, listenersNow: listenersOf(this.stations.get(c.id)), plays24h: Number(row?.plays ?? 0), peakListeners24h: row?.peak ?? 0, avgListeners24h: Math.round(Number(row?.avg ?? 0) * 10) / 10 };
      }),
    );
  }

  @Get('stations/:cid/engagement')
  async getEngagement(@Param('cid', CidPipe) cid: string, @Req() req: PortalRequest) {
    await this.ownedStation(cid, req);
    return this.engagement.get(cid);
  }

  @Put('stations/:cid/engagement')
  async saveEngagement(@Param('cid', CidPipe) cid: string, @Body(new ZodPipe(engagementSchema)) body: EngagementSettings, @Req() req: PortalRequest) {
    await this.ownedStation(cid, req);
    const before = await this.engagement.get(cid);
    const after = await this.engagement.save(cid, body);
    await this.audit.record({ ...this.actor(req), action: 'engagement.update', entityType: 'channel', entityId: cid, before, after });
    return after;
  }

  /** A station owner can talk to the listeners of their own station. */
  @Get('stations/:cid/messages')
  async listMessages(@Param('cid', CidPipe) cid: string, @Req() req: PortalRequest) {
    await this.ownedStation(cid, req);
    return this.messages.active(cid);
  }

  @Post('stations/:cid/messages')
  async postMessage(@Param('cid', CidPipe) cid: string, @Body(new ZodPipe(messageSchema)) body: MessageInput, @Req() req: PortalRequest) {
    await this.ownedStation(cid, req);
    const m = await this.messages.create(cid, body, `account:${req.portal.email}`);
    await this.audit.record({ ...this.actor(req), action: 'message.create', entityType: 'channel', entityId: cid, after: { text: m.text, level: m.level } });
    await this.bus.publish({ type: 'messages', channelId: cid });
    return m;
  }

  @Delete('stations/:cid/messages/:mid')
  @HttpCode(204)
  async deleteMessage(@Param('cid', CidPipe) cid: string, @Param('mid', ParseUUIDPipe) mid: string, @Req() req: PortalRequest): Promise<void> {
    await this.ownedStation(cid, req);
    if (!(await this.messages.remove(cid, mid))) throw new NotFoundException('Unknown message');
    await this.bus.publish({ type: 'messages', channelId: cid });
  }

  @Post('stations/:cid/tag-votes/start')
  @HttpCode(200)
  async startVote(@Param('cid', CidPipe) cid: string, @Req() req: PortalRequest) {
    await this.ownedStation(cid, req);
    if (!(await this.votes.startNow(cid))) throw new BadRequestException('Not enough tags with playable tracks (need at least 2)');
    return this.votes.view(cid);
  }

  @Get('stations/:cid/tag-votes')
  async tagVotes(@Param('cid', CidPipe) cid: string, @Req() req: PortalRequest) {
    await this.ownedStation(cid, req);
    return { current: await this.votes.view(cid), history: await this.polls.recent(cid, 10) };
  }
}
