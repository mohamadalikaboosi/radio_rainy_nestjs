/** Pure helpers of the public player (kept out of the components so they are unit-tested). */

/** Stable hue 0-359 for a string: every track gets its own colour theme. */
export function hueOf(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

/** Seconds until `iso`, measured with the server's clock (`serverTime` of the last response) so a wrong device clock doesn't matter. */
export function secondsUntil(iso: string, serverTime: string, fetchedAt: number, now: number): number {
  const serverNow = Date.parse(serverTime) + (now - fetchedAt);
  return Math.max(0, Math.round((Date.parse(iso) - serverNow) / 1000));
}

/** Elapsed seconds since `startedIso` on the server's clock. */
export function secondsSince(startedIso: string, serverTime: string, fetchedAt: number, now: number): number {
  const serverNow = Date.parse(serverTime) + (now - fetchedAt);
  return Math.max(0, (serverNow - Date.parse(startedIso)) / 1000);
}

export interface SponsorView {
  id: string;
  name: string;
  tagline: string | null;
  ctaLabel: string;
  weight: number;
  logoUrl: string | null;
  url: string;
}

/** Weighted random pick (heavier sponsors show more often); `rng` returns [0, 1). */
export function pickSponsor(list: readonly SponsorView[], rng: () => number = Math.random, avoidId?: string): SponsorView | null {
  const pool = list.length > 1 && avoidId ? list.filter((s) => s.id !== avoidId) : list;
  const total = pool.reduce((a, s) => a + Math.max(1, s.weight), 0);
  if (total === 0) return null;
  let r = rng() * total;
  for (const s of pool) {
    r -= Math.max(1, s.weight);
    if (r < 0) return s;
  }
  return pool[pool.length - 1] ?? null;
}

/** Bar heights (0-1) for the equalizer from analyser bytes; falls back to a gentle synthetic wave when there is no signal. */
export function barLevels(bytes: Uint8Array | null, bars: number, phase: number): number[] {
  const out: number[] = [];
  const hasSignal = bytes !== null && bytes.some((b) => b > 0);
  for (let i = 0; i < bars; i++) {
    if (hasSignal && bytes) {
      // the lower ~70% of the spectrum is where music lives
      const idx = Math.min(bytes.length - 1, Math.floor((i / bars) * bytes.length * 0.7));
      out.push((bytes[idx] ?? 0) / 255);
    } else {
      out.push(0.18 + 0.14 * (Math.sin(phase + i * 0.55) + 1) * 0.5 + 0.1 * (Math.sin(phase * 1.7 + i * 1.3) + 1) * 0.5);
    }
  }
  return out;
}

export function voterId(): string {
  const KEY = 'rr_voter';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
    const fresh = (globalThis.crypto?.randomUUID?.() ?? `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`).replace(/[^A-Za-z0-9_-]/g, '');
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return `v${Math.random().toString(36).slice(2, 14).padEnd(12, 'x')}`;
  }
}

/** Index of the line being sung at `position` seconds (-1 before the first line / in a gap after the last). Computed in the browser: no polling. */
export function activeLineIndex(lines: readonly { start: number; end: number }[], position: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = lines[mid];
    if (!l) break;
    if (l.start <= position) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const line = lines[found];
  return line && position < line.end + 1.5 ? found : -1; // a short grace after the line ends, then the gap is empty
}

export type QualityPref = 'auto' | 'high' | 'low';
const QUALITY_KEY = 'rr_quality';

export function loadQuality(): QualityPref {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    return v === 'high' || v === 'low' ? v : 'auto';
  } catch {
    return 'auto';
  }
}
export function saveQuality(q: QualityPref): void {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

interface NetInfo {
  saveData?: boolean;
  effectiveType?: string;
}
/** Browser says the connection is slow or the user asked to save data (Network Information API, where available). */
export function slowConnection(nav: { connection?: NetInfo } = navigator as unknown as { connection?: NetInfo }): boolean {
  const c = nav.connection;
  return !!c && (c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g');
}

/** Counts stalls in a sliding window: true once `limit` happened within `windowMs`. */
export function stallTracker(limit = 3, windowMs = 20_000): (now?: number) => boolean {
  let at: number[] = [];
  return (now = Date.now()) => {
    at = [...at.filter((t) => now - t < windowMs), now];
    return at.length >= limit;
  };
}

export function withQuery(url: string, params: Record<string, string>): string {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + new URLSearchParams(params).toString();
}
