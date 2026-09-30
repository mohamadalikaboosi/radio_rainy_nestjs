import { barLevels, hueOf, pickSponsor, secondsSince, secondsUntil, voterId } from './helpers';
import type { SponsorView } from './helpers';

const sp = (id: string, weight = 1): SponsorView => ({ id, name: id, tagline: null, ctaLabel: 'Visit', weight, logoUrl: null, url: `/radio/go/sponsor/${id}` });

describe('player helpers', () => {
  it('hueOf is stable per seed and within 0-359', () => {
    expect(hueOf('track-1')).toBe(hueOf('track-1'));
    expect(hueOf('track-1')).not.toBe(hueOf('track-2'));
    for (const s of ['a', 'bb', 'ccc', 'Persian آهنگ']) expect(hueOf(s)).toBeGreaterThanOrEqual(0), expect(hueOf(s)).toBeLessThan(360);
  });

  it('countdowns use the SERVER clock, so a wrong device clock does not matter', () => {
    const serverTime = '2026-01-01T10:00:00.000Z';
    const fetchedAt = 1_000_000; // device clock reading when the response arrived
    // 2.5 s later on the device the server clock is 10:00:02.5
    expect(secondsUntil('2026-01-01T10:03:00.000Z', serverTime, fetchedAt, fetchedAt + 2500)).toBe(178); // 177.5 rounds to 178
    expect(secondsUntil('2026-01-01T09:00:00.000Z', serverTime, fetchedAt, fetchedAt)).toBe(0); // never negative
    expect(secondsSince('2026-01-01T09:59:40.000Z', serverTime, fetchedAt, fetchedAt + 1000)).toBeCloseTo(21, 5);
  });

  it('pickSponsor is weighted, never repeats the previous one when there is a choice, and handles empty/single lists', () => {
    expect(pickSponsor([])).toBeNull();
    expect(pickSponsor([sp('a')], () => 0.9, 'a')?.id).toBe('a');
    const list = [sp('a', 1), sp('b', 9)];
    expect(pickSponsor(list, () => 0.05)?.id).toBe('a');
    expect(pickSponsor(list, () => 0.5)?.id).toBe('b');
    expect(pickSponsor(list, () => 0.05, 'a')?.id).toBe('b');
  });

  it('barLevels maps analyser bytes to 0-1 heights and falls back to a gentle wave without a signal', () => {
    const bytes = new Uint8Array(64).fill(255);
    expect(barLevels(bytes, 8, 0).every((v) => v === 1)).toBe(true);
    const idle = barLevels(new Uint8Array(64), 8, 1);
    expect(idle).toHaveLength(8);
    expect(idle.every((v) => v > 0 && v < 0.5)).toBe(true);
    expect(barLevels(null, 4, 0)).toHaveLength(4);
  });

  it('voterId is stable across calls and valid for the API', () => {
    localStorage.clear();
    const id = voterId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(voterId()).toBe(id);
  });
});
