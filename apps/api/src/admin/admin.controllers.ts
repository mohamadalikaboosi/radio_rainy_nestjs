import { BadRequestException, Body, GatewayTimeoutException, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TimeoutError } from '../common/timeout';
import { ZodPipe } from '../common/zod.pipe';
import { BullMqJobQueue } from '../jobs/bullmq-job-queue';
import { PlaybackEngine } from '../playback/playback-engine';
import { ActorContext, ConfigUpdate, configUpdateSchema, PreviewRequest, previewSchema, RadioConfigurationService, RuleInput, ruleSchema } from '../radio/radio-configuration.service';
import { TelegramClientManager } from '../telegram/telegram-client.manager';
import { maskPhone } from '../telegram/telegram-session.store';
import { AdminAuthService } from './admin-auth.service';
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
  get() {
    return this.dashboard.get();
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
  async sync(@Body(new ZodPipe(z.object({ full: z.boolean().default(false) }).default({ full: false }))) body: { full: boolean }, @Req() req: AdminRequest) {
    await this.queue.enqueueTelegramSync({ full: body.full });
    await this.audit.record({ actor: req.admin.email, action: 'telegram.sync', entityType: 'telegram', after: body, requestId: ctxOf(req).requestId });
    return { queued: true, full: body.full };
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

@Controller('admin/radio')
@UseGuards(AdminGuard)
export class AdminRadioController {
  constructor(
    private readonly config: RadioConfigurationService,
    private readonly control: RadioControlService,
    private readonly engine: PlaybackEngine,
  ) {}

  @Get('config')
  getConfig() {
    return this.config.getConfig();
  }

  @Put('config')
  updateConfig(@Body(new ZodPipe(configUpdateSchema)) body: ConfigUpdate, @Req() req: AdminRequest) {
    return this.config.updateConfig(body, ctxOf(req));
  }

  @Post('rules')
  createRule(@Body(new ZodPipe(ruleSchema)) body: RuleInput, @Req() req: AdminRequest) {
    return this.config.createRule(body, ctxOf(req));
  }

  @Put('rules/:id')
  updateRule(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ruleSchema)) body: RuleInput, @Req() req: AdminRequest) {
    return this.config.updateRule(id, body, ctxOf(req));
  }

  @Delete('rules/:id')
  @HttpCode(204)
  async deleteRule(@Param('id', ParseUUIDPipe) id: string, @Req() req: AdminRequest): Promise<void> {
    await this.config.deleteRule(id, ctxOf(req));
  }

  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodPipe(previewSchema)) body: PreviewRequest) {
    return this.config.preview(body);
  }

  @Post('skip')
  @HttpCode(202)
  skip(@Body(new ZodPipe(z.object({ expectedSeq: z.number().int().optional() }).default({}))) body: { expectedSeq?: number }, @Req() req: AdminRequest) {
    return this.control.skip(body.expectedSeq, ctxOf(req));
  }

  @Post('play-next')
  @HttpCode(202)
  playNext(@Body(new ZodPipe(z.object({ trackId: z.string().uuid().optional() }).default({}))) body: { trackId?: string }, @Req() req: AdminRequest) {
    return this.control.playNext(body.trackId, ctxOf(req));
  }

  @Get('history')
  history(@Query(new ZodPipe(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }))) q: { limit: number }) {
    return this.control.historyList(q.limit);
  }

  @Get('state')
  state() {
    return { leader: this.engine.running, current: this.engine.current ? { trackId: this.engine.current.track.id, seq: this.engine.current.seq } : null };
  }
}
