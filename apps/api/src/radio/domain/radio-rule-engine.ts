import {
  HashtagMatchMode,
  PreviewResult,
  RadioRuleSnapshot,
  SelectionInput,
  SelectionResult,
  TrackCandidate,
} from './radio.types';
import { Rng, seededRng, weightedPick } from './rng';

interface Weighted {
  track: TrackCandidate;
  weight: number;
}

function matches(track: TrackCandidate, hashtags: readonly string[], mode: HashtagMatchMode): boolean {
  if (hashtags.length === 0) return false;
  const set = new Set(track.hashtags);
  return mode === 'ALL' ? hashtags.every((h) => set.has(h)) : hashtags.some((h) => set.has(h));
}

/**
 * Applies the recent-track window. Shrinks the window when it would empty the pool,
 * so small libraries degrade gracefully; a one-track pool may repeat (nothing else to play).
 */
export function excludeRecent<T extends { track: TrackCandidate }>(
  pool: readonly T[],
  recentTrackIds: readonly string[],
  window: number,
): { pool: T[]; exclusion: number } {
  for (let w = Math.max(0, Math.floor(window)); w > 0; w--) {
    const excluded = new Set(recentTrackIds.slice(0, w));
    const filtered = pool.filter((p) => !excluded.has(p.track.id));
    if (filtered.length > 0) return { pool: filtered, exclusion: w };
  }
  return { pool: [...pool], exclusion: 0 };
}

/**
 * Pure, deterministic-given-rng track selection. Used by the live radio, the admin preview and tests.
 * Two separate steps: (1) eligibility (which tracks may play), (2) probability (weights).
 */
export class RadioRuleEngine {
  select(input: SelectionInput, rng: Rng): SelectionResult {
    const { config } = input;
    switch (config.mode) {
      case 'GLOBAL_RANDOM':
        return this.global(input, rng, 'GLOBAL_RANDOM');
      case 'HASHTAG_RANDOM':
        return this.hashtagRandom(input, rng);
      case 'HASHTAG_ROTATION':
        return this.rotation(input, rng);
      case 'CUSTOM_RULE':
        return this.customRules(input, rng);
    }
  }

  /** Runs the real selection repeatedly with simulated history. Deterministic for a given seed. */
  preview(input: SelectionInput, limit: number, seed: number): PreviewResult {
    const rng = seededRng(seed);
    const history = [...input.recentTrackIds];
    let cursor = input.rotationCursor;
    const steps: SelectionResult[] = [];
    const trackIds: string[] = [];
    let eligibleCount = 0;
    for (let i = 0; i < limit; i++) {
      const r = this.select({ ...input, recentTrackIds: history, rotationCursor: cursor }, rng);
      if (i === 0) eligibleCount = r.eligibleCount;
      steps.push(r);
      cursor = r.nextCursor;
      if (r.trackId === null) break;
      trackIds.push(r.trackId);
      history.unshift(r.trackId);
    }
    return { eligibleCount, trackIds, steps };
  }

  private pickFrom(
    pool: Weighted[],
    input: SelectionInput,
    rng: Rng,
    base: Omit<SelectionResult, 'trackId' | 'reason'>,
    reason: string,
  ): SelectionResult {
    const { pool: after } = excludeRecent(pool, input.recentTrackIds, input.config.recentTrackWindow);
    const picked = weightedPick(after, (p) => p.weight, rng);
    if (!picked) return { ...base, trackId: null, reason: 'NO_ELIGIBLE_TRACKS' };
    return { ...base, trackId: picked.track.id, reason };
  }

  private global(input: SelectionInput, rng: Rng, reason: string, extra: Partial<SelectionResult> = {}): SelectionResult {
    const pool = input.candidates.map((track) => ({ track, weight: 1 }));
    return this.pickFrom(pool, input, rng, { eligibleCount: pool.length, nextCursor: input.rotationCursor, ...extra }, reason);
  }

  private fallback(input: SelectionInput, rng: Rng, why: string): SelectionResult {
    if (!input.config.fallbackToGlobal) {
      return { trackId: null, reason: why, eligibleCount: 0, nextCursor: input.rotationCursor };
    }
    return this.global(input, rng, `${why}_FALLBACK_GLOBAL`);
  }

  private hashtagRandom(input: SelectionInput, rng: Rng): SelectionResult {
    const { hashtags, hashtagMatchMode } = input.config;
    const tags = hashtags.map((h) => h.hashtag);
    if (tags.length === 0) return this.fallback(input, rng, 'NO_HASHTAGS_CONFIGURED');
    const weightByTag = new Map(hashtags.map((h) => [h.hashtag, h.weight]));
    const pool: Weighted[] = [];
    for (const track of input.candidates) {
      if (!matches(track, tags, hashtagMatchMode)) continue;
      // A track's weight is the max weight among the selected hashtags it carries.
      const w = Math.max(0, ...track.hashtags.map((h) => weightByTag.get(h) ?? 0));
      pool.push({ track, weight: w });
    }
    if (pool.length === 0) return this.fallback(input, rng, 'NO_TRACKS_MATCH_HASHTAGS');
    return this.pickFrom(pool, input, rng, { eligibleCount: pool.length, nextCursor: input.rotationCursor }, 'HASHTAG_RANDOM');
  }

  private rotation(input: SelectionInput, rng: Rng): SelectionResult {
    const groups = input.config.hashtags;
    if (groups.length === 0) return this.fallback(input, rng, 'NO_HASHTAGS_CONFIGURED');
    const start = ((input.rotationCursor % groups.length) + groups.length) % groups.length;
    for (let k = 0; k < groups.length; k++) {
      const gi = (start + k) % groups.length;
      const group = groups[gi];
      if (!group) continue;
      const pool = input.candidates.filter((t) => t.hashtags.includes(group.hashtag)).map((track) => ({ track, weight: 1 }));
      if (pool.length === 0) continue;
      const res = this.pickFrom(
        pool,
        input,
        rng,
        { eligibleCount: pool.length, nextCursor: (gi + 1) % groups.length, matchedHashtag: group.hashtag },
        'HASHTAG_ROTATION',
      );
      if (res.trackId) return res;
    }
    return this.fallback(input, rng, 'NO_TRACKS_IN_ANY_GROUP');
  }

  private customRules(input: SelectionInput, rng: Rng): SelectionResult {
    const rules = input.config.rules
      .filter((r) => r.enabled)
      .slice()
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    // Priority is strict: the first tier (rules sharing a priority) that yields tracks wins.
    const tiers = new Map<number, RadioRuleSnapshot[]>();
    for (const r of rules) tiers.set(r.priority, [...(tiers.get(r.priority) ?? []), r]);

    for (const tier of tiers.values()) {
      const byTrack = new Map<string, Weighted & { ruleId: string }>();
      for (const track of input.candidates) {
        for (const rule of tier) {
          if (!ruleMatches(track, rule)) continue;
          const cur = byTrack.get(track.id);
          if (!cur || rule.weight > cur.weight) byTrack.set(track.id, { track, weight: rule.weight, ruleId: rule.id });
        }
      }
      const pool = [...byTrack.values()];
      if (pool.length === 0) continue;
      const res = this.pickFrom(pool, input, rng, { eligibleCount: pool.length, nextCursor: input.rotationCursor }, 'CUSTOM_RULE');
      if (res.trackId) {
        return { ...res, matchedRuleId: byTrack.get(res.trackId)?.ruleId };
      }
    }
    return this.fallback(input, rng, 'NO_RULE_MATCHED');
  }
}

function ruleMatches(track: TrackCandidate, rule: RadioRuleSnapshot): boolean {
  const set = new Set(track.hashtags);
  if (rule.exclude.some((h) => set.has(h))) return false;
  return matches(track, rule.include, rule.matchMode);
}
