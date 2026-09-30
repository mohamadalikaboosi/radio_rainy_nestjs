import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { MIGRATIONS } from './migrations';

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

/** Stable 64-bit-ish advisory lock keys. */
export const LOCKS = { MIGRATE: 7_100_001, PLAYBACK_LEADER: 7_100_002 } as const;

@Injectable()
export class DatabaseService implements Queryable, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: Pick<AppConfig, 'DATABASE_URL'>) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: 20 });
    this.pool.on('error', (err) => this.logger.error({ msg: 'idle pg client error', err: err.message }));
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as unknown[]);
  }

  /** Runs `fn` in a transaction (rolled back on any error). */
  async tx<R>(fn: (q: Queryable) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        this.logger.error({ msg: 'rollback failed', err: String(rollbackErr) });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Tries to take a session-level advisory lock on a dedicated connection.
   * Returns a release function, or null when someone else holds it. The lock is released
   * automatically if the connection dies (leader failover).
   */
  async tryAdvisoryLock(key: number): Promise<(() => Promise<void>) | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      if (!res.rows[0]?.locked) {
        client.release();
        return null;
      }
    } catch (err) {
      client.release();
      throw err;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
      } catch (err) {
        this.logger.warn({ msg: 'advisory unlock failed', err: String(err) });
      } finally {
        client.release();
      }
    };
  }

  async migrate(): Promise<string[]> {
    const client = await this.pool.connect();
    const applied: string[] = [];
    try {
      await client.query('SELECT pg_advisory_lock($1)', [LOCKS.MIGRATE]);
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const done = new Set((await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        try {
          await client.query('BEGIN');
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
          await client.query('COMMIT');
          applied.push(m.id);
          this.logger.log({ msg: 'migration applied', id: m.id });
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCKS.MIGRATE]);
      } finally {
        client.release();
      }
    }
    return applied;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
