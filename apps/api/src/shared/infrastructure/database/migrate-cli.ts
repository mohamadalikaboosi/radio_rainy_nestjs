import { loadConfig } from '../config/app-config';
import { DatabaseService } from './database.service';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = new DatabaseService(cfg);
  try {
    const applied = await db.migrate();
    process.stdout.write(`applied: ${applied.join(', ') || 'none'}\n`);
  } finally {
    await db.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
