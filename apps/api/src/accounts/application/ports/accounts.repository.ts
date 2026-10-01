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

export abstract class AccountsRepository {
  abstract create(name: string, email: string, passwordHash: string): Promise<{ account: Account; userId: string }>;
  abstract userByEmail(email: string): Promise<AccountUser | null>;
  abstract touchLogin(userId: string): Promise<void>;
  abstract get(id: string): Promise<Account | null>;
  abstract list(): Promise<AccountSummary[]>;
  abstract setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<boolean>;
  /** Adds (positive) or removes (negative) credit and records it, atomically. Returns the new balance. */
  abstract addLedger(accountId: string, amountCents: number, kind: LedgerEntry['kind'], refId: string | null, note: string | null): Promise<number | null>;
  abstract ledger(accountId: string, limit?: number): Promise<LedgerEntry[]>;
}

export class EmailTakenError extends Error {}
