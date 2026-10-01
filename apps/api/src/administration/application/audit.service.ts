import { Injectable } from '@nestjs/common';
import { DatabaseService, Queryable } from '../../shared/infrastructure/database/database.service';

export interface AuditEntry {
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

const SENSITIVE = /password|secret|token|session|hash|apikey|api_key/i;

/** Removes anything that looks like a secret before persisting: audit logs must never hold credentials. */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : scrub(v)]));
  }
  return value;
}

export interface AuditRow {
  id: string;
  at: Date;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  async record(e: AuditEntry, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO audit_logs (actor, action, entity_type, entity_id, before, after, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.actor, e.action, e.entityType, e.entityId ?? null, e.before === undefined ? null : JSON.stringify(scrub(e.before)), e.after === undefined ? null : JSON.stringify(scrub(e.after)), e.requestId ?? null],
    );
  }

  async list(opts: { limit: number; offset: number; action?: string; entityType?: string }): Promise<{ total: number; items: AuditRow[] }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.action) where.push(`action = $${params.push(opts.action)}`);
    if (opts.entityType) where.push(`entity_type = $${params.push(opts.entityType)}`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_logs ${w}`, params)).rows[0]?.n ?? 0);
    const rows = await this.db.query<{ id: string; at: Date; actor: string; action: string; entity_type: string; entity_id: string | null; before: unknown; after: unknown }>(
      `SELECT id, at, actor, action, entity_type, entity_id, before, after FROM audit_logs ${w} ORDER BY at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, opts.limit, opts.offset],
    );
    return { total, items: rows.rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, entityType: r.entity_type, entityId: r.entity_id, before: r.before, after: r.after })) };
  }
}
