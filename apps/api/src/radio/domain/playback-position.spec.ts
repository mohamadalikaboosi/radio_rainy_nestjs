import { findActiveLine, computePosition } from './playback-position';

const lines = [
  { start: 1, end: 4, text: 'a', confidence: 1 },
  { start: 5, end: 8, text: 'b', confidence: 1 },
  { start: 30, end: 33, text: 'c', confidence: 1 },
];

describe('findActiveLine', () => {
  it('finds the current line, none before the first, holds briefly after the end', () => {
    expect(findActiveLine(lines, 0.5)).toBeNull();
    expect(findActiveLine(lines, 1)?.index).toBe(0);
    expect(findActiveLine(lines, 4.5)?.index).toBe(0); // between lines: previous stays
    expect(findActiveLine(lines, 5)?.index).toBe(1);
    expect(findActiveLine(lines, 33.5)?.index).toBe(2);
  });
  it('nothing is active during a long instrumental gap or after the last line', () => {
    expect(findActiveLine(lines, 20)).toBeNull();
    expect(findActiveLine(lines, 100)).toBeNull();
    expect(findActiveLine([], 5)).toBeNull();
  });
});

describe('computePosition', () => {
  it('is wall-clock based, never negative, clamped to duration', () => {
    const start = new Date(1_000_000);
    expect(computePosition(start, 1_084_000, 245)).toBe(84);
    expect(computePosition(start, 999_000, 245)).toBe(0);
    expect(computePosition(start, 9_000_000, 245)).toBe(245);
    expect(computePosition(start, 1_010_000, null)).toBe(10);
  });
});
