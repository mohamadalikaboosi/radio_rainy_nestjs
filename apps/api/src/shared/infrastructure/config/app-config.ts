import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Telegram API credentials are normally set from the admin panel (stored encrypted in the DB); env is an optional fallback. */
  TELEGRAM_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_API_HASH: z.string().min(1).optional(),
  /** Optional bootstrap only: normally the session is created via the Super Admin login flow and stored encrypted in the DB. */
  TELEGRAM_SESSION: z.string().optional(),
  /** 32-byte key (64 hex chars) that encrypts ALL secrets stored in the DB (Telegram session/API hash, Whisper and LLM keys) with AES-256-GCM. */
  TELEGRAM_SESSION_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected 64 hex characters (32 bytes)'),

  TELEGRAM_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(300),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  QUEUE_PREFIX: z.string().default('radio_rainy'),

  RADIO_RECENT_TRACK_WINDOW: z.coerce.number().int().min(0).default(10),
  /** Seconds of audio sent in a burst to new listeners; lower = lower latency. */
  RADIO_PREBUFFER_SECONDS: z.coerce.number().min(0).max(30).default(2),
  /** Start selecting + downloading the NEXT track this many seconds before the current one ends. */
  RADIO_PREFETCH_SECONDS: z.coerce.number().min(5).max(600).default(90),
  /** The next track is downloaded COMPLETELY (into memory/disk cache) before it goes on air; the current track is never waited for. */
  RADIO_BUFFER_WHOLE_TRACK: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** How long a transition waits for the pre-fetched track's first bytes before it gives up on it and picks another track. */
  RADIO_PREFETCH_TIMEOUT_SECONDS: z.coerce.number().min(1).max(300).default(60),
  /** Data-saver stream (`?quality=low`): one extra ffmpeg per station, only while somebody listens to it. */
  RADIO_LOW_QUALITY_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  RADIO_LOW_BITRATE_KBPS: z.coerce.number().int().min(16).max(96).default(48),
  RADIO_STREAM_BITRATE_KBPS: z.coerce.number().int().min(32).max(320).default(128),

  WHISPER_PROVIDER: z.enum(['openai-compatible']).default('openai-compatible'),
  WHISPER_MODEL: z.string().min(1).default('whisper-1'),
  /** Optional: when unset, AI lyrics synchronization is disabled entirely (radio and plain lyrics still work). */
  WHISPER_URL: z.string().url().optional(),
  WHISPER_API_KEY: z.string().optional(),
  WHISPER_LANGUAGE: z.string().optional(),
  WHISPER_SAMPLE_RATE: z.coerce.number().int().min(8000).max(96000).default(48000),
  WHISPER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),

  /** Optional S3-compatible audio cache (MinIO). Normally configured in the panel (Settings -> Audio storage). */
  MINIO_ENDPOINT: z.string().optional(),
  MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  MINIO_USE_SSL: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  MINIO_BUCKET: z.string().default('radio-rainy-audio'),
  MINIO_ACCESS_KEY: z.string().optional(),
  MINIO_SECRET_KEY: z.string().optional(),
  /** Local audio cache (every downloaded track is kept here; Telegram is hit once per track). 0 MB disables it. */
  AUDIO_CACHE_DIR: z.string().optional(),
  AUDIO_CACHE_MAX_MB: z.coerce.number().int().min(0).default(1024),
  /** Bytes per Telegram download request (KiB): a download is one request after another, so bigger = faster. */
  /** The song/ad text on the Telegram live video changes this long after the engine switched, to match what is heard there (prebuffer + encoder queue). */
  TELEGRAM_LIVE_TEXT_DELAY_SECONDS: z.coerce.number().min(0).max(60).default(3),
  TELEGRAM_DOWNLOAD_REQUEST_KB: z.coerce.number().int().refine((n) => [64, 128, 256, 512, 1024].includes(n), 'must be 64, 128, 256, 512 or 1024').default(512),
  AUDIO_CACHE_CONCURRENT_FILLS: z.coerce.number().int().min(1).max(8).default(2),
  /** Enables GET /metrics (Prometheus text) for `Authorization: Bearer <token>`. Unset = endpoint disabled. */
  METRICS_TOKEN: z.string().min(16).optional(),
  LYRICS_CACHE_TTL: z.coerce.number().int().positive().default(86_400),
  /** Built admin UI (apps/admin/dist). When set (or found next to the API), the API also serves the panel and player. */
  ADMIN_UI_DIR: z.string().optional(),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  TMP_DIR: z.string().default('/tmp/radio_rainy'),

  /** Optional bootstrap of the first Super Admin (used only when the database has no admin yet). Without them the first start seeds admin / admin, which MUST be changed at the first login. */
  ADMIN_EMAIL: z.string().trim().min(1).max(200).optional(),
  ADMIN_PASSWORD_HASH: z.string().optional().refine((v) => v === undefined || /^scrypt[:$][0-9a-f]+[:$][0-9a-f]+$/.test(v), 'expected scrypt:<saltHex>:<hashHex> (generate with: pnpm --silent --filter @radio_rainy/api hash-password <password>)'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
});

export type AppConfig = z.infer<typeof envSchema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigError extends Error {}

/** Validates the environment once at startup. Throws with every problem listed; never continues half-configured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty value (`WHISPER_URL=` in .env) means "not set", never an error.
  // Windows .env files often carry a trailing \r (CRLF), stray spaces or quotes: normalize before validating.
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [k, raw] of Object.entries(env)) {
    if (raw === undefined) continue;
    const v = raw.trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
    if (v !== '') cleaned[k] = v;
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}${hint(String(i.path[0] ?? ''), cleaned[String(i.path[0] ?? '')])}`)
      .join('\n');
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
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
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

/** Non-secret diagnostics for the most common .env mistakes (never prints the value itself, only its shape). */
function hint(key: string, value: string | undefined): string {
  if (value === undefined) return ' [missing or empty]';
  if (key === 'ADMIN_PASSWORD_HASH') {
    const colons = (value.match(/:/g) ?? []).length;
    return ` [got ${value.length} chars, starts with "${value.slice(0, 7)}", ${colons} ':' separators; expected ~168 hex chars after "scrypt:" salt:hash — copy ONLY the line printed by hash-password]`;
  }
  return ` [got ${value.length} chars]`;
}

export function isWhisperEnabled(cfg: Pick<AppConfig, 'WHISPER_URL'>): boolean {
  return cfg.WHISPER_URL !== undefined;
}
