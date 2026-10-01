import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { AdminUser, AdminUserStore } from './ports/admin-users.repository';
import { AdminAuthService, passwordPolicy } from './admin-auth.service';
import { resetAdminPassword, seedAdmin } from './admin-seeder';
import { scrub } from '../infrastructure/audit.service';
import { hashPassword, verifyPassword } from '../../shared/kernel/password';

class MemoryUsers implements AdminUserStore {
  users: AdminUser[] = [];
  async findByUsername(u: string): Promise<AdminUser | null> {
    return this.users.find((x) => x.username.toLowerCase() === u.trim().toLowerCase()) ?? null;
  }
  async get(id: string): Promise<AdminUser | null> {
    return this.users.find((x) => x.id === id) ?? null;
  }
  async count(): Promise<number> {
    return this.users.length;
  }
  async create(username: string, passwordHash: string, mustChangePassword: boolean): Promise<AdminUser> {
    const u = { id: `00000000-0000-4000-8000-${String(this.users.length + 1).padStart(12, '0')}`, username, passwordHash, mustChangePassword };
    this.users.push(u);
    return u;
  }
  async setPassword(id: string, passwordHash: string, mustChangePassword: boolean): Promise<void> {
    const u = this.users.find((x) => x.id === id);
    if (u) Object.assign(u, { passwordHash, mustChangePassword });
  }
}
const quiet = { warn: () => undefined, log: () => undefined };

describe('password hashing', () => {
  it('verifies correct passwords only, salts each hash', async () => {
    const h = await hashPassword('s3cret!');
    expect(h).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/);
    expect(await verifyPassword('s3cret!', h.replace(/:/g, '$'))).toBe(true); // legacy `$` separators still verify
    expect(await verifyPassword('s3cret!', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await hashPassword('s3cret!')).not.toBe(h);
  });
});

describe('seedAdmin', () => {
  it('seeds admin / admin with a forced password change when nothing is configured', async () => {
    const users = new MemoryUsers();
    expect(await seedAdmin(users, {}, quiet)).toBe('created-default');
    expect(users.users[0]).toMatchObject({ username: 'admin', mustChangePassword: true });
    expect(await verifyPassword('admin', users.users[0]?.passwordHash ?? '')).toBe(true);
  });

  it('uses the env credentials (no forced change) when they are provided, and never touches an existing admin', async () => {
    const users = new MemoryUsers();
    const hash = await hashPassword('operator-chosen');
    expect(await seedAdmin(users, { username: 'boss@example.com', passwordHash: hash }, quiet)).toBe('created-from-env');
    expect(users.users[0]).toMatchObject({ username: 'boss@example.com', mustChangePassword: false, passwordHash: hash });
    expect(await seedAdmin(users, {}, quiet)).toBe('exists');
    expect(users.users).toHaveLength(1);
  });
});

describe('resetAdminPassword (the reset command)', () => {
  it('sets a given password without forcing a change, or generates one and forces a change', async () => {
    const users = new MemoryUsers();
    await seedAdmin(users, {}, quiet);
    const given = await resetAdminPassword(users, 'ADMIN', 'my-new-password');
    expect(given).toMatchObject({ username: 'admin', generated: false });
    expect(users.users[0]).toMatchObject({ mustChangePassword: false });
    expect(await verifyPassword('my-new-password', users.users[0]?.passwordHash ?? '')).toBe(true);

    const random = await resetAdminPassword(users, 'admin');
    expect(random.generated).toBe(true);
    expect(random.password.length).toBeGreaterThanOrEqual(12);
    expect(users.users[0]?.mustChangePassword).toBe(true);
    expect(await verifyPassword(random.password, users.users[0]?.passwordHash ?? '')).toBe(true);
  });

  it('creates the account when the username does not exist yet', async () => {
    const users = new MemoryUsers();
    await resetAdminPassword(users, 'second', 'another-password-1');
    expect(users.users[0]).toMatchObject({ username: 'second' });
  });
});

describe('passwordPolicy', () => {
  it('requires 8+ characters, not the default, and not the old password', () => {
    expect(passwordPolicy('short')).toMatch(/at least 8/);
    expect(passwordPolicy('ADMIN')).toMatch(/at least 8|other than the default/);
    expect(passwordPolicy('admin1234')).toBeNull();
    expect(passwordPolicy('same-password', 'same-password')).toMatch(/differ/);
    expect(passwordPolicy('x'.repeat(201))).toMatch(/too long/);
    expect(passwordPolicy('good-password-1', 'old')).toBeNull();
  });
});

describe('AdminAuthService', () => {
  const secret = 'y'.repeat(40);
  let users: MemoryUsers;
  let svc: AdminAuthService;
  let t = 1_000_000;
  beforeEach(async () => {
    users = new MemoryUsers();
    await users.create('Admin@Example.com', await hashPassword('pw-123-long'), false);
    svc = new AdminAuthService(users, { jwtSecret: secret, tokenTtlSeconds: 3600 }, () => t);
  });

  it('logs in (case-insensitive username) and issues a verifiable SUPER_ADMIN token', async () => {
    const r = await svc.login('admin@example.com', 'pw-123-long', 'ip1');
    expect(r.mustChangePassword).toBe(false);
    expect(svc.verifyToken(r.token)).toMatchObject({ email: 'Admin@Example.com', role: 'SUPER_ADMIN' });
    expect(await svc.resolve(svc.verifyToken(r.token))).toMatchObject({ email: 'Admin@Example.com' });
  });

  it('rejects wrong password / unknown user with the same error', async () => {
    await expect(svc.login('admin@example.com', 'nope', 'ip2')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.login('other', 'pw-123-long', 'ip2')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rate limits repeated failures per client, and recovers after the window', async () => {
    for (let i = 0; i < 5; i++) await svc.login('admin@example.com', 'bad', 'ip3').catch(() => undefined);
    await expect(svc.login('admin@example.com', 'pw-123-long', 'ip3')).rejects.toBeInstanceOf(HttpException);
    t += 61_000;
    await expect(svc.login('admin@example.com', 'pw-123-long', 'ip3')).resolves.toBeDefined();
  });

  it('changing the password invalidates every older token at once and issues a working new one', async () => {
    const old = await svc.login('admin@example.com', 'pw-123-long', 'ip4');
    const id = svc.verifyToken(old.token);
    await expect(svc.changePassword(id, 'wrong', 'brand-new-pass', 'ip4')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.changePassword(id, 'pw-123-long', 'short', 'ip4')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.changePassword(id, 'pw-123-long', 'pw-123-long', 'ip4')).rejects.toBeInstanceOf(BadRequestException);
    const fresh = await svc.changePassword(id, 'pw-123-long', 'brand-new-pass', 'ip4');
    t += 5000; // past the short user cache
    await expect(svc.resolve(svc.verifyToken(old.token))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.resolve(svc.verifyToken(fresh.token))).resolves.toMatchObject({ mustChangePassword: false });
    await expect(svc.login('admin@example.com', 'pw-123-long', 'ip5')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.login('admin@example.com', 'brand-new-pass', 'ip5')).resolves.toBeDefined();
  });

  it('a seeded default admin logs in flagged mustChangePassword, and changing the password clears the flag', async () => {
    const fresh = new MemoryUsers();
    await seedAdmin(fresh, {}, quiet);
    const s = new AdminAuthService(fresh, { jwtSecret: secret, tokenTtlSeconds: 3600 }, () => t);
    const r = await s.login('admin', 'admin', 'ip6');
    expect(r.mustChangePassword).toBe(true);
    await expect(s.changePassword(s.verifyToken(r.token), 'admin', 'admin', 'ip6')).rejects.toBeInstanceOf(BadRequestException);
    const changed = await s.changePassword(s.verifyToken(r.token), 'admin', 'a-real-password', 'ip6');
    t += 5000;
    expect((await s.resolve(s.verifyToken(changed.token))).mustChangePassword).toBe(false);
  });

  it('rejects forged, wrong-role, expired and alg=none tokens, and tokens of deleted users', async () => {
    expect(() => svc.verifyToken('garbage')).toThrow(UnauthorizedException);
    expect(() => svc.verifyToken(sign({ role: 'SUPER_ADMIN' }, 'other-secret'.repeat(4), { subject: 'a' }))).toThrow(UnauthorizedException);
    expect(() => svc.verifyToken(sign({ role: 'USER' }, secret, { subject: 'a' }))).toThrow(UnauthorizedException);
    expect(() => svc.verifyToken(sign({ role: 'SUPER_ADMIN' }, secret, { subject: 'a', expiresIn: -10 }))).toThrow(UnauthorizedException);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"role":"SUPER_ADMIN","sub":"a"}').toString('base64url')}.`;
    expect(() => svc.verifyToken(none)).toThrow(UnauthorizedException);
    // a token without the user claims (e.g. issued by an older version) is not accepted by resolve()
    await expect(svc.resolve(svc.verifyToken(sign({ role: 'SUPER_ADMIN' }, secret, { subject: 'a' })))).rejects.toBeInstanceOf(UnauthorizedException);
    const r = await svc.login('admin@example.com', 'pw-123-long', 'ip7');
    users.users.length = 0;
    t += 5000;
    await expect(svc.resolve(svc.verifyToken(r.token))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('audit scrub', () => {
  it('redacts secrets recursively', () => {
    expect(scrub({ a: 1, password: 'x', nested: { apiHash: 'h', ok: true }, list: [{ token: 't' }] })).toEqual({
      a: 1, password: '[REDACTED]', nested: { apiHash: '[REDACTED]', ok: true }, list: [{ token: '[REDACTED]' }],
    });
  });
});
