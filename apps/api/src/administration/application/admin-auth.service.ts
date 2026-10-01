import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sign, verify } from 'jsonwebtoken';
import { AdminUser, AdminUserStore } from '../infrastructure/admin-users.repository';
import { hashPassword, verifyPassword } from '../../shared/kernel/password';

export interface AdminIdentity {
  /** The username (kept under this name because the audit log and controllers already use `admin.email` as the actor). */
  email: string;
  role: 'SUPER_ADMIN';
  userId?: string;
  /** True until the seeded default password has been replaced. While true only /admin/auth/me and change-password work. */
  mustChangePassword?: boolean;
}

export interface AdminAuthConfig {
  jwtSecret: string;
  tokenTtlSeconds: number;
}

export const DEFAULT_USERNAME = 'admin';
export const DEFAULT_PASSWORD = 'admin';
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const CACHE_MS = 3000;
/** Verified against when the user is unknown so response time never reveals whether a username exists. */
const DUMMY_HASH = `scrypt:${'00'.repeat(16)}:${'00'.repeat(64)}`;

/** Token claim that changes whenever the password changes: tokens issued before a password change stop working at once. */
const pvOf = (hash: string): string => createHash('sha256').update(hash).digest('hex').slice(0, 12);

export function passwordPolicy(next: string, current?: string): string | null {
  if (next.length < 8) return 'The new password must have at least 8 characters';
  if (next.length > 200) return 'The new password is too long';
  if (next.toLowerCase() === DEFAULT_PASSWORD) return 'Choose a password other than the default one';
  if (current !== undefined && next === current) return 'The new password must differ from the current one';
  return null;
}

@Injectable()
export class AdminAuthService {
  private readonly attempts = new Map<string, number[]>();
  private readonly cache = new Map<string, { at: number; user: AdminUser | null }>();

  constructor(private readonly users: AdminUserStore, private readonly cfg: AdminAuthConfig, private readonly now: () => number = () => Date.now()) {}

  async login(username: string, password: string, clientKey: string): Promise<{ token: string; expiresIn: number; admin: AdminIdentity; mustChangePassword: boolean }> {
    this.throttle(clientKey);
    const user = await this.users.findByUsername(username);
    // Always run the hash so response time does not reveal whether the username exists.
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');
    this.attempts.delete(clientKey);
    this.cache.set(user.id, { at: this.now(), user }); // a fresh login always sees the current database state (e.g. after a password reset)
    return { ...this.issue(user), admin: this.identity(user), mustChangePassword: user.mustChangePassword };
  }

  /** Signature + claims only (no database). The guard then calls `resolve` to make sure the token is still current. */
  verifyToken(token: string): AdminIdentity & { pv?: string } {
    try {
      const payload = verify(token, this.cfg.jwtSecret, { algorithms: ['HS256'] });
      if (typeof payload === 'string' || payload.role !== 'SUPER_ADMIN' || typeof payload.sub !== 'string') throw new Error('bad claims');
      return { email: payload.sub, role: 'SUPER_ADMIN', userId: typeof payload.uid === 'string' ? payload.uid : undefined, pv: typeof payload.pv === 'string' ? payload.pv : undefined };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /** The database truth for a verified token: the user must still exist and the password must not have changed since the token was issued. */
  async resolve(id: AdminIdentity & { pv?: string }): Promise<AdminIdentity> {
    if (!id.userId) throw new UnauthorizedException('Please sign in again');
    const user = await this.cached(id.userId);
    if (!user || !id.pv || id.pv !== pvOf(user.passwordHash)) throw new UnauthorizedException('Please sign in again');
    return this.identity(user);
  }

  async changePassword(identity: AdminIdentity, currentPassword: string, newPassword: string, clientKey: string): Promise<{ token: string; expiresIn: number }> {
    this.throttle(`pw:${clientKey}`);
    const user = identity.userId ? await this.users.get(identity.userId) : null;
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) throw new BadRequestException('The current password is wrong'); // 400, not 401: a typo must not look like an expired session
    const problem = passwordPolicy(newPassword, currentPassword);
    if (problem) throw new BadRequestException(problem);
    const hash = await hashPassword(newPassword);
    await this.users.setPassword(user.id, hash, false);
    this.cache.delete(user.id);
    const fresh = { ...user, passwordHash: hash, mustChangePassword: false };
    return this.issue(fresh);
  }

  private async cached(id: string): Promise<AdminUser | null> {
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.user;
    const user = await this.users.get(id);
    this.cache.set(id, { at: this.now(), user });
    return user;
  }

  private identity(u: AdminUser): AdminIdentity {
    return { email: u.username, role: 'SUPER_ADMIN', userId: u.id, mustChangePassword: u.mustChangePassword };
  }

  private issue(u: AdminUser): { token: string; expiresIn: number } {
    const token = sign({ role: 'SUPER_ADMIN', uid: u.id, pv: pvOf(u.passwordHash) }, this.cfg.jwtSecret, { algorithm: 'HS256', subject: u.username, expiresIn: this.cfg.tokenTtlSeconds });
    return { token, expiresIn: this.cfg.tokenTtlSeconds };
  }

  private throttle(key: string): void {
    const t = this.now();
    const recent = (this.attempts.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) throw new HttpException('Too many login attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
    recent.push(t);
    this.attempts.set(key, recent);
  }

  /** timing-safe string compare (kept for callers that compare secrets). */
  static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}

export class PasswordChangeRequired extends ForbiddenException {
  constructor() {
    super({ message: 'You must change the default password first', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
}
