/**
 * Dev-only preloader (`node -r ./src/scripts/dev-env ...`): loads ../../.env and lets it OVERRIDE variables already set in
 * the shell / IDE / Windows environment. (`node --env-file` never overrides, so a stale `PORT=4444` set somewhere else
 * silently beat the value in .env.) Overridden keys are listed (names only, never values).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const file = resolve(process.cwd(), process.env.ENV_FILE ?? '../../.env');
if (existsSync(file)) {
  const values = parseEnv(readFileSync(file, 'utf8'));
  const overridden: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (process.env[k] !== undefined && process.env[k] !== v) overridden.push(k);
    process.env[k] = v;
  }
  if (overridden.length > 0) process.stderr.write(`[dev-env] .env overrides already-set environment variables: ${overridden.join(', ')}\n`);
  process.stderr.write(`[dev-env] loaded ${file}\n`);
} else {
  process.stderr.write(`[dev-env] ${file} not found (using the process environment only)\n`);
}
