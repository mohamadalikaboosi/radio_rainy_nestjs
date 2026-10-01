import { RadioRuleEngine } from './radio-rule-engine';
import { RadioConfigSnapshot, TrackCandidate } from './radio.types';
import { seededRng, weightedPick } from './rng';

const engine = new RadioRuleEngine();
const t = (id: string, ...tags: string[]): TrackCandidate => ({ id, hashtags: tags });

// Scenario from the spec (§24.20)
const songs = [
  t('A', 'rain', 'night'),
  t('B', 'rock'),
  t('C', 'rain', 'chill'),
  t('D', 'night', 'chill'),
  t('E', 'rain', 'night', 'chill'),
];

const cfg = (over: Partial<RadioConfigSnapshot>): RadioConfigSnapshot => ({
  mode: 'GLOBAL_RANDOM',
  hashtagMatchMode: 'ANY',
  recentTrackWindow: 3,
  hashtags: [],
  rules: [],
  fallbackToGlobal: true,
  ...over,
});
const tags = (...v: string[]) => v.map((hashtag) => ({ hashtag, weight: 1 }));
const run = (config: RadioConfigSnapshot, n = 300, candidates = songs) => {
  const p = engine.preview({ config, candidates, recentTrackIds: [], rotationCursor: 0 }, n, 42);
  return p;
};

describe('RadioRuleEngine', () => {
  it('HASHTAG_RANDOM ANY selects only A,C,D,E for #rain/#night', () => {
    const p = run(cfg({ mode: 'HASHTAG_RANDOM', hashtags: tags('rain', 'night') }));
    expect(p.eligibleCount).toBe(4);
    expect(new Set(p.trackIds)).toEqual(new Set(['A', 'C', 'D', 'E']));
  });

  it('HASHTAG_RANDOM ALL selects only A,E', () => {
    const p = run(cfg({ mode: 'HASHTAG_RANDOM', hashtagMatchMode: 'ALL', hashtags: tags('rain', 'night') }));
    expect(p.eligibleCount).toBe(2);
    expect(new Set(p.trackIds)).toEqual(new Set(['A', 'E']));
  });

  it('never immediately repeats and honours recent window', () => {
    const p = run(cfg({ recentTrackWindow: 3 }), 200);
    for (let i = 0; i < p.trackIds.length; i++) {
      for (let k = 1; k <= 3 && i - k >= 0; k++) expect(p.trackIds[i]).not.toBe(p.trackIds[i - k]);
    }
  });

  it('shrinks window gracefully when library is smaller than window', () => {
    const p = run(cfg({ recentTrackWindow: 10 }), 50, [t('X'), t('Y')]);
    for (let i = 1; i < p.trackIds.length; i++) expect(p.trackIds[i]).not.toBe(p.trackIds[i - 1]);
    const one = run(cfg({ recentTrackWindow: 10 }), 5, [t('X')]);
    expect(one.trackIds).toEqual(['X', 'X', 'X', 'X', 'X']);
  });

  it('empty library yields null instead of throwing', () => {
    const r = engine.select({ config: cfg({}), candidates: [], recentTrackIds: [], rotationCursor: 0 }, seededRng(1));
    expect(r.trackId).toBeNull();
  });

  it('is deterministic for a given seed and differs across seeds', () => {
    const input = { config: cfg({}), candidates: songs, recentTrackIds: [], rotationCursor: 0 };
    const a = engine.preview(input, 20, 7).trackIds;
    expect(engine.preview(input, 20, 7).trackIds).toEqual(a);
    expect(engine.preview(input, 20, 8).trackIds).not.toEqual(a);
  });

  it('hashtag weights change probability without duplicating tracks', () => {
    const pool = [t('R', 'rain'), t('K', 'rock')];
    const config = cfg({
      mode: 'HASHTAG_RANDOM',
      recentTrackWindow: 0,
      hashtags: [
        { hashtag: 'rain', weight: 90 },
        { hashtag: 'rock', weight: 10 },
      ],
    });
    const p = run(config, 2000, pool);
    const rain = p.trackIds.filter((x) => x === 'R').length / p.trackIds.length;
    expect(rain).toBeGreaterThan(0.85);
    expect(rain).toBeLessThan(0.95);
  });

  it('falls back to global when nothing matches, or returns null when fallback disabled', () => {
    const c = cfg({ mode: 'HASHTAG_RANDOM', hashtags: tags('jazz') });
    expect(run(c, 3).trackIds.length).toBe(3);
    expect(run({ ...c, fallbackToGlobal: false }, 3).trackIds).toEqual([]);
  });

  it('HASHTAG_ROTATION cycles through groups and skips empty ones', () => {
    const c = cfg({ mode: 'HASHTAG_ROTATION', recentTrackWindow: 0, hashtags: tags('rock', 'jazz', 'chill') });
    const p = run(c, 6);
    const groups = p.steps.map((s) => s.matchedHashtag);
    expect(groups).toEqual(['rock', 'chill', 'rock', 'chill', 'rock', 'chill']);
  });

  it('CUSTOM_RULE priority is strict and deterministic; exclusions apply', () => {
    const rules = [
      { id: 'r2', name: 'rain', priority: 2, matchMode: 'ANY' as const, weight: 1, enabled: true, include: ['rain'], exclude: [] },
      { id: 'r1', name: 'rain+night', priority: 1, matchMode: 'ALL' as const, weight: 1, enabled: true, include: ['rain', 'night'], exclude: ['chill'] },
    ];
    const p = run(cfg({ mode: 'CUSTOM_RULE', rules, recentTrackWindow: 0 }), 50);
    // priority 1 => rain AND night AND NOT chill => only A
    expect(new Set(p.trackIds)).toEqual(new Set(['A']));
    expect(p.steps[0]?.matchedRuleId).toBe('r1');
    // disable r1 => next priority takes over
    const p2 = run(cfg({ mode: 'CUSTOM_RULE', rules: rules.map((r) => ({ ...r, enabled: r.id !== 'r1' })), recentTrackWindow: 0 }), 100);
    expect(new Set(p2.trackIds)).toEqual(new Set(['A', 'C', 'E']));
  });

  it('weightedPick ignores zero weights and returns undefined when none positive', () => {
    expect(weightedPick(['a', 'b'], () => 0, seededRng(1))).toBeUndefined();
    expect(weightedPick(['a', 'b'], (x) => (x === 'a' ? 0 : 1), seededRng(1))).toBe('b');
  });
});
