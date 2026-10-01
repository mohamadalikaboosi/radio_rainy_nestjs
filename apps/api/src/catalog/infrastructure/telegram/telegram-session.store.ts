import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../shared/infrastructure/database/database.service';
import { SessionCipher } from '../../../shared/infrastructure/crypto/session-cipher';

export interface StoredSessionInfo {
  accountLabel: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

/** Persists the Telegram session encrypted at rest. Plaintext never touches the DB or logs. */
@Injectable()
export class TelegramSessionStore {
  constructor(private readonly db: Pick<DatabaseService, 'query'>, private readonly cipher: SessionCipher) {}

  async load(): Promise<string | null> {
    const res = await this.db.query<{ ciphertext: string }>('SELECT ciphertext FROM telegram_session WHERE id = 1');
    const row = res.rows[0];
    return row ? this.cipher.decrypt(row.ciphertext) : null;
  }

  async save(session: string, accountLabel: string | null, updatedBy: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO telegram_session (id, ciphertext, account_label, updated_by, updated_at)
       VALUES (1, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET ciphertext = $1, account_label = $2, updated_by = $3, updated_at = now()`,
      [this.cipher.encrypt(session), accountLabel, updatedBy],
    );
  }

  async clear(): Promise<void> {
    await this.db.query('DELETE FROM telegram_session WHERE id = 1');
  }

  async info(): Promise<StoredSessionInfo | null> {
    const res = await this.db.query<{ account_label: string | null; updated_at: Date; updated_by: string | null }>(
      'SELECT account_label, updated_at, updated_by FROM telegram_session WHERE id = 1',
    );
    const r = res.rows[0];
    return r ? { accountLabel: r.account_label, updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
  }
}

/** +989123456789 -> +98*********89 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\s+/g, '');
  if (digits.length <= 5) return '*'.repeat(digits.length);
  return `${digits.slice(0, 3)}${'*'.repeat(digits.length - 5)}${digits.slice(-2)}`;
}
