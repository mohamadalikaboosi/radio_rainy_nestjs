import { activeRowIndex, karaokeFill, lyricRows, pickSponsor, secondsSince, secondsUntil, voteShares, voterId, vizLevels } from './helpers';
import type { SponsorView } from './helpers';

const sp = (id: string, weight = 1): SponsorView => ({ id, name: id, tagline: null, ctaLabel: 'Visit', weight, logoUrl: null, url: `/radio/go/sponsor/${id}` });

describe('player helpers', () => {
  it('lyricRows adds an instrumental row for the intro, long gaps and the outro, and keeps short pauses as they are', () => {
    const rows = lyricRows(
      [
        { start: 16, end: 21, text: 'a' },
        { start: 22, end: 27, text: 'b' }, // 1 s pause: no gap row
        { start: 46, end: 51, text: 'c' }, // 19 s solo: gap row
      ],
      80,
    );
    expect(rows.map((r) => (r.gap ? '•' : r.text))).toEqual(['•', 'a', 'b', '•', 'c', '•']);
    expect(rows[0]).toMatchObject({ start: 0, end: 16 });
    expect(rows[3]).toMatchObject({ start: 27, end: 46 });
    expect(rows[5]).toMatchObject({ start: 51, end: 80 });
    expect(lyricRows([])).toEqual([]);
  });

  it('activeRowIndex is the last row that started, from the server timeline', () => {
    const rows = lyricRows([{ start: 0, end: 5, text: 'first' }, { start: 28, end: 34, text: 'second' }]);
    expect(rows.map((r) => r.text || '•')).toEqual(['first', '•', 'second']);
    expect(activeRowIndex(rows, -1)).toBe(-1);
    expect(activeRowIndex(rows, 3)).toBe(0);
    expect(activeRowIndex(rows, 10)).toBe(1); // between lines: the instrumental row
    expect(activeRowIndex(rows, 30)).toBe(2);
    expect(activeRowIndex(rows, 999)).toBe(2);
  });

  it('karaokeFill sweeps 0 -> 1 across the line and is full a moment before it ends', () => {
    const row = { start: 10, end: 14 };
    expect(karaokeFill(row, 9)).toBe(0);
    expect(karaokeFill(row, 10)).toBe(0);
    expect(karaokeFill(row, 11.85)).toBeCloseTo(0.5, 2);
    expect(karaokeFill(row, 13.8)).toBe(1);
    expect(karaokeFill({ start: 5, end: 5 }, 5.2)).toBeCloseTo(0.4, 5); // zero-length line: still a short sweep
  });

  it('voteShares are whole percent, 0 before anyone voted', () => {
    expect(voteShares([0, 0])).toEqual([0, 0]);
    expect(voteShares([5, 3])).toEqual([63, 38]);
    expect(voteShares([1, 1])).toEqual([50, 50]);
  });

  it('vizLevels: the spectrum while playing, a synthetic envelope without a signal, a low idle wave (4-7%) when paused', () => {
    expect(vizLevels(new Uint8Array(64).fill(255), 8, true, 0).every((v) => v === 1)).toBe(true);
    const synthetic = vizLevels(new Uint8Array(64), 64, true, 0, () => 0.5);
    expect(synthetic).toHaveLength(64);
    expect(synthetic.every((v) => v > 0.2 && v <= 1)).toBe(true);
    expect(synthetic[14]).toBeGreaterThan(synthetic[63] ?? 1); // louder around the low-mid band, like music
    const idle = vizLevels(new Uint8Array(64).fill(255), 64, false, 1234);
    expect(idle.every((v) => v >= 0.04 && v <= 0.07)).toBe(true); // paused ignores the analyser
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

  it('voterId is stable across calls and valid for the API', () => {
    localStorage.clear();
    const id = voterId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(voterId()).toBe(id);
  });
});
