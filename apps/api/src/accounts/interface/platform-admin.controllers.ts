import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, AdminRequest } from '../../administration/interface/admin.guard';
import { AuditService } from '../../administration/application/audit.service';
import { ChannelRepository } from '../../catalog/application/ports/channel.repository';
import { ZodPipe } from '../../shared/interface/zod.pipe';
import { AdsRepository } from '../../engagement/application/ports/ads.repository';
import { AccountsRepository } from '../application/ports/accounts.repository';
import { CampaignAction, CampaignStatus, InvalidTransitionError, transition } from '../domain/campaign-status';
import { PlatformSettings, PlatformSettingsRepository } from '../application/ports/platform-settings.repository';
import { platformSchema } from '../infrastructure/platform-settings.repository';

const ChannelIdPipe = new ZodPipe(z.string().regex(/^\d{1,20}$/, 'invalid channel id'));
const actor = (req: AdminRequest): { actor: string; requestId: string | null } => ({ actor: req.admin.email, requestId: req.id === undefined ? null : String(req.id) });

/** Operator switches: billing on/off, prices, sign-up and review policy. */
@Controller('admin/platform')
@UseGuards(AdminGuard)
export class AdminPlatformController {
  constructor(private readonly platform: PlatformSettingsRepository, private readonly audit: AuditService) {}

  @Get()
  get() {
    return this.platform.get();
  }

  @Put()
  async save(@Body(new ZodPipe(platformSchema)) body: PlatformSettings, @Req() req: AdminRequest) {
    const before = await this.platform.get();
    const after = await this.platform.save(body);
    await this.audit.record({ ...actor(req), action: 'platform.update', entityType: 'platform', entityId: 'platform', before, after });
    return after;
  }
}

@Controller('admin/accounts')
@UseGuards(AdminGuard)
export class AdminAccountsController {
  constructor(private readonly accounts: AccountsRepository, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.accounts.list();
  }

  @Patch(':id')
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }))) body: { status: 'ACTIVE' | 'SUSPENDED' }, @Req() req: AdminRequest) {
    if (!(await this.accounts.setStatus(id, body.status))) throw new NotFoundException('Unknown account');
    await this.audit.record({ ...actor(req), action: 'account.status', entityType: 'account', entityId: id, after: body });
    return this.accounts.get(id);
  }

  /** Manual credit (payment received outside the app, refund, correction). Positive = top-up, negative = adjustment. */
  @Post(':id/credit')
  @HttpCode(200)
  async credit(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ amountCents: z.number().int().refine((n) => n !== 0, 'must not be 0').refine((n) => Math.abs(n) <= 1_000_000_000_000), note: z.string().trim().max(200).optional() }))) body: { amountCents: number; note?: string }, @Req() req: AdminRequest) {
    const balance = await this.accounts.addLedger(id, body.amountCents, body.amountCents > 0 ? 'TOPUP' : 'ADJUST', null, body.note ?? null);
    if (balance === null) throw new NotFoundException('Unknown account');
    await this.audit.record({ ...actor(req), action: 'account.credit', entityType: 'account', entityId: id, after: { amountCents: body.amountCents, balance } });
    return { creditCents: balance };
  }

  @Get(':id/ledger')
  ledger(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.ledger(id, 200);
  }
}

@Controller('admin/campaigns')
@UseGuards(AdminGuard)
export class AdminCampaignsController {
  constructor(private readonly ads: AdsRepository, private readonly platform: PlatformSettingsRepository, private readonly audit: AuditService) {}

  @Get()
  list(@Query(new ZodPipe(z.object({ status: z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED']).optional() }))) q: { status?: CampaignStatus }) {
    return this.ads.listForReview(q.status);
  }

  private async act(id: string, action: CampaignAction, note: string | null, req: AdminRequest) {
    const ad = await this.ads.get(id);
    if (!ad || !ad.accountId) throw new NotFoundException('Unknown campaign');
    let next: CampaignStatus;
    try {
      next = transition(ad.status, action, { approvalRequired: (await this.platform.get()).campaignApprovalRequired, hasAudio: ad.hasAudio });
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw new BadRequestException(err.message);
      throw err;
    }
    const updated = await this.ads.setStatus(id, next, note);
    await this.audit.record({ ...actor(req), action: `campaign.${action}`, entityType: 'ad', entityId: id, before: { status: ad.status }, after: { status: next, note } });
    return updated;
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: AdminRequest) {
    return this.act(id, 'approve', null, req);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ note: z.string().trim().min(1, 'tell the advertiser why').max(500) }))) body: { note: string }, @Req() req: AdminRequest) {
    return this.act(id, 'reject', body.note, req);
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id', ParseUUIDPipe) id: string, @Req() req: AdminRequest) {
    return this.act(id, 'pause', null, req);
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@Param('id', ParseUUIDPipe) id: string, @Req() req: AdminRequest) {
    return this.act(id, 'resume', null, req);
  }
}

@Controller('admin/channels/:channelId/owner')
@UseGuards(AdminGuard)
export class AdminStationOwnerController {
  constructor(private readonly channels: ChannelRepository, private readonly accounts: AccountsRepository, private readonly audit: AuditService) {}

  /** Hands a station to a customer account (their portal then shows its stats and lets them change its engagement settings) or takes it back. */
  @Put()
  async setOwner(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(z.object({ accountId: z.string().uuid().nullable() }))) body: { accountId: string | null }, @Req() req: AdminRequest) {
    const ch = await this.channels.get(id);
    if (!ch) throw new NotFoundException('Channel not found');
    if (body.accountId && !(await this.accounts.get(body.accountId))) throw new BadRequestException('Unknown account');
    await this.channels.setOwner(id, body.accountId);
    await this.audit.record({ ...actor(req), action: 'channel.owner', entityType: 'channel', entityId: id, before: { owner: ch.ownerAccountId }, after: { owner: body.accountId } });
    return this.channels.get(id);
  }
}
