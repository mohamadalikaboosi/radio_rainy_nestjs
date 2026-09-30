import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from '../test/test-db';
import { freshDb } from '../test/test-db';
import { AppModule } from './app.module';

describe('AppModule smoke (real Postgres + Redis, no Telegram session)', () => {
  let app: INestApplication;
  const saved = { ...process.env };

  beforeAll(async () => {
    const db = await freshDb();
    await db.onModuleDestroy();
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      TELEGRAM_API_ID: '12345',
      TELEGRAM_API_HASH: 'hash',
      TELEGRAM_CHANNEL: '@chan',
      TELEGRAM_SESSION_ENCRYPTION_KEY: 'ab'.repeat(32),
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      QUEUE_PREFIX: `smoke-${Date.now()}`,
      ADMIN_EMAIL: 'a@b.co',
      ADMIN_PASSWORD_HASH: 'scrypt$aa$bb',
      JWT_SECRET: 'x'.repeat(40),
    });
    delete process.env.WHISPER_URL;
    delete process.env.TELEGRAM_SESSION;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    process.env = saved;
  });

  it('boots without Telegram credentials session or Whisper, and serves public state', async () => {
    const res = await request(app.getHttpServer()).get('/radio/current').expect(200);
    expect(['IDLE', 'STOPPED']).toContain(res.body.status);
  });
});
