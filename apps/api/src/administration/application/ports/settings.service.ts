import { z } from 'zod';

export type StorageSettingsInput = z.infer<typeof storageSettingsSchema>;

export interface StorageSettings {
  endpoint: string;
  port: number;
  useSsl: boolean;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

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
  storage?: StorageSettings;
  telegram?: TelegramCredentials;
  whisper?: Partial<WhisperSettings> & { url: string };
}

/**
 * Runtime settings edited from the admin panel. Plain values live in a JSONB column; secrets (Telegram API hash,
 * Whisper/LLM keys) are encrypted with AES-256-GCM and never returned by any API (only "is set" flags).
 * Environment variables remain as an optional fallback for bootstrap.
 */
export abstract class SettingsService {
  abstract onChange(cb: (section: Section) => void): () => void;
  // ---- effective values ----
  abstract telegram(): Promise<TelegramCredentials | null>;
  abstract whisper(): Promise<WhisperSettings | null>;
  abstract llm(): Promise<LlmSettings | null>;
  /** Audio cache (MinIO / any S3-compatible store); null when disabled or incomplete. */
  abstract storage(): Promise<StorageSettings | null>;
  // ---- panel views (never contain secrets) ----
  abstract view(): Promise<{
    telegram: { apiId: number | null; apiHashSet: boolean; source: 'database' | 'environment' | 'none' };
    whisper: { url: string; model: string; language: string; sampleRate: number; timeoutSeconds: number; apiKeySet: boolean; enabled: boolean; source: 'database' | 'environment' | 'none' };
    llm: { enabled: boolean; url: string; model: string; apiKeySet: boolean };
    storage: { enabled: boolean; endpoint: string; port: number; useSsl: boolean; bucket: string; keysSet: boolean; active: boolean; source: 'database' | 'environment' | 'none' };
  }>;
  // ---- updates ----
  abstract updateTelegram(input: TelegramSettingsInput, actor: string): Promise<void>;
  abstract updateWhisper(input: WhisperSettingsInput, actor: string): Promise<void>;
  abstract updateStorage(input: StorageSettingsInput, actor: string): Promise<void>;
  abstract updateLlm(input: LlmSettingsInput, actor: string): Promise<void>;
}

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

export const storageSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** host (optionally host:port); a scheme like http:// is stripped */
  endpoint: z.string().trim().max(255).default(''),
  port: z.number().int().min(1).max(65535).default(9000),
  useSsl: z.boolean().default(false),
  bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{2,62}$/, 'bucket: 3-63 chars, lowercase letters, digits, dots, dashes').default('radio-rainy-audio'),
  accessKey: z.string().max(200).optional(),
  secretKey: z.string().max(200).optional(),
  clearKeys: z.boolean().optional(),
});

export type Section = 'telegram' | 'whisper' | 'llm' | 'storage';
