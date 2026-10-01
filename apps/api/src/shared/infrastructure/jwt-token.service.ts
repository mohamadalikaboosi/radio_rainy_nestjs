import { sign, verify } from 'jsonwebtoken';
import { TokenOptions, TokenService } from '../kernel/token-service';

/** HS256 JSON Web Tokens signed with the server secret. */
export class JwtTokenService implements TokenService {
  constructor(private readonly secret: string) {}

  sign(claims: Record<string, unknown>, o: TokenOptions): string {
    return sign(claims, this.secret, { algorithm: 'HS256', subject: o.subject, expiresIn: o.expiresInSeconds, ...(o.audience ? { audience: o.audience } : {}) });
  }

  verify(token: string, o: { audience?: string } = {}): Record<string, unknown> & { sub?: string } {
    const payload = verify(token, this.secret, { algorithms: ['HS256'], ...(o.audience ? { audience: o.audience } : {}) });
    if (typeof payload === 'string') throw new Error('bad claims');
    return payload;
  }
}
