export interface TokenOptions {
  subject: string;
  audience?: string;
  expiresInSeconds: number;
}

/** Signs and verifies the session tokens of the panel and the portal (port; the JWT adapter lives in shared/infrastructure). */
export abstract class TokenService {
  abstract sign(claims: Record<string, unknown>, options: TokenOptions): string;
  /** Returns the claims (including `sub`), or throws when the token is invalid, expired or for another audience. */
  abstract verify(token: string, options?: { audience?: string }): Record<string, unknown> & { sub?: string };
}
