import { Logger } from '@nestjs/common';
import { AdminUserStore } from '../infrastructure/admin-users.repository';
import { DEFAULT_PASSWORD, DEFAULT_USERNAME } from './admin-auth.service';
import { hashPassword } from '../../shared/infrastructure/crypto/password';

/**
 * Creates the first Super Admin when there is none.
 *  - ADMIN_EMAIL + ADMIN_PASSWORD_HASH set: those credentials are used as they are (the operator chose them on purpose).
 *  - otherwise: admin / admin, flagged "must change password": the server allows nothing but the password change until it is done.
 * Existing admins are never touched.
 */
export async function seedAdmin(users: AdminUserStore, env: { username?: string; passwordHash?: string }, logger: Pick<Logger, 'warn' | 'log'> = new Logger('AdminSeeder')): Promise<'created-default' | 'created-from-env' | 'exists'> {
  if ((await users.count()) > 0) return 'exists';
  try {
    if (env.username && env.passwordHash) {
      await users.create(env.username, env.passwordHash, false);
      logger.log({ msg: 'first Super Admin created from ADMIN_EMAIL / ADMIN_PASSWORD_HASH', username: env.username });
      return 'created-from-env';
    }
    await users.create(DEFAULT_USERNAME, await hashPassword(DEFAULT_PASSWORD), true);
    logger.warn({ msg: `first Super Admin created: "${DEFAULT_USERNAME}" / "${DEFAULT_PASSWORD}". You are forced to change this password at the first login.` });
    return 'created-default';
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return 'exists'; // another instance seeded at the same moment
    throw err;
  }
}

/** Used by the `reset-admin-password` command: sets a new password (random when none is given, then a change is forced at the next login). */
export async function resetAdminPassword(users: AdminUserStore, username: string, password?: string): Promise<{ username: string; password: string; generated: boolean }> {
  const generated = password === undefined;
  const plain = password ?? Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(12))).toString('base64url');
  const hash = await hashPassword(plain);
  const existing = await users.findByUsername(username);
  if (existing) await users.setPassword(existing.id, hash, generated);
  else await users.create(username, hash, generated);
  return { username: existing?.username ?? username, password: plain, generated };
}
