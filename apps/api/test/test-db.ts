import { DatabaseService } from '../src/database/database.service';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/radio_rainy_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

/** Fresh schema for each test file. */
export async function freshDb(): Promise<DatabaseService> {
  const db = new DatabaseService({ DATABASE_URL: TEST_DATABASE_URL });
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await db.migrate();
  return db;
}
