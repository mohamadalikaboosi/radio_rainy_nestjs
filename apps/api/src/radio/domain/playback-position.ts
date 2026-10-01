import { AlignedLine } from '../../lyrics/domain/lyrics-aligner';

/** Seconds into the track; clamped to [0, duration]. */
export function computePosition(startedAt: Date, now: number, duration: number | null): number {
  const pos = Math.max(0, (now - startedAt.getTime()) / 1000);
  return duration !== null ? Math.min(pos, duration) : pos;
}

export interface ActiveLine {
  index: number;
  start: number;
  end: number;
  text: string;
}

/**
 * The line being sung at `position`: the last line whose start <= position (binary search).
 * During long instrumental gaps (more than `holdSeconds` after the line ended) nothing is active.
 */
export function findActiveLine(lines: readonly AlignedLine[], position: number, holdSeconds = 4): ActiveLine | null {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid];
    if (line && line.start <= position) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const line = found >= 0 ? lines[found] : undefined;
  if (!line) return null;
  if (position > line.end + holdSeconds) return null;
  return { index: found, start: line.start, end: line.end, text: line.text };
}
