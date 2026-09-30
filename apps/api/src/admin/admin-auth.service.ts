import { Injectable, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import { sign, verify } from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { verifyPassword } from './password';

export interface AdminIdentity {
  email: string;
  role: 'SUPER_ADMIN';
}

export interface AdminAuthConfig {
  adminEmail: string;
  passwordHash: string;
  jwtSecret: string;
  tokenTtlSeconds: number;
}

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class AdminAuthService {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly cfg: AdminAuthConfig, private readonly now: () => number = () => Date.now()) {}

  async login(email: string, password: string, clientKey: string): Promise<{ token: string; expiresIn: number; admin: AdminIdentity }> {
    this.throttle(clientKey);
    const emailOk = this.safeEqual(email.trim().toLowerCase(), this.cfg.adminEmail.trim().toLowerCase());
    // Always run the hash so response time does not reveal whether the email matched.
    const passOk = await verifyPassword(password, this.cfg.passwordHash);
    if (!emailOk || !passOk) throw new UnauthorizedException('Invalid credentials');
    this.attempts.delete(clientKey);
    const admin: AdminIdentity = { email: this.cfg.adminEmail, role: 'SUPER_ADMIN' };
    const token = sign({ role: admin.role }, this.cfg.jwtSecret, { algorithm: 'HS256', subject: admin.email, expiresIn: this.cfg.tokenTtlSeconds });
    return { token, expiresIn: this.cfg.tokenTtlSeconds, admin };
  }

  verifyToken(token: string): AdminIdentity {
    try {
      const payload = verify(token, this.cfg.jwtSecret, { algorithms: ['HS256'] });
      if (typeof payload === 'string' || payload.role !== 'SUPER_ADMIN' || typeof payload.sub !== 'string') throw new Error('bad claims');
      return { email: payload.sub, role: 'SUPER_ADMIN' };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private throttle(key: string): void {
    const t = this.now();
    const recent = (this.attempts.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) throw new HttpException('Too many login attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
    recent.push(t);
    this.attempts.set(key, recent);
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
