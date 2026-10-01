import { AdminUsersRepository, AdminUser, AdminUserStore } from '../application/ports/admin-users.repository';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';

interface Row {
  id: string;
  username: string;
  password_hash: string;
  must_change_password: boolean;
}
const map = (r: Row): AdminUser => ({ id: r.id, username: r.username, passwordHash: r.password_hash, mustChangePassword: r.must_change_password });

@Injectable()
export class PgAdminUsersRepository implements AdminUserStore , AdminUsersRepository{
  constructor(private readonly db: DatabaseService) {}

  async findByUsername(username: string): Promise<AdminUser | null> {
    const r = await this.db.query<Row>('SELECT * FROM admin_users WHERE lower(username) = lower($1)', [username.trim()]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }

  async get(id: string): Promise<AdminUser | null> {
    const r = await this.db.query<Row>('SELECT * FROM admin_users WHERE id = $1', [id]);
    return r.rows[0] ? map(r.rows[0]) : null;
  }

  async count(): Promise<number> {
    return Number((await this.db.query<{ n: string }>('SELECT count(*) AS n FROM admin_users')).rows[0]?.n ?? 0);
  }

  async create(username: string, passwordHash: string, mustChangePassword: boolean): Promise<AdminUser> {
    const r = await this.db.query<Row>('INSERT INTO admin_users (username, password_hash, must_change_password) VALUES ($1, $2, $3) RETURNING *', [username.trim(), passwordHash, mustChangePassword]);
    return map(r.rows[0] as Row);
  }

  async setPassword(id: string, passwordHash: string, mustChangePassword: boolean): Promise<void> {
    await this.db.query('UPDATE admin_users SET password_hash = $2, must_change_password = $3, password_changed_at = now() WHERE id = $1', [id, passwordHash, mustChangePassword]);
  }
}
