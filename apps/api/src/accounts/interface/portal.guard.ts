import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AccountsRepository } from '../infrastructure/accounts.repository';
import { PortalAuthService, PortalIdentity } from '../application/portal-auth.service';

export type PortalRequest = Request & { portal: PortalIdentity };

/** Every /portal/* route (except sign-up/login): a valid account token AND an account that is still active. */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private readonly auth: PortalAuthService, private readonly accounts: AccountsRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PortalRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    const identity = this.auth.verifyToken(header.slice(7));
    const account = await this.accounts.get(identity.accountId);
    if (!account) throw new UnauthorizedException('Unknown account');
    if (account.status !== 'ACTIVE') throw new ForbiddenException('This account is suspended');
    req.portal = identity;
    return true;
  }
}
