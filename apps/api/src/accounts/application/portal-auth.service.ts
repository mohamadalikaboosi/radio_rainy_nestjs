import { ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from '../../shared/kernel/token-service';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../shared/kernel/password';
import { AccountsRepository } from './ports/accounts.repository';
import { EmailTakenError } from './ports/accounts.repository';
import { PlatformSettingsRepository } from './ports/platform-settings.repository';

export interface PortalIdentity {
  accountId: string;
  userId: string;
  email: string;
}

export const signupSchema = z.object({
  accountName: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(200),
  password: z.string().min(8, 'at least 8 characters').max(200),
});
export const loginSchema = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) });

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;
/** Compared against when the email is unknown, so the response time never reveals whether an account exists. */
const DUMMY_HASH = 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64);

/**
 * Customer accounts (advertisers / station owners). Tokens carry role ACCOUNT + audience "portal": they can never pass the
 * Super Admin guard (which requires role SUPER_ADMIN), and an admin token is not accepted here either.
 */
@Injectable()
export class PortalAuthService {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly accounts: AccountsRepository,
    private readonly platform: Pick<PlatformSettingsRepository, 'get'>,
    private readonly cfg: { tokens: TokenService; tokenTtlSeconds: number },
    private readonly now: () => number = () => Date.now(),
  ) {}

  async signup(input: z.infer<typeof signupSchema>, clientKey: string): Promise<{ token: string; identity: PortalIdentity }> {
    this.throttle(`signup:${clientKey}`);
    if (!(await this.platform.get()).selfSignupEnabled) throw new ForbiddenException('Sign-up is closed. Ask the operator for an account.');
    try {
      const { account, userId } = await this.accounts.create(input.accountName, input.email, await hashPassword(input.password));
      const identity = { accountId: account.id, userId, email: input.email.trim() };
      return { token: this.issue(identity), identity };
    } catch (err) {
      if (err instanceof EmailTakenError) throw new HttpException('This email is already registered', HttpStatus.CONFLICT);
      throw err;
    }
  }

  async login(email: string, password: string, clientKey: string): Promise<{ token: string; identity: PortalIdentity }> {
    this.throttle(`login:${clientKey}`);
    const user = await this.accounts.userByEmail(email);
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');
    const account = await this.accounts.get(user.accountId);
    if (!account || account.status !== 'ACTIVE') throw new ForbiddenException('This account is suspended');
    void this.accounts.touchLogin(user.id).catch(() => undefined);
    this.attempts.delete(`login:${clientKey}`);
    const identity = { accountId: user.accountId, userId: user.id, email: user.email };
    return { token: this.issue(identity), identity };
  }

  verifyToken(token: string): PortalIdentity {
    try {
      const p = this.cfg.tokens.verify(token, { audience: 'portal' });
      if (p.role !== 'ACCOUNT' || typeof p.aid !== 'string' || typeof p.uid !== 'string' || typeof p.sub !== 'string') throw new Error('bad claims');
      return { accountId: p.aid, userId: p.uid, email: p.sub };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private issue(i: PortalIdentity): string {
    return this.cfg.tokens.sign({ role: 'ACCOUNT', aid: i.accountId, uid: i.userId }, { subject: i.email, audience: 'portal', expiresInSeconds: this.cfg.tokenTtlSeconds });
  }

  /** Forgets all rate-limit counters (tests, or an operator unblocking a shared office IP). */
  resetThrottle(): void {
    this.attempts.clear();
  }

  private throttle(key: string): void {
    const t = this.now();
    const recent = (this.attempts.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) throw new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
    recent.push(t);
    this.attempts.set(key, recent);
  }
}
