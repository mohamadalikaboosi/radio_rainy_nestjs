import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/admin/password';
import { JobsRunner } from '../src/jobs/jobs-runner';
import { TelegramClientManager } from '../src/telegram/telegram-client.manager';
import { TelegramNotReadyError } from '../src/telegram/telegram.types';
import { freshDb, TEST_DATABASE_URL, TEST_REDIS_URL } from './test-db';

export const ADMIN = { email: 'admin@example.com', password: 'correct horse battery' };

export interface FakeTelegramManager {
  state: string;
  calls: string[];
  getStatus(): { state: string; accountLabel: string | null };
  getClient(): never;
  beginLogin(phone: string, actor: string): Promise<void>;
  submitCode(code: string): Promise<'READY' | 'AWAITING_PASSWORD'>;
  submitPassword(password: string): Promise<void>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  needsPassword: boolean;
}

export function fakeManager(): FakeTelegramManager {
  const m: FakeTelegramManager = {
    state: 'NOT_LOGGED_IN',
    calls: [],
    needsPassword: false,
    getStatus: () => ({ state: m.state, accountLabel: m.state === 'READY' ? '+98********89' : null }),
    getClient: () => {
      throw new TelegramNotReadyError();
    },
    beginLogin: async (phone) => {
      m.calls.push(`start:${phone}`);
      m.state = 'AWAITING_CODE';
    },
    submitCode: async (code) => {
      m.calls.push(`code:${code}`);
      if (code === '00000') throw Object.assign(new Error('bad'), { errorMessage: 'PHONE_CODE_INVALID' });
      if (m.needsPassword) {
        m.state = 'AWAITING_PASSWORD';
        return 'AWAITING_PASSWORD';
      }
      m.state = 'READY';
      return 'READY';
    },
    submitPassword: async (pw) => {
      m.calls.push(`password:${pw}`);
      if (pw === 'wrong') throw Object.assign(new Error('bad'), { errorMessage: 'PASSWORD_HASH_INVALID' });
      m.state = 'READY';
    },
    cancelLogin: async () => {
      m.state = 'NOT_LOGGED_IN';
    },
    logout: async () => {
      m.state = 'NOT_LOGGED_IN';
    },
  };
  return m;
}

/** Boots the real AppModule (real Postgres + Redis), with Telegram login faked and job workers disabled. */
export async function bootAdminApp(): Promise<{ app: INestApplication; manager: FakeTelegramManager; restore: () => void }> {
  const db = await freshDb();
  await db.onModuleDestroy();
  const saved = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TELEGRAM_API_ID: '12345',
    TELEGRAM_API_HASH: 'hash-secret-value',
    TELEGRAM_CHANNEL: '@chan',
    TELEGRAM_SESSION_ENCRYPTION_KEY: 'ab'.repeat(32),
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    QUEUE_PREFIX: `admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD_HASH: await hashPassword(ADMIN.password),
    JWT_SECRET: 'j'.repeat(40),
  });
  delete process.env.WHISPER_URL;
  delete process.env.TELEGRAM_SESSION;
  const manager = fakeManager();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TelegramClientManager)
    .useValue(manager)
    .overrideProvider(JobsRunner)
    .useValue({})
    .compile();
  const app = mod.createNestApplication();
  await app.init();
  return { app, manager, restore: () => void (process.env = saved) };
}
