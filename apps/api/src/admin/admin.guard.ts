import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthService, AdminIdentity } from './admin-auth.service';

export type AdminRequest = Request & { admin: AdminIdentity };

/** Enforced on the server for every /admin/* route (frontend route protection is only cosmetic). */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    req.admin = this.auth.verifyToken(header.slice(7));
    return true;
  }
}
