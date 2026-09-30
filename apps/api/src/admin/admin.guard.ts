import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthService, AdminIdentity, PasswordChangeRequired } from './admin-auth.service';

export type AdminRequest = Request & { admin: AdminIdentity };

/** With the default password still in place these are the only routes that work. */
const ALLOWED_BEFORE_CHANGE = /\/admin\/auth\/(me|change-password)\/?$/;

/** Enforced on the server for every /admin/* route (frontend route protection is only cosmetic). */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    const admin = await this.auth.resolve(this.auth.verifyToken(header.slice(7)));
    if (admin.mustChangePassword && !ALLOWED_BEFORE_CHANGE.test(req.path)) throw new PasswordChangeRequired();
    req.admin = admin;
    return true;
  }
}
