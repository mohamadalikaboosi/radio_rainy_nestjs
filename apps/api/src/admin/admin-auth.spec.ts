import { HttpException, UnauthorizedException } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { AdminAuthService } from './admin-auth.service';
import { scrub } from './audit.service';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies correct passwords only, salts each hash', async () => {
    const h = await hashPassword('s3cret!');
    expect(h).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(await verifyPassword('s3cret!', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await hashPassword('s3cret!')).not.toBe(h);
  });
});

describe('AdminAuthService', () => {
  const secret = 'y'.repeat(40);
  let svc: AdminAuthService;
  let t = 1_000_000;
  beforeAll(async () => {
    svc = new AdminAuthService({ adminEmail: 'Admin@Example.com', passwordHash: await hashPassword('pw-123'), jwtSecret: secret, tokenTtlSeconds: 3600 }, () => t);
  });

  it('logs in (case-insensitive email) and issues a verifiable SUPER_ADMIN token', async () => {
    const r = await svc.login('admin@example.com', 'pw-123', 'ip1');
    expect(svc.verifyToken(r.token)).toEqual({ email: 'Admin@Example.com', role: 'SUPER_ADMIN' });
  });
  it('rejects wrong password / wrong email with the same error', async () => {
    await expect(svc.login('admin@example.com', 'nope', 'ip2')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.login('other@example.com', 'pw-123', 'ip2')).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rate limits repeated failures per client, and recovers after the window', async () => {
    for (let i = 0; i < 5; i++) await svc.login('admin@example.com', 'bad', 'ip3').catch(() => undefined);
    await expect(svc.login('admin@example.com', 'pw-123', 'ip3')).rejects.toBeInstanceOf(HttpException);
    t += 61_000;
    await expect(svc.login('admin@example.com', 'pw-123', 'ip3')).resolves.toBeDefined();
  });
  it('rejects forged, wrong-role, expired and alg=none tokens', () => {
    expect(() => svc.verifyToken('garbage')).toThrow(UnauthorizedException);
    expect(() => svc.verifyToken(sign({ role: 'SUPER_ADMIN' }, 'other-secret'.repeat(4), { subject: 'a' }))).toThrow(UnauthorizedException);
    expect(() => svc.verifyToken(sign({ role: 'USER' }, secret, { subject: 'a' }))).toThrow(UnauthorizedException);
    expect(() => svc.verifyToken(sign({ role: 'SUPER_ADMIN' }, secret, { subject: 'a', expiresIn: -10 }))).toThrow(UnauthorizedException);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"role":"SUPER_ADMIN","sub":"a"}').toString('base64url')}.`;
    expect(() => svc.verifyToken(none)).toThrow(UnauthorizedException);
  });
});

describe('audit scrub', () => {
  it('redacts secrets recursively', () => {
    expect(scrub({ a: 1, password: 'x', nested: { apiHash: 'h', ok: true }, list: [{ token: 't' }] })).toEqual({
      a: 1, password: '[REDACTED]', nested: { apiHash: '[REDACTED]', ok: true }, list: [{ token: '[REDACTED]' }],
    });
  });
});
