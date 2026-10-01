import { TxHandle } from '../../../shared/kernel/transaction';

export interface AuditEntry {
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
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

export abstract class AuditService {
  abstract record(e: AuditEntry, q?: TxHandle): Promise<void>;
  abstract list(opts: { limit: number; offset: number; action?: string; entityType?: string }): Promise<{ total: number; items: AuditRow[] }>;
}
