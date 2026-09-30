import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Account {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  creditCents: number;
  createdAt: string;
}
export interface AccountUser {
  id: string;
  accountId: string;
  email: string;
  passwordHash: string;
}
export interface AccountSummary extends Account {
  email: string | null;
  campaigns: number;
  stations: number;
}
export interface LedgerEntry {
  id: number;
  amountCents: number;
  balanceAfter: number;
  kind: 'TOPUP' | 'PLAY' | 'CLICK' | 'ADJUST';
  refId: string | null;
  note: string | null;
  createdAt: string;
}

interface AccRow {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  credit_cents: string;
  created_at: Date;
}
const toAccount = (r: AccRow): Account => ({ id: r.id, name: r.name, status: r.status, creditCents: Number(r.credit_cents), createdAt: r.created_at.toISOString() });

export class EmailTakenError extends Error {}

@Injectable()
export class AccountsRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(name: string, email: string, passwordHash: string): Promise<{ account: Account; userId: string }> {
    try {
      return await this.db.tx(async (q) => {
        const a = await q.query<AccRow>('INSERT INTO accounts (name) VALUES ($1) RETURNING *', [name]);
        const account = toAccount(a.rows[0] as AccRow);
        const u = await q.query<{ id: string }>('INSERT INTO account_users (account_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [account.id, email.trim(), passwordHash]);
        return { account, userId: u.rows[0]?.id ?? '' };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new EmailTakenError('This email is already registered');
      throw err;
    }
  }

  async userByEmail(email: string): Promise<AccountUser | null> {
    const r = await this.db.query<{ id: string; account_id: string; email: string; password_hash: string }>('SELECT id, account_id, email, password_hash FROM account_users WHERE lower(email) = lower($1)', [email.trim()]);
    const u = r.rows[0];
    return u ? { id: u.id, accountId: u.account_id, email: u.email, passwordHash: u.password_hash } : null;
  }

  async touchLogin(userId: string): Promise<void> {
    await this.db.query('UPDATE account_users SET last_login_at = now() WHERE id = $1', [userId]);
  }

  async get(id: string): Promise<Account | null> {
    const r = await this.db.query<AccRow>('SELECT * FROM accounts WHERE id = $1', [id]);
    return r.rows[0] ? toAccount(r.rows[0]) : null;
  }

  async list(): Promise<AccountSummary[]> {
    const r = await this.db.query<AccRow & { email: string | null; campaigns: string; stations: string }>(
      `SELECT a.*, (SELECT email FROM account_users u WHERE u.account_id = a.id ORDER BY created_at LIMIT 1) AS email,
              (SELECT count(*) FROM ads WHERE account_id = a.id) AS campaigns, (SELECT count(*) FROM channels WHERE owner_account_id = a.id) AS stations
         FROM accounts a ORDER BY a.created_at DESC`,
    );
    return r.rows.map((x) => ({ ...toAccount(x), email: x.email, campaigns: Number(x.campaigns), stations: Number(x.stations) }));
  }

  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<boolean> {
    return ((await this.db.query('UPDATE accounts SET status = $2 WHERE id = $1', [id, status])).rowCount ?? 0) > 0;
  }

  /** Adds (positive) or removes (negative) credit and records it, atomically. Returns the new balance. */
  async addLedger(accountId: string, amountCents: number, kind: LedgerEntry['kind'], refId: string | null, note: string | null): Promise<number | null> {
    return this.db.tx(async (q) => {
      const r = await q.query<{ credit_cents: string }>('UPDATE accounts SET credit_cents = credit_cents + $2 WHERE id = $1 RETURNING credit_cents', [accountId, amountCents]);
      if (!r.rows[0]) return null;
      const balance = Number(r.rows[0].credit_cents);
      await q.query('INSERT INTO credit_ledger (account_id, amount_cents, balance_after, kind, ref_id, note) VALUES ($1,$2,$3,$4,$5,$6)', [accountId, amountCents, balance, kind, refId, note]);
      return balance;
    });
  }

  async ledger(accountId: string, limit = 100): Promise<LedgerEntry[]> {
    const r = await this.db.query<{ id: string; amount_cents: string; balance_after: string; kind: LedgerEntry['kind']; ref_id: string | null; note: string | null; created_at: Date }>(
      'SELECT * FROM credit_ledger WHERE account_id = $1 ORDER BY id DESC LIMIT $2',
      [accountId, limit],
    );
    return r.rows.map((x) => ({ id: Number(x.id), amountCents: Number(x.amount_cents), balanceAfter: Number(x.balance_after), kind: x.kind, refId: x.ref_id, note: x.note, createdAt: x.created_at.toISOString() }));
  }
}
