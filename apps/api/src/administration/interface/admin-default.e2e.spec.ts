import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootAdminApp } from '../../../test/admin-app';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { PgAdminUsersRepository } from '../infrastructure/admin-users.repository';
import { resetAdminPassword } from '../application/admin-seeder';


describe('first start: seeded admin / admin, forced password change, reset (e2e)', () => {
  let app: INestApplication;
  let restore: () => void;
  const http = () => request(app.getHttpServer());
  const A = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    ({ app, restore } = await bootAdminApp({ defaultAdmin: true }));
  });
  afterAll(async () => {
    await app.close();
    restore();
  });

  it('boots WITHOUT any admin credentials in the environment and seeds admin / admin', async () => {
    const db = app.get(DatabaseService);
    const rows = (await db.query<{ username: string; must_change_password: boolean }>('SELECT username, must_change_password FROM admin_users')).rows;
    expect(rows).toEqual([{ username: 'admin', must_change_password: true }]);
    expect(JSON.stringify((await db.query('SELECT password_hash FROM admin_users')).rows)).not.toContain('"admin"'); // only a hash is stored
  });

  let token: string;
  it('logs in with admin / admin (username, or the legacy "email" field) and is told to change the password', async () => {
    const r = await http().post('/admin/auth/login').send({ username: 'admin', password: 'admin' }).expect(200);
    expect(r.body.mustChangePassword).toBe(true);
    token = r.body.token;
    await http().post('/admin/auth/login').send({ email: 'ADMIN', password: 'admin' }).expect(200);
    await http().post('/admin/auth/login').send({ username: 'admin', password: 'wrong' }).expect(401);
    await http().post('/admin/auth/login').send({ password: 'admin' }).expect(400);
  });

  it('until the password is changed the server allows NOTHING else (not just the UI)', async () => {
    expect((await http().get('/admin/auth/me').set(A(token)).expect(200)).body).toEqual({ username: 'admin', role: 'SUPER_ADMIN', mustChangePassword: true });
    for (const [m, url] of [['get', '/admin/channels'], ['get', '/admin/settings'], ['get', '/admin/tracks'], ['post', '/admin/telegram/login/start'], ['get', '/admin/platform'], ['get', '/admin/audit']] as const) {
      const r = await http()[m](url).set(A(token)).expect(403);
      expect(r.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
  });

  it('rejects a wrong current password, weak/default/unchanged new passwords', async () => {
    const change = (body: object) => http().post('/admin/auth/change-password').set(A(token)).send(body);
    await change({ currentPassword: 'nope', newPassword: 'a-strong-password' }).expect(400); // not 401: a typo is not an expired session
    await change({ currentPassword: 'admin', newPassword: 'short' }).expect(400);
    await change({ currentPassword: 'admin', newPassword: 'admin' }).expect(400);
    await http().post('/admin/auth/change-password').send({ currentPassword: 'admin', newPassword: 'a-strong-password' }).expect(401); // needs a token
  });

  let fresh: string;
  it('changing the password unlocks the panel, returns a new token and kills the old one', async () => {
    const r = await http().post('/admin/auth/change-password').set(A(token)).send({ currentPassword: 'admin', newPassword: 'a-strong-password' }).expect(200);
    fresh = r.body.token;
    expect((await http().get('/admin/auth/me').set(A(fresh)).expect(200)).body.mustChangePassword).toBe(false);
    await http().get('/admin/platform').set(A(fresh)).expect(200);
    await new Promise((res) => setTimeout(res, 3200)); // the guard caches the user for 3 s
    await http().get('/admin/platform').set(A(token)).expect(401); // the pre-change token is dead
    await http().post('/admin/auth/login').send({ username: 'admin', password: 'admin' }).expect(401);
    await http().post('/admin/auth/login').send({ username: 'admin', password: 'a-strong-password' }).expect(200);
  }, 15_000);

  it('the reset command restores access after a forgotten password (random password, change forced again)', async () => {
    const db = app.get(DatabaseService);
    const r = await resetAdminPassword(new PgAdminUsersRepository(db), 'admin');
    expect(r.generated).toBe(true);
    const login = await http().post('/admin/auth/login').send({ username: 'admin', password: r.password }).expect(200);
    expect(login.body.mustChangePassword).toBe(true);
    await http().post('/admin/auth/login').send({ username: 'admin', password: 'a-strong-password' }).expect(401);
    await http().get('/admin/platform').set(A(login.body.token)).expect(403);
  });
});
