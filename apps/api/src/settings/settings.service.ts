import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service';
import { SessionCipher } from '../telegram/session-cipher';

// ---- section schemas (what the admin panel may set) ----
export const telegramSettingsSchema = z.object({
  apiId: z.number().int().positive(),
  /** Omitted/empty = keep the stored value. */
  apiHash: z.string().trim().min(8).max(200).optional(),
});
export const whisperSettingsSchema = z.object({
  url: z.string().trim().url().or(z.literal('')).default(''),
  model: z.string().trim().min(1).max(200).default('whisper-1'),
  language: z.string().trim().max(10).default(''),
  sampleRate: z.number().int().min(8000).max(96000).default(48000),
  timeoutSeconds: z.number().int().min(10).max(7200).default(900),
  apiKey: z.string().max(500).optional(),
  /** true removes the stored key */
  clearApiKey: z.boolean().optional(),
});
export const llmSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().trim().url().or(z.literal('')).default(''),
  model: z.string().trim().max(200).default(''),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().optional(),
});
export type TelegramSettingsInput = z.infer<typeof telegramSettingsSchema>;
export type WhisperSettingsInput = z.infer<typeof whisperSettingsSchema>;
export type LlmSettingsInput = z.infer<typeof llmSettingsSchema>;

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}
export interface WhisperSettings {
  url: string;
  model: string;
  language: string | undefined;
  sampleRate: number;
  timeoutSeconds: number;
  apiKey: string | undefined;
}
export interface LlmSettings {
  enabled: boolean;
  url: string;
  model: string;
  apiKey: string | undefined;
}

export interface EnvFallbacks {
  telegram?: TelegramCredentials;
  whisper?: Partial<WhisperSettings> & { url: string };
}

type Section = 'telegram' | 'whisper' | 'llm';
interface Stored {
  plain: Record<string, unknown>;
  secrets: Record<string, string>;
}

const CACHE_MS = 5_000;

/**
 * Runtime settings edited from the admin panel. Plain values live in a JSONB column; secrets (Telegram API hash,
 * Whisper/LLM keys) are encrypted with AES-256-GCM and never returned by any API (only "is set" flags).
 * Environment variables remain as an optional fallback for bootstrap.
 */
@Injectable()
export class SettingsService {
  private cache = new Map<Section, { at: number; value: Stored }>();
  private listeners = new Set<(section: Section) => void>();

  constructor(
    private readonly db: DatabaseService,
    private readonly cipher: SessionCipher,
    private readonly env: EnvFallbacks = {},
  ) {}

  onChange(cb: (section: Section) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private async load(section: Section): Promise<Stored> {
    const hit = this.cache.get(section);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const r = await this.db.query<{ plain: Record<string, unknown>; secret_ciphertext: string | null }>('SELECT plain, secret_ciphertext FROM app_settings WHERE key = $1', [section]);
    const row = r.rows[0];
    const value: Stored = { plain: row?.plain ?? {}, secrets: row?.secret_ciphertext ? (JSON.parse(this.cipher.decrypt(row.secret_ciphertext)) as Record<string, string>) : {} };
    this.cache.set(section, { at: Date.now(), value });
    return value;
  }

  private async save(section: Section, plain: Record<string, unknown>, secrets: Record<string, string>, actor: string): Promise<void> {
    const ciphertext = Object.keys(secrets).length > 0 ? this.cipher.encrypt(JSON.stringify(secrets)) : null;
    await this.db.query(
      `INSERT INTO app_settings (key, plain, secret_ciphertext, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET plain = $2, secret_ciphertext = $3, updated_by = $4, updated_at = now()`,
      [section, JSON.stringify(plain), ciphertext, actor],
    );
    this.cache.delete(section);
    for (const l of this.listeners) l(section);
  }

  // ---- effective values ----

  async telegram(): Promise<TelegramCredentials | null> {
    const s = await this.load('telegram');
    const apiId = Number(s.plain.apiId);
    if (apiId > 0 && s.secrets.apiHash) return { apiId, apiHash: s.secrets.apiHash };
    return this.env.telegram ?? null;
  }

  async whisper(): Promise<WhisperSettings | null> {
    const s = await this.load('whisper');
    const url = typeof s.plain.url === 'string' ? s.plain.url : '';
    if (url) {
      return {
        url,
        model: String(s.plain.model ?? 'whisper-1'),
        language: s.plain.language ? String(s.plain.language) : undefined,
        sampleRate: Number(s.plain.sampleRate ?? 48000),
        timeoutSeconds: Number(s.plain.timeoutSeconds ?? 900),
        apiKey: s.secrets.apiKey,
      };
    }
    const e = this.env.whisper;
    return e ? { url: e.url, model: e.model ?? 'whisper-1', language: e.language, sampleRate: e.sampleRate ?? 48000, timeoutSeconds: e.timeoutSeconds ?? 900, apiKey: e.apiKey } : null;
  }

  async llm(): Promise<LlmSettings | null> {
    const s = await this.load('llm');
    if (!s.plain.enabled || !s.plain.url) return null;
    return { enabled: true, url: String(s.plain.url), model: String(s.plain.model ?? ''), apiKey: s.secrets.apiKey };
  }

  // ---- panel views (never contain secrets) ----

  async view(): Promise<{
    telegram: { apiId: number | null; apiHashSet: boolean; source: 'database' | 'environment' | 'none' };
    whisper: { url: string; model: string; language: string; sampleRate: number; timeoutSeconds: number; apiKeySet: boolean; enabled: boolean; source: 'database' | 'environment' | 'none' };
    llm: { enabled: boolean; url: string; model: string; apiKeySet: boolean };
  }> {
    const [t, w, l] = await Promise.all([this.load('telegram'), this.load('whisper'), this.load('llm')]);
    const tDb = Number(t.plain.apiId) > 0 && Boolean(t.secrets.apiHash);
    const wDb = typeof w.plain.url === 'string' && w.plain.url !== '';
    const effT = await this.telegram();
    const effW = await this.whisper();
    return {
      telegram: { apiId: effT?.apiId ?? null, apiHashSet: effT !== null, source: tDb ? 'database' : effT ? 'environment' : 'none' },
      whisper: {
        url: effW?.url ?? '',
        model: effW?.model ?? 'whisper-1',
        language: effW?.language ?? '',
        sampleRate: effW?.sampleRate ?? 48000,
        timeoutSeconds: effW?.timeoutSeconds ?? 900,
        apiKeySet: Boolean(effW?.apiKey),
        enabled: effW !== null,
        source: wDb ? 'database' : effW ? 'environment' : 'none',
      },
      llm: { enabled: Boolean(l.plain.enabled), url: String(l.plain.url ?? ''), model: String(l.plain.model ?? ''), apiKeySet: Boolean(l.secrets.apiKey) },
    };
  }

  // ---- updates ----

  async updateTelegram(input: TelegramSettingsInput, actor: string): Promise<void> {
    const cur = await this.load('telegram');
    const secrets = { ...cur.secrets };
    if (input.apiHash) secrets.apiHash = input.apiHash;
    if (!secrets.apiHash) throw new Error('API hash is required the first time');
    await this.save('telegram', { apiId: input.apiId }, secrets, actor);
  }

  async updateWhisper(input: WhisperSettingsInput, actor: string): Promise<void> {
    const cur = await this.load('whisper');
    const secrets = { ...cur.secrets };
    if (input.clearApiKey) delete secrets.apiKey;
    else if (input.apiKey) secrets.apiKey = input.apiKey;
    await this.save('whisper', { url: input.url, model: input.model, language: input.language, sampleRate: input.sampleRate, timeoutSeconds: input.timeoutSeconds }, secrets, actor);
  }

  async updateLlm(input: LlmSettingsInput, actor: string): Promise<void> {
    const cur = await this.load('llm');
    const secrets = { ...cur.secrets };
    if (input.clearApiKey) delete secrets.apiKey;
    else if (input.apiKey) secrets.apiKey = input.apiKey;
    await this.save('llm', { enabled: input.enabled, url: input.url, model: input.model }, secrets, actor);
  }
}
