import { randomFillSync } from 'node:crypto';

/** Returns a float in [0, 1). */
export type Rng = () => number;

/** Deterministic PRNG for previews and tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buf = new Uint32Array(1);
export const cryptoRng: Rng = () => {
  randomFillSync(buf);
  return (buf[0] ?? 0) / 4294967296;
};

/** Weighted pick without duplicating items; items with weight <= 0 are never picked. */
export function weightedPick<T>(items: readonly T[], weightOf: (item: T) => number, rng: Rng): T | undefined {
  let total = 0;
  for (const it of items) total += Math.max(0, weightOf(it));
  if (total <= 0) return undefined;
  let r = rng() * total;
  let last: T | undefined;
  for (const it of items) {
    const w = Math.max(0, weightOf(it));
    if (w === 0) continue;
    last = it;
    r -= w;
    if (r < 0) return it;
  }
  return last;
}
