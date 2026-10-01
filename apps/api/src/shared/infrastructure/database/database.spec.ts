import { freshDb } from '../../../../test/test-db';
import { DatabaseService } from './database.service';

describe('DatabaseService', () => {
  let db: DatabaseService;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it('migrations are idempotent', async () => {
    expect(await db.migrate()).toEqual([]);
  });

  it('seeds singleton config and state rows', async () => {
    expect((await db.query('SELECT count(*)::int AS n FROM radio_configuration')).rows[0]).toEqual({ n: 1 });
    expect((await db.query('SELECT count(*)::int AS n FROM radio_state')).rows[0]).toEqual({ n: 1 });
  });

  it('enforces UNIQUE(channel, message)', async () => {
    const ins = () =>
      db.query(`INSERT INTO tracks (telegram_channel_id, telegram_message_id, title, telegram_file_reference) VALUES (1, 1, 't', 'r')`);
    await ins();
    await expect(ins()).rejects.toThrow(/tracks_channel_message_uq/);
  });

  it('tx rolls back on error', async () => {
    await expect(
      db.tx(async (q) => {
        await q.query(`INSERT INTO hashtags (value, normalized_value) VALUES ('X','x')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.query(`SELECT count(*)::int AS n FROM hashtags`)).rows[0]).toEqual({ n: 0 });
  });

  it('advisory lock is exclusive and releasable', async () => {
    const a = await db.tryAdvisoryLock(999);
    expect(a).not.toBeNull();
    expect(await db.tryAdvisoryLock(999)).toBeNull();
    await a?.();
    const b = await db.tryAdvisoryLock(999);
    expect(b).not.toBeNull();
    await b?.();
  });
});
