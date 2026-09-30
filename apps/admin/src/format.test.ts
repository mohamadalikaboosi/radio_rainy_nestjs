import { mmss, normalizeTag, timeAgo } from './format';

describe('format', () => {
  it('mmss', () => {
    expect(mmss(134)).toBe('02:14');
    expect(mmss(0)).toBe('00:00');
    expect(mmss(null)).toBe('--:--');
    expect(mmss(-5)).toBe('00:00');
  });
  it('timeAgo', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(timeAgo('2026-01-01T11:59:30Z', now)).toBe('30s ago');
    expect(timeAgo('2026-01-01T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo(null, now)).toBe('—');
  });
  it('normalizeTag', () => expect(normalizeTag(' #Rain ')).toBe('rain'));
});
