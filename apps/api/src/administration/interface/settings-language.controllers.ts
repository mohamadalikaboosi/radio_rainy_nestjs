import { BadRequestException, Body, Controller, Inject, Delete, Get, HttpCode, Post, Put, Query, Patch, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../shared/interface/zod.pipe';
import { LexiconRepository } from '../../lyrics/application/lexicon';
import { LanguageService } from '../../lyrics/application/language.service';
import { AudioStoreSource } from '../../catalog/application/ports/audio-store';
import { LlmSettingsInput, llmSettingsSchema, SettingsService, StorageSettingsInput, storageSettingsSchema, TelegramSettingsInput, telegramSettingsSchema, WhisperSettingsInput, whisperSettingsSchema } from '../application/settings.service';
import { AdminGuard, AdminRequest } from './admin.guard';
import { AuditService } from '../application/audit.service';

const lang = z.enum(['fa', 'en', 'mixed']);

/** Runtime settings edited in the panel. Secrets are write-only: no endpoint ever returns them. */
@Controller('admin/settings')
@UseGuards(AdminGuard)
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject('AUDIO_STORE_SOURCE') private readonly store: AudioStoreSource,
  ) {}

  @Get()
  view() {
    return this.settings.view();
  }

  @Put('telegram')
  async telegram(@Body(new ZodPipe(telegramSettingsSchema)) body: TelegramSettingsInput, @Req() req: AdminRequest) {
    await this.settings.updateTelegram(body, req.admin.email);
    await this.audit.record({ actor: req.admin.email, action: 'settings.telegram.update', entityType: 'settings', entityId: 'telegram', after: { apiId: body.apiId, apiHashChanged: Boolean(body.apiHash) } });
    return this.settings.view();
  }

  @Put('whisper')
  async whisper(@Body(new ZodPipe(whisperSettingsSchema)) body: WhisperSettingsInput, @Req() req: AdminRequest) {
    await this.settings.updateWhisper(body, req.admin.email);
    await this.audit.record({ actor: req.admin.email, action: 'settings.whisper.update', entityType: 'settings', entityId: 'whisper', after: { url: body.url, model: body.model, language: body.language, sampleRate: body.sampleRate, apiKeyChanged: Boolean(body.apiKey), apiKeyCleared: Boolean(body.clearApiKey) } });
    return this.settings.view();
  }

  /** Audio cache (MinIO / S3-compatible). Keys are write-only. */
  @Put('storage')
  async storage(@Body(new ZodPipe(storageSettingsSchema)) body: StorageSettingsInput, @Req() req: AdminRequest) {
    try {
      await this.settings.updateStorage(body, req.admin.email);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'invalid storage settings');
    }
    await this.audit.record({ actor: req.admin.email, action: 'settings.storage.update', entityType: 'settings', entityId: 'storage', after: { enabled: body.enabled, endpoint: body.endpoint, port: body.port, useSsl: body.useSsl, bucket: body.bucket, keysChanged: Boolean(body.accessKey || body.secretKey), keysCleared: Boolean(body.clearKeys) } });
    return this.settings.view();
  }

  /** Verifies the saved storage settings: bucket exists/created, write + read + delete of a tiny object. */
  @Post('storage/test')
  @HttpCode(200)
  async testStorage() {
    const store = await this.store.current();
    if (!store) return { ok: false, error: 'Audio storage is disabled or incomplete (save the settings first)' };
    try {
      await store.ping();
      return { ok: true, ...(await store.usage(50_000)) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Put('llm')
  async llm(@Body(new ZodPipe(llmSettingsSchema)) body: LlmSettingsInput, @Req() req: AdminRequest) {
    await this.settings.updateLlm(body, req.admin.email);
    await this.audit.record({ actor: req.admin.email, action: 'settings.llm.update', entityType: 'settings', entityId: 'llm', after: { enabled: body.enabled, url: body.url, model: body.model, apiKeyChanged: Boolean(body.apiKey), apiKeyCleared: Boolean(body.clearApiKey) } });
    return this.settings.view();
  }
}

@Controller('admin/language')
@UseGuards(AdminGuard)
export class AdminLanguageController {
  constructor(private readonly language: LanguageService, private readonly lexicon: LexiconRepository, private readonly audit: AuditService) {}

  @Get('stats')
  stats() {
    return this.language.stats();
  }

  @Get('lexicon')
  list(@Query(new ZodPipe(z.object({ lang: lang.optional(), status: z.enum(['LEARNED', 'APPROVED', 'REJECTED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }))) q: { lang?: string; status?: 'LEARNED' | 'APPROVED' | 'REJECTED'; limit: number; offset: number }) {
    return this.lexicon.list(q);
  }

  @Patch('lexicon')
  async setStatus(@Body(new ZodPipe(z.object({ lang, asrWord: z.string().min(1).max(100), lyricWord: z.string().min(1).max(100), status: z.enum(['LEARNED', 'APPROVED', 'REJECTED']) }))) b: { lang: string; asrWord: string; lyricWord: string; status: 'LEARNED' | 'APPROVED' | 'REJECTED' }, @Req() req: AdminRequest) {
    const ok = await this.lexicon.setStatus(b.lang, b.asrWord, b.lyricWord, b.status);
    if (ok) await this.audit.record({ actor: req.admin.email, action: 'language.lexicon.set-status', entityType: 'lexicon', entityId: `${b.lang}:${b.asrWord}>${b.lyricWord}`, after: { status: b.status } });
    return { updated: ok };
  }

  @Delete('lexicon')
  @HttpCode(204)
  async remove(@Query(new ZodPipe(z.object({ lang, asrWord: z.string().min(1), lyricWord: z.string().min(1) }))) q: { lang: string; asrWord: string; lyricWord: string }, @Req() req: AdminRequest): Promise<void> {
    if (await this.lexicon.remove(q.lang, q.asrWord, q.lyricWord)) await this.audit.record({ actor: req.admin.email, action: 'language.lexicon.delete', entityType: 'lexicon', entityId: `${q.lang}:${q.asrWord}>${q.lyricWord}` });
  }

  /** Asks the configured LLM to approve/reject learned spellings (needs Settings → Language model). */
  @Post('review')
  @HttpCode(200)
  async review(@Body(new ZodPipe(z.object({ lang, limit: z.number().int().min(1).max(100).default(40) }))) b: { lang: 'fa' | 'en' | 'mixed'; limit: number }, @Req() req: AdminRequest) {
    const res = await this.language.reviewWithLlm(b.lang, b.limit);
    await this.audit.record({ actor: req.admin.email, action: 'language.review', entityType: 'lexicon', entityId: b.lang, after: res });
    return res;
  }

  /** Re-aligns already transcribed songs with what the system has learned so far (no Whisper calls). */
  @Post('retrain')
  @HttpCode(200)
  async retrain(@Body(new ZodPipe(z.object({ limit: z.number().int().min(1).max(500).default(100), offset: z.number().int().min(0).default(0) }).default({ limit: 100, offset: 0 }))) b: { limit: number; offset: number }, @Req() req: AdminRequest) {
    const res = await this.language.retrain(b.limit, b.offset);
    await this.audit.record({ actor: req.admin.email, action: 'language.retrain', entityType: 'lexicon', after: res });
    return res;
  }

  /** Training dataset (JSONL) for fine-tuning a speech model on your Persian/English songs. */
  @Get('export')
  async export(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="radio_rainy_training.jsonl"');
    for await (const line of this.language.exportJsonl()) if (!res.write(line)) await new Promise<void>((r) => res.once('drain', r));
    res.end();
  }
}
