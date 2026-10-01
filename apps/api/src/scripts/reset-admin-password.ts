import { PgAdminUsersRepository } from '../administration/infrastructure/admin-users.repository';
import { resetAdminPassword } from '../administration/application/admin-seeder';
import { DatabaseService } from '../shared/infrastructure/database/database.service';


/**
 * Forgot the Super Admin password?
 *   pnpm --filter @radio_rainy/api reset-admin-password [username] [newPassword]
 *   docker compose exec app node dist/scripts/reset-admin-password.js [username] [newPassword]
 * Without a password a random one is printed and you must change it at the next login. Needs DATABASE_URL.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const username = process.argv[2] ?? 'admin';
  const password = process.argv[3];
  if (password !== undefined && password.length < 8) throw new Error('The password must have at least 8 characters');
  const db = new DatabaseService({ DATABASE_URL: url });
  try {
    await db.migrate();
    const r = await resetAdminPassword(new PgAdminUsersRepository(db), username, password);
    process.stdout.write(`Super Admin "${r.username}" password ${r.generated ? `reset to: ${r.password}\n(you will be asked to change it at the next login)` : 'updated.'}\n`);
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
