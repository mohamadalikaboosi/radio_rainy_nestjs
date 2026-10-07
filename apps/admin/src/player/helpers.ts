/** Pure helpers of the public player (kept out of the components so they are unit-tested). */

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

/** Part of the analyser's range (0 - half the sample rate) the bars cover: ~0-11 kHz, where music (and the data-saver stream) has energy. */
const VIZ_RANGE = 0.45;

/**
 * Bar levels (0-1) of the visualizer. Playing: the real spectrum from the analyser, in log-spaced bands so bass and mids get most bars (the
 * loudest bin of each band), or, when the browser gives no signal (no Web Audio, MSE path), a lively synthetic envelope.
 * Paused: a low idle wave at 4-7%. `t` is a clock in ms.
 */
export function vizLevels(bytes: Uint8Array | null, bars: number, playing: boolean, t: number, rng: () => number = Math.random): number[] {
  const out: number[] = [];
  const hasSignal = playing && bytes !== null && bytes.some((b) => b > 0);
  const edge = (i: number): number => Math.floor((bytes?.length ?? 0) * VIZ_RANGE * (i / bars) ** 1.6);
  for (let i = 0; i < bars; i++) {
    if (!playing) out.push(0.055 + 0.015 * Math.sin(i / 3 + t / 900));
    else if (hasSignal && bytes) {
      let peak = 0;
      for (let b = edge(i), end = Math.max(edge(i) + 1, edge(i + 1)); b < end && b < bytes.length; b++) peak = Math.max(peak, bytes[b] ?? 0);
      out.push(peak / 255);
    } else out.push(Math.min(1, (0.35 + 0.65 * Math.exp(-(((i - bars * 0.22) / (bars * 0.34)) ** 2))) * (0.25 + rng() * 0.75)));
  }
  return out;
}

/** One row of the lyrics card: a sung line, or an instrumental stretch ("• • •") wherever nothing is sung for a while. */
export interface LyricRow {
  start: number;
  end: number;
  text: string;
  gap: boolean;
}

/** Synchronized lines -> rows, with instrumental rows for the intro, long solos and (when the duration is known) the outro. */
export function lyricRows(lines: readonly { start: number; end: number; text: string }[], duration?: number | null, minGap = 6): LyricRow[] {
  const rows: LyricRow[] = [];
  let sungUntil = 0;
  for (const l of lines) {
    if (l.start - sungUntil >= minGap) rows.push({ start: sungUntil, end: l.start, text: '', gap: true });
    rows.push({ start: l.start, end: l.end, text: l.text, gap: false });
    sungUntil = Math.max(sungUntil, l.end);
  }
  if (rows.length > 0 && duration && duration - sungUntil >= minGap) rows.push({ start: sungUntil, end: duration, text: '', gap: true });
  return rows;
}

/** The row on air at `position` seconds: the last one that started (-1 before the first). Computed in the browser from the server clock. */
export function activeRowIndex(rows: readonly { start: number }[], position: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid]?.start ?? Infinity) <= position) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Karaoke fill of the active row, 0-1: the accent sweeps across the line while it is sung (done a moment before it ends). */
export function karaokeFill(row: { start: number; end: number }, position: number): number {
  return Math.min(1, Math.max(0, (position - row.start) / Math.max(0.5, row.end - row.start - 0.3)));
}

/** Share of the votes per option, in whole percent (0 when nobody voted yet). */
export function voteShares(votes: readonly number[]): number[] {
  const total = votes.reduce((a, v) => a + v, 0);
  return votes.map((v) => (total > 0 ? Math.round((v / total) * 100) : 0));
}

/** A small remembered setting (lyrics on/off, volume); storage may be unavailable (private mode). */
export function loadSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered, still works for this visit */
  }
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
