import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

/**
 * Architecture rules (hexagonal / ports & adapters, bounded contexts as in DDD). They run with the unit tests, so a layering
 * violation fails CI the same way a bug does. See docs/ARCHITECTURE.md.
 *
 *   <context>/domain          pure business rules: no framework, no IO
 *   <context>/application     use cases + ports (abstract classes / interfaces): depends on domain only
 *   <context>/infrastructure  adapters (Postgres, Telegram, Redis, ffmpeg...): implement ports
 *   <context>/interface       driving adapters (HTTP controllers, WebSocket): call use cases / ports
 *   shared/kernel             tiny pure helpers shared by all contexts
 *   (src root)                composition root: app.module.ts, admin.module.ts, main.ts wire everything
 */
const SRC = __dirname;
const LAYERS = ['domain', 'application', 'infrastructure', 'interface'] as const;
type Layer = (typeof LAYERS)[number] | 'kernel';

/** Pure node built-ins (no IO) that are fine in the inner layers. */
const PURE_NODE = new Set(['node:crypto', 'node:path', 'node:events', 'node:stream', 'node:util', 'node:buffer']);
/** External packages the inner layers may use. */
const APP_PACKAGES = ['@nestjs/common', 'zod'];
const DOMAIN_PACKAGES = ['zod'];

interface Place {
  context: string;
  layer: Layer;
}

function placeOf(rel: string): Place | null {
  const parts = rel.split('/');
  if (parts.length < 3) return null; // src root = composition
  const [context, layer] = parts as [string, string];
  if (context === 'shared') return layer === 'kernel' ? { context, layer: 'kernel' } : { context, layer: layer as Layer };
  return (LAYERS as readonly string[]).includes(layer) ? { context, layer: layer as Layer } : null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(IMPORT)].map((m) => m[1] as string);
}

function violations(): string[] {
  const out: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/');
    const me = placeOf(rel);
    if (!me) continue;
    for (const spec of importsOf(file)) {
      const bad = (why: string): number => out.push(`${rel} imports '${spec}': ${why}`);
      if (!spec.startsWith('.')) {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] ?? spec;
        if (me.layer === 'domain' || me.layer === 'kernel') {
          if (spec.startsWith('node:') ? !PURE_NODE.has(spec) : !DOMAIN_PACKAGES.includes(pkg)) bad(`the ${me.layer} layer may not use this (no framework, no IO)`);
        } else if (me.layer === 'application' || (me.layer === 'interface' && false)) {
          if (spec.startsWith('node:') ? !PURE_NODE.has(spec) : !APP_PACKAGES.includes(pkg)) bad('the application layer may not use infrastructure libraries (put it behind a port)');
        }
        continue;
      }
      const target = relative(SRC, normalize(join(dirname(file), spec))).split('\\').join('/');
      const to = placeOf(target + '.ts');
      if (!to) continue; // composition root or same-folder helper
      const isConfig = target.startsWith('shared/infrastructure/config/');
      switch (me.layer) {
        case 'domain':
        case 'kernel':
          if (to.layer !== 'domain' && to.layer !== 'kernel') bad(`domain/kernel may only depend on domain/kernel (found ${to.context}/${to.layer})`);
          break;
        case 'application':
          if (to.layer === 'infrastructure' || to.layer === 'interface') bad(`application must not depend on ${to.layer} (use a port)`);
          break;
        case 'infrastructure':
          if (to.layer === 'interface') bad('infrastructure must not depend on interface');
          break;
        case 'interface':
          if (to.layer === 'infrastructure' && !isConfig) bad('interface must call application ports, not infrastructure adapters');
          break;
      }
    }
  }
  return out;
}

describe('architecture: layers and dependency direction', () => {
  it('dependencies point inwards (interface/infrastructure -> application -> domain)', () => {
    expect(violations()).toEqual([]);
  });

  it('every source file of a context lives in one of its four layers', () => {
    const stray: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      const parts = rel.split('/');
      if (parts.length === 1) continue; // composition root files
      const [context, layer] = parts as [string, string];
      if (context === 'scripts') continue; // CLI entry points (composition)
      if (context === 'shared' ? !['kernel', 'infrastructure', 'interface'].includes(layer) : !(LAYERS as readonly string[]).includes(layer)) stray.push(rel);
    }
    expect(stray).toEqual([]);
  });

  it('ports are abstract: application/ports never contain concrete infrastructure code', () => {
    const concrete: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (!/\/application\/ports\//.test(rel)) continue;
      const text = readFileSync(file, 'utf8');
      if (/\bnew (Pool|IORedis|TelegramClient)\b|\bspawn\(|\bawait fetch\(/.test(text)) concrete.push(rel);
    }
    expect(concrete).toEqual([]);
  });
});
