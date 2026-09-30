import { BadRequestException, Body, GatewayTimeoutException, Res, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TimeoutError } from '../common/timeout';
import { ZodPipe } from '../common/zod.pipe';
import { BullMqJobQueue } from '../jobs/bullmq-job-queue';
import { addChannelSchema, ChannelService } from '../channels/channel.service';
import { StationManager } from '../playback/station-manager';
import { ActorContext, ConfigUpdate, configUpdateSchema, PreviewRequest, previewSchema, RadioConfigurationService, RuleInput, ruleSchema } from '../radio/radio-configuration.service';
import { TelegramClientManager } from '../telegram/telegram-client.manager';
import { maskPhone } from '../telegram/telegram-session.store';
import { AdminAuthService } from './admin-auth.service';
import type { Response } from 'express';
import { LiveService } from './live.service';
import { ReportQuery, reportQuerySchema, ReportsService } from './reports.service';
import { SystemReportService } from './system-report.service';
import { AdminGuard, AdminRequest } from './admin.guard';
import { AuditService } from './audit.service';
import { DashboardService } from './dashboard.service';
import { RadioControlService } from './radio-control.service';
import { StatsService } from './stats.service';
import { TrackAdminService } from './track-admin.service';
import { TrackQuery, TrackQueryRepository, trackQuerySchema } from './track-query.repository';

const ctxOf = (req: AdminRequest): ActorContext => ({ actor: req.admin.email, requestId: req.id === undefined ? null : String(req.id) });

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }))) body: { email: string; password: string }, @Req() req: AdminRequest) {
    return this.auth.login(body.email, body.password, req.ip ?? 'unknown');
  }

  @Get('me')
  @UseGuards(AdminGuard)
  me(@Req() req: AdminRequest) {
    return req.admin;
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminDashboardController {
  constructor(private readonly dashboard: DashboardService, private readonly audit: AuditService) {}

  @Get('dashboard')
  overview() {
    return this.dashboard.overview();
  }

  @Get('audit')
  auditLog(@Query(new ZodPipe(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0), action: z.string().max(100).optional(), entityType: z.string().max(100).optional() }))) q: { limit: number; offset: number; action?: string; entityType?: string }) {
    return this.audit.list(q);
  }
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminTelegramController {
  constructor(
    private readonly telegram: TelegramClientManager,
    private readonly audit: AuditService,
    private readonly queue: BullMqJobQueue,
  ) {}

  @Get('telegram/status')
  status() {
    return this.telegram.getStatus();
  }

  @Post('telegram/login/start')
  @HttpCode(200)
  async start(@Body(new ZodPipe(z.object({ phone: z.string().trim().regex(/^\+?[0-9]{7,15}$/, 'phone must be in international format, e.g. +989123456789') }))) body: { phone: string }, @Req() req: AdminRequest) {
    await this.telegramCall(() => this.telegram.beginLogin(body.phone, req.admin.email));
    await this.audit.record({ actor: req.admin.email, action: 'telegram.login.start', entityType: 'telegram', after: { phone: maskPhone(body.phone) }, requestId: ctxOf(req).requestId });
    return this.telegram.getStatus();
  }

  @Post('telegram/login/code')
  @HttpCode(200)
  async code(@Body(new ZodPipe(z.object({ code: z.string().trim().regex(/^[0-9]{4,8}$/, 'invalid code format') }))) body: { code: string }, @Req() req: AdminRequest) {
    const state = await this.telegramCall(() => this.telegram.submitCode(body.code));
    if (state === 'READY') await this.completed(req);
    return this.telegram.getStatus();
  }

  @Post('telegram/login/password')
  @HttpCode(200)
  async password(@Body(new ZodPipe(z.object({ password: z.string().min(1).max(256) }))) body: { password: string }, @Req() req: AdminRequest) {
    await this.telegramCall(() => this.telegram.submitPassword(body.password));
    await this.completed(req);
    return this.telegram.getStatus();
  }

  @Post('telegram/login/cancel')
  @HttpCode(200)
  async cancel() {
    await this.telegram.cancelLogin();
    return this.telegram.getStatus();
  }

  @Post('telegram/logout')
  @HttpCode(200)
  async logout(@Req() req: AdminRequest) {
    await this.telegram.logout();
    await this.audit.record({ actor: req.admin.email, action: 'telegram.logout', entityType: 'telegram', requestId: ctxOf(req).requestId });
    return this.telegram.getStatus();
  }

  @Post('sync')
  @HttpCode(202)
  async sync(@Body(new ZodPipe(z.object({ full: z.boolean().default(false), channelId: z.string().regex(/^\d{1,20}$/).optional() }).default({ full: false }))) body: { full: boolean; channelId?: string }, @Req() req: AdminRequest) {
    await this.queue.enqueueTelegramSync({ full: body.full, ...(body.channelId ? { channelId: body.channelId } : {}) });
    await this.audit.record({ actor: req.admin.email, action: 'telegram.sync', entityType: 'telegram', after: body, requestId: ctxOf(req).requestId });
    return { queued: true, full: body.full, channelId: body.channelId ?? null };
  }

  private async completed(req: AdminRequest): Promise<void> {
    await this.audit.record({ actor: req.admin.email, action: 'telegram.login.complete', entityType: 'telegram', after: { account: this.telegram.getStatus().accountLabel }, requestId: ctxOf(req).requestId });
    await this.queue.enqueueTelegramSync({ full: true }); // first full sync right after login
  }

  /** Telegram RPC errors (bad code, bad password, flood) become 400s with a safe message; details never include secrets. */
  private async telegramCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const rpc = typeof err === 'object' && err !== null && 'errorMessage' in err ? String((err as { errorMessage: unknown }).errorMessage) : undefined;
      if (rpc) throw new BadRequestException({ message: 'Telegram rejected the request', telegramError: rpc });
      if (err instanceof TimeoutError) throw new GatewayTimeoutException(`${err.message}. Telegram is unreachable from the server; check its network access.`);
      if (err instanceof Error && err.name === 'TelegramNotReadyError') throw new BadRequestException(err.message);
      throw err;
    }
  }
}

@Controller('admin/tracks')
@UseGuards(AdminGuard)
export class AdminTracksController {
  constructor(private readonly query: TrackQueryRepository, private readonly admin: TrackAdminService) {}

  @Get()
  list(@Query(new ZodPipe(trackQuerySchema)) q: TrackQuery) {
    return this.query.search(q);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.detail(id);
  }

  @Post(':id/process-lyrics')
  @HttpCode(202)
  process(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ force: z.boolean().default(false) }).default({ force: false }))) body: { force: boolean }, @Req() req: AdminRequest) {
    return this.admin.processLyrics(id, body.force, ctxOf(req));
  }

  @Patch(':id/enabled')
  enabled(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ enabled: z.boolean() }))) body: { enabled: boolean }, @Req() req: AdminRequest) {
    return this.admin.setEnabled(id, body.enabled, ctxOf(req));
  }

  @Post(':id/refresh-metadata')
  @HttpCode(200)
  refresh(@Param('id', ParseUUIDPipe) id: string, @Req() req: AdminRequest) {
    return this.admin.refreshMetadata(id, ctxOf(req));
  }
}

@Controller('admin/hashtags')
@UseGuards(AdminGuard)
export class AdminHashtagsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  list() {
    return this.stats.hashtags();
  }

  @Get('stats')
  analytics() {
    return this.stats.analytics();
  }

  @Post('stats/refresh')
  @HttpCode(200)
  async refresh() {
    await this.stats.refresh();
    return this.stats.analytics();
  }

  @Get(':id/tracks')
  tracks(@Param('id', ParseUUIDPipe) id: string) {
    return this.stats.tracksOf(id);
  }
}

const ChannelIdPipe = new ZodPipe(z.string().regex(/^\d{1,20}$/, 'invalid channel id'));

@Controller('admin/channels/:channelId/radio')
@UseGuards(AdminGuard)
export class AdminRadioController {
  constructor(
    private readonly config: RadioConfigurationService,
    private readonly control: RadioControlService,
    private readonly channels: ChannelService,
    private readonly dashboard: DashboardService,
    private readonly stations: StationManager,
  ) {}

  private async ch(id: string): Promise<string> {
    await this.channels.require(id);
    return id;
  }

  @Get('dashboard')
  async channelDashboard(@Param('channelId', ChannelIdPipe) id: string) {
    return this.dashboard.channel(await this.ch(id));
  }

  @Get('config')
  async getConfig(@Param('channelId', ChannelIdPipe) id: string) {
    return this.config.getConfig(await this.ch(id));
  }

  @Put('config')
  async updateConfig(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(configUpdateSchema)) body: ConfigUpdate, @Req() req: AdminRequest) {
    return this.config.updateConfig(await this.ch(id), body, ctxOf(req));
  }

  @Post('rules')
  async createRule(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(ruleSchema)) body: RuleInput, @Req() req: AdminRequest) {
    return this.config.createRule(await this.ch(id), body, ctxOf(req));
  }

  @Put('rules/:ruleId')
  async updateRule(@Param('channelId', ChannelIdPipe) id: string, @Param('ruleId', ParseUUIDPipe) ruleId: string, @Body(new ZodPipe(ruleSchema)) body: RuleInput, @Req() req: AdminRequest) {
    return this.config.updateRule(await this.ch(id), ruleId, body, ctxOf(req));
  }

  @Delete('rules/:ruleId')
  @HttpCode(204)
  async deleteRule(@Param('channelId', ChannelIdPipe) id: string, @Param('ruleId', ParseUUIDPipe) ruleId: string, @Req() req: AdminRequest): Promise<void> {
    await this.config.deleteRule(await this.ch(id), ruleId, ctxOf(req));
  }

  @Post('preview')
  @HttpCode(200)
  async preview(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(previewSchema)) body: PreviewRequest) {
    return this.config.preview(await this.ch(id), body);
  }

  /** Plays `trackId` when the current track ends (does not cut it). */
  @Post('queue-next')
  @HttpCode(202)
  async queueNext(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(z.object({ trackId: z.string().uuid() }))) body: { trackId: string }, @Req() req: AdminRequest) {
    return this.control.queueNext(await this.ch(id), body.trackId, ctxOf(req));
  }

  @Post('skip')
  @HttpCode(202)
  async skip(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(z.object({ expectedSeq: z.number().int().optional() }).default({}))) body: { expectedSeq?: number }, @Req() req: AdminRequest) {
    return this.control.skip(await this.ch(id), body.expectedSeq, ctxOf(req));
  }

  @Post('play-next')
  @HttpCode(202)
  async playNext(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(z.object({ trackId: z.string().uuid().optional() }).default({}))) body: { trackId?: string }, @Req() req: AdminRequest) {
    return this.control.playNext(await this.ch(id), body.trackId, ctxOf(req));
  }

  @Get('history')
  async history(@Param('channelId', ChannelIdPipe) id: string, @Query(new ZodPipe(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }))) q: { limit: number }) {
    return this.control.historyList(await this.ch(id), q.limit);
  }

  @Get('state')
  async state(@Param('channelId', ChannelIdPipe) id: string) {
    const st = this.stations.get(await this.ch(id));
    return { leader: st !== undefined, current: st?.engine.current ? { trackId: st.engine.current.track.id, seq: st.engine.current.seq } : null };
  }
}

@Controller('admin/channels')
@UseGuards(AdminGuard)
export class AdminChannelsController {
  constructor(private readonly channels: ChannelService, private readonly queue: BullMqJobQueue, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.channels.list();
  }

  @Post()
  add(@Body(new ZodPipe(addChannelSchema)) body: { reference: string }, @Req() req: AdminRequest) {
    return this.channels.add(body.reference, ctxOf(req));
  }

  @Delete(':channelId')
  @HttpCode(204)
  async remove(@Param('channelId', ChannelIdPipe) id: string, @Query(new ZodPipe(z.object({ deleteTracks: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }))) q: { deleteTracks: boolean }, @Req() req: AdminRequest): Promise<void> {
    await this.channels.remove(id, q.deleteTracks, ctxOf(req));
  }

  @Post(':channelId/start')
  @HttpCode(200)
  start(@Param('channelId', ChannelIdPipe) id: string, @Req() req: AdminRequest) {
    return this.channels.setStarted(id, true, ctxOf(req));
  }

  @Post(':channelId/stop')
  @HttpCode(200)
  stop(@Param('channelId', ChannelIdPipe) id: string, @Req() req: AdminRequest) {
    return this.channels.setStarted(id, false, ctxOf(req));
  }

  /** Also stream this station inside Telegram itself (the channel's live stream / voice chat). */
  @Put(':channelId/live')
  setLive(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(z.object({ enabled: z.boolean() }))) body: { enabled: boolean }, @Req() req: AdminRequest) {
    return this.channels.setLive(id, body.enabled, ctxOf(req));
  }

  /** Manual live target: Telegram's "Server URL" + "Stream key" (or one full link). The key is never returned. */
  @Put(':channelId/live-target')
  setLiveTarget(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(z.object({ url: z.string().min(8).max(400), key: z.string().max(300).optional() }))) body: { url: string; key?: string }, @Req() req: AdminRequest) {
    return this.channels.setLiveTarget(id, body, ctxOf(req));
  }

  @Delete(':channelId/live-target')
  clearLiveTarget(@Param('channelId', ChannelIdPipe) id: string, @Req() req: AdminRequest) {
    return this.channels.setLiveTarget(id, null, ctxOf(req));
  }

  @Post(':channelId/sync')
  @HttpCode(202)
  async sync(@Param('channelId', ChannelIdPipe) id: string, @Body(new ZodPipe(z.object({ full: z.boolean().default(false) }).default({ full: false }))) body: { full: boolean }, @Req() req: AdminRequest) {
    await this.channels.require(id);
    await this.queue.enqueueTelegramSync({ channelId: id, full: body.full });
    await this.audit.record({ actor: req.admin.email, action: 'telegram.sync', entityType: 'channel', entityId: id, after: body, requestId: ctxOf(req).requestId });
    return { queued: true, full: body.full };
  }
}


/** What is on air right now for every station (poll every second). */
@Controller('admin/live')
@UseGuards(AdminGuard)
export class AdminLiveController {
  constructor(private readonly live: LiveService) {}

  @Get()
  snapshot() {
    return this.live.snapshot();
  }
}

@Controller('admin/reports')
@UseGuards(AdminGuard)
export class AdminReportsController {
  constructor(private readonly reports: ReportsService, private readonly system: SystemReportService) {}

  @Get()
  all(@Query(new ZodPipe(reportQuerySchema)) q: ReportQuery) {
    return this.reports.all(q);
  }

  @Get('system')
  systemHealth() {
    return this.system.get();
  }

  @Get('export.csv')
  async exportCsv(@Query(new ZodPipe(reportQuerySchema.extend({ type: z.enum(['plays', 'tracks']).default('plays') }))) q: ReportQuery & { type: 'plays' | 'tracks' }, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="radio_rainy_${q.type}_${q.range}.csv"`);
    res.write('\uFEFF'); // BOM so Excel opens Persian text correctly
    for await (const line of this.reports.exportCsv(q.type, q)) if (!res.write(line)) await new Promise<void>((r) => res.once('drain', r));
    res.end();
  }
}
