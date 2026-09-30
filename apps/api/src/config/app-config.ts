import { z } from 'zod';


export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().min(1),
  /** Optional bootstrap only: normally the session is created via the Super Admin login flow and stored encrypted in the DB. */
  TELEGRAM_SESSION: z.string().optional(),
  /** 32-byte key (64 hex chars) used to encrypt the Telegram session at rest (AES-256-GCM). */
  TELEGRAM_SESSION_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters (32 bytes)'),
  TELEGRAM_CHANNEL: z.string().min(1),
  TELEGRAM_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(300),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  RADIO_RECENT_TRACK_WINDOW: z.coerce.number().int().min(0).default(10),
  /** Seconds of audio sent in a burst to new listeners; lower = lower latency. */
  RADIO_PREBUFFER_SECONDS: z.coerce.number().min(0).max(30).default(2),
  RADIO_STREAM_BITRATE_KBPS: z.coerce.number().int().min(32).max(320).default(128),

  WHISPER_PROVIDER: z.enum(['openai-compatible']).default('openai-compatible'),
  WHISPER_MODEL: z.string().min(1).default('whisper-1'),
  WHISPER_URL: z.string().url(),
  WHISPER_API_KEY: z.string().optional(),
  WHISPER_LANGUAGE: z.string().optional(),
  WHISPER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),

  LYRICS_CACHE_TTL: z.coerce.number().int().positive().default(86_400),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  TMP_DIR: z.string().default('/tmp/radio_rainy'),

  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD_HASH: z.string().regex(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/, 'expected scrypt$<saltHex>$<hashHex>'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
});

export type AppConfig = z.infer<typeof envSchema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigError extends Error {}

/** Validates the environment once at startup. Throws with every problem listed; never continues half-configured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}

/** Keys whose values must never appear in logs. */
export const SECRET_KEYS: ReadonlyArray<keyof AppConfig> = [
  'TELEGRAM_API_HASH',
  'TELEGRAM_SESSION',
  'TELEGRAM_SESSION_ENCRYPTION_KEY',
  'WHISPER_API_KEY',
  'ADMIN_PASSWORD_HASH',
  'JWT_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
];

export function redactConfig(cfg: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  for (const k of SECRET_KEYS) if (out[k] !== undefined) out[k] = '[REDACTED]';
  return out;
}

