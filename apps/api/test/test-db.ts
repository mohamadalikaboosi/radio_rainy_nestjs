import { DatabaseService } from '../src/shared/infrastructure/database/database.service';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/radio_rainy_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

/** Fresh schema for each test file. */
export async function freshDb(): Promise<DatabaseService> {
  const db = new DatabaseService({ DATABASE_URL: TEST_DATABASE_URL });
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await db.migrate();
  await addTestChannel(db, '1001', 'chan');
  return db;
}

/** Creates a station (channel + its radio configuration/state rows), like the admin "add channel" action does. */
export async function addTestChannel(db: DatabaseService, id: string, slug: string, opts: { started?: boolean; title?: string } = {}): Promise<void> {
  await db.query(`INSERT INTO channels (telegram_channel_id, reference, title, username, slug, started) VALUES ($1, $2, $3, $2, $4, $5) ON CONFLICT DO NOTHING`, [id, `@${slug}`, opts.title ?? `Channel ${slug}`, slug, opts.started ?? true]);
  await db.query('INSERT INTO radio_configuration (channel_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  await db.query('INSERT INTO radio_state (channel_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
}
