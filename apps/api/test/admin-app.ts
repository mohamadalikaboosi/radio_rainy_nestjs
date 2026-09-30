import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/admin/password';
import { JobsRunner } from '../src/jobs/jobs-runner';
import { TelegramClientManager } from '../src/telegram/telegram-client.manager';
import { GramJsLiveApi } from '../src/live/gramjs-live-api';
import { TELEGRAM_GATEWAY, TelegramNotReadyError } from '../src/telegram/telegram.types';
import { FakeTelegramGateway } from './fake-telegram';
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
export async function bootAdminApp(opts: { defaultAdmin?: boolean } = {}): Promise<{ app: INestApplication; manager: FakeTelegramManager; gateway: FakeTelegramGateway; restore: () => void }> {
  const db = await freshDb();
  await db.query('UPDATE channels SET started = false');
  await db.onModuleDestroy();
  const saved = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TELEGRAM_API_ID: '12345',
    TELEGRAM_API_HASH: 'hash-secret-value',
    TELEGRAM_SESSION_ENCRYPTION_KEY: 'ab'.repeat(32),
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    QUEUE_PREFIX: `admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD_HASH: await hashPassword(ADMIN.password),
    JWT_SECRET: 'j'.repeat(40),
  });
  if (opts.defaultAdmin) {
    // no operator-provided credentials: the first start seeds admin / admin
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD_HASH;
  }
  delete process.env.WHISPER_URL;
  delete process.env.TELEGRAM_SESSION;
  const manager = fakeManager();
  const gateway = new FakeTelegramGateway();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TelegramClientManager)
    .useValue(manager)
    .overrideProvider(JobsRunner)
    .useValue({})
    .overrideProvider(TELEGRAM_GATEWAY)
    .useValue(gateway)
    .overrideProvider('LLM_CLIENT')
    .useValue({
      chat: async (msgs: { role: string; content: string }[]) => {
        // deterministic fake linguist: odd ids are the same word, even ids are different words
        const list = JSON.parse(String(msgs[1]?.content).split('\n')[1] ?? '[]') as { id: number }[];
        return `Sure!\n${JSON.stringify(list.map((x) => ({ id: x.id, same: x.id % 2 === 1 })))}`;
      },
    })
    .overrideProvider(GramJsLiveApi)
    .useValue({ openLiveStream: async () => ({ url: 'rtmps://fake.example/s/', key: 'k-123' }), closeLiveStream: async () => undefined })
    .compile();
  const app = mod.createNestApplication();
  await app.init();
  return { app, manager, gateway, restore: () => void (process.env = saved) };
}
