import { fireEvent, render, screen } from '@testing-library/react';
import { ColumnChart, HBars, LineChart, SegmentBar, TableView, fmtDuration, fmtInt, niceScale, pct } from './charts';

describe('chart helpers', () => {
  it('niceScale rounds the axis top to clean numbers and starts at 0', () => {
    expect(niceScale(0)).toEqual({ top: 1, ticks: [0, 1] });
    expect(niceScale(7).ticks).toEqual([0, 2, 4, 6, 8]);
    expect(niceScale(950).top).toBe(1000);
    expect(niceScale(950).ticks[0]).toBe(0);
    expect(niceScale(Number.NaN).top).toBe(1);
  });
  it('formats numbers, durations and percentages', () => {
    expect(fmtInt(12345)).toBe('12,345');
    expect(fmtDuration(59)).toBe('59s');
    expect(fmtDuration(125)).toBe('2m 5s');
    expect(fmtDuration(3 * 3600 + 120)).toBe('3h 2m');
    expect(fmtDuration(50 * 3600)).toBe('2d 2h');
    expect(pct(0.25)).toBe('25%');
    expect(pct(0.05)).toBe('5.0%');
    expect(pct(0)).toBe('0%');
  });
});

describe('charts', () => {
  const points = [{ label: 'a', tip: 'Mon 10:00', value: 5 }, { label: 'b', tip: 'Mon 11:00', value: 0 }, { label: 'c', tip: 'Mon 12:00', value: 12 }];

  it('ColumnChart has an accessible name, grid, one bar per non-zero point and a hover tooltip', () => {
    const { container } = render(<ColumnChart points={points} ariaLabel="Plays per hour" unit=" plays" />);
    expect(screen.getByRole('img', { name: 'Plays per hour' })).toBeInTheDocument();
    expect(container.querySelectorAll('path')).toHaveLength(2); // the zero point draws no bar
    fireEvent.mouseEnter(container.querySelectorAll('rect.hit')[2] as Element);
    expect(screen.getByText(/12 plays/)).toBeInTheDocument();
    expect(screen.getByText(/Mon 12:00/)).toBeInTheDocument();
    fireEvent.mouseLeave(container.querySelectorAll('rect.hit')[2] as Element);
    expect(screen.queryByText(/Mon 12:00/)).not.toBeInTheDocument();
  });

  it('bars never exceed 24px even with few points', () => {
    const { container } = render(<ColumnChart points={[{ label: 'x', tip: 't', value: 3 }]} ariaLabel="one" />);
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    const xs = [...d.matchAll(/[MHQ]\s?(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(24.01);
  });

  it('LineChart draws each series, end dots and a crosshair tooltip with all series values', () => {
    const { container } = render(<LineChart ariaLabel="Listeners" labels={['a', 'b', 'c']} tips={['t1', 't2', 't3']} series={[{ name: 'Average', color: 'var(--series-1)', values: [1, 2, 3] }, { name: 'Peak', color: 'var(--series-2)', values: [2, 4, 6] }]} />);
    expect(container.querySelectorAll('path[stroke]')).toHaveLength(2);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    fireEvent.mouseEnter(container.querySelectorAll('rect.hit')[1] as Element);
    expect(screen.getByText(/t2 — Average: 2 · Peak: 4/)).toBeInTheDocument();
  });

  it('HBars shows values at the bar tip and an empty message', () => {
    const { rerender } = render(<HBars items={[{ label: 'A', value: 10 }, { label: 'B', value: 5 }]} />);
    expect(screen.getByText('10')).toBeInTheDocument();
    rerender(<HBars items={[]} empty="Nothing here." />);
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('SegmentBar lists every outcome (icon + label for failures) and handles zero totals', () => {
    const { rerender } = render(<SegmentBar segments={[{ label: 'Finished', value: 3, color: 'a' }, { label: 'Failed', value: 1, color: 'b', icon: '✕' }]} />);
    expect(screen.getByText(/Finished — 3 \(75%\)/)).toBeInTheDocument();
    expect(screen.getByText(/✕ Failed — 1 \(25%\)/)).toBeInTheDocument();
    rerender(<SegmentBar segments={[{ label: 'Finished', value: 0, color: 'a' }]} />);
    expect(screen.getByText('No plays in this period.')).toBeInTheDocument();
  });

  it('TableView exposes the same numbers as a table', () => {
    render(<TableView columns={[{ key: 'a', label: 'A' }]} rows={[{ a: 42 }]} />);
    expect(screen.getByText('View as table')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});
