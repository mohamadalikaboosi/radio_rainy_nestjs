import { ReactNode, useState } from 'react';

// ---------- pure helpers (unit tested) ----------

/** Round the top of a value axis to a clean number (1, 2, 5 x 10^n) and return evenly spaced ticks including 0. */
export function niceScale(max: number, ticks = 4): { top: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, ticks: [0, 1] };
  const rough = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return { top, ticks: out };
}

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export const pct = (x: number): string => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;

// ---------- shared pieces ----------

export interface TableColumn { key: string; label: string }

/** Accessible alternative to every chart: the same numbers as a table. */
export function TableView({ columns, rows }: { columns: TableColumn[]; rows: Record<string, ReactNode>[] }) {
  return (
    <details className="table-view">
      <summary>View as table</summary>
      <div className="table-wrap">
        <table>
          <thead><tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c.key}>{r[c.key]}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

export function Legend({ items }: { items: { label: string; color: string; prefix?: string }[] }) {
  return (
    <div className="legend" role="list">
      {items.map((i) => <span key={i.label} role="listitem"><span className="sw" style={{ background: i.color }} />{i.prefix}{i.label}</span>)}
    </div>
  );
}

interface Tip { x: number; y: number; html: ReactNode }

const W = 640;
const PAD = { l: 42, r: 12, t: 10, b: 24 };

function xTickIndexes(n: number, max = 7): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

export interface Point { label: string; tip: string; value: number }

/** Columns (<=24px wide, 4px rounded data end, square at the baseline, 2px gaps), hairline grid, hover tooltip. */
export function ColumnChart({ points, height = 190, color = 'var(--series-1)', ariaLabel, unit = '' }: { points: Point[]; height?: number; color?: string; ariaLabel: string; unit?: string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const { top, ticks } = niceScale(Math.max(0, ...points.map((p) => p.value)));
  const innerW = W - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const band = points.length ? innerW / points.length : innerW;
  const bw = Math.max(2, Math.min(24, band - 2));
  const y = (v: number): number => PAD.t + innerH - (v / top) * innerH;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{fmtInt(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = PAD.l + band * i + band / 2;
          const h = Math.max(0, (p.value / top) * innerH);
          const x0 = cx - bw / 2;
          const yTop = PAD.t + innerH - h;
          const r = Math.min(4, h, bw / 2);
          return (
            <g key={i}>
              {h > 0 && <path d={`M${x0},${PAD.t + innerH} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + bw - r} Q${x0 + bw},${yTop} ${x0 + bw},${yTop + r} V${PAD.t + innerH} Z`} fill={color} opacity={hover === null || hover === i ? 1 : 0.55} />}
              <rect className="hit" x={PAD.l + band * i} y={PAD.t} width={band} height={innerH} onMouseEnter={() => { setHover(i); setTip({ x: (cx / W) * 100, y: (Math.min(yTop, PAD.t + innerH - 14) / height) * 100, html: <><b>{fmtInt(p.value)}{unit}</b> · {p.tip}</> }); }} onMouseLeave={() => { setHover(null); setTip(null); }} />
            </g>
          );
        })}
        <line className="axis" x1={PAD.l} x2={W - PAD.r} y1={PAD.t + innerH} y2={PAD.t + innerH} />
        {xTickIndexes(points.length).map((i) => <text key={i} x={PAD.l + band * i + band / 2} y={height - 6} textAnchor="middle">{points[i]?.label}</text>)}
      </svg>
      {tip && <div className="tip" style={{ left: `${tip.x}%`, top: `${tip.y}%` }}>{tip.html}</div>}
    </div>
  );
}

export interface Series { name: string; color: string; values: number[] }

/** Up to two lines (2px), 10% area wash on the first, 8px end dots with a 2px surface ring, crosshair + tooltip. */
export function LineChart({ labels, tips, series, height = 190, ariaLabel }: { labels: string[]; tips: string[]; series: Series[]; height?: number; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const { top, ticks } = niceScale(Math.max(0, ...series.flatMap((s) => s.values)));
  const innerW = W - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const x = (i: number): number => PAD.l + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v: number): number => PAD.t + innerH - (v / top) * innerH;
  const path = (vals: number[]): string => vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const first = series[0];
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (<g key={t}><line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} /><text x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{fmtInt(t)}</text></g>))}
        <line className="axis" x1={PAD.l} x2={W - PAD.r} y1={PAD.t + innerH} y2={PAD.t + innerH} />
        {first && n > 1 && <path d={`${path(first.values)} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={first.color} opacity={0.1} />}
        {series.map((s) => <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />)}
        {series.map((s) => n > 0 && <circle key={`${s.name}-end`} cx={x(n - 1)} cy={y(s.values[n - 1] ?? 0)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />)}
        {hover !== null && <line className="axis" x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + innerH} />}
        {hover !== null && series.map((s) => <circle key={`${s.name}-h`} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />)}
        {xTickIndexes(n).map((i) => <text key={i} x={x(i)} y={height - 6} textAnchor="middle">{labels[i]}</text>)}
        {labels.map((_, i) => <rect key={i} className="hit" x={x(i) - innerW / Math.max(1, n - 1) / 2} y={PAD.t} width={innerW / Math.max(1, n - 1)} height={innerH} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />)}
      </svg>
      {hover !== null && <div className="tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(PAD.t / height) * 100 + 8}%` }}>{tips[hover]} — {series.map((s) => `${s.name}: ${fmtInt(s.values[hover] ?? 0)}`).join(' · ')}</div>}
    </div>
  );
}

/** Horizontal bars for rankings: label on the left, value at the bar tip (text tokens, never the series color). */
export function HBars({ items, empty = 'No data in this period.', color = 'var(--series-1)' }: { items: { label: ReactNode; value: number; hint?: string }[]; empty?: string; color?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="hbars">
      {items.map((i, idx) => (
        <div className="hbar" key={idx} title={i.hint}>
          <div className="hbar-label">{i.label}</div>
          <div className="hbar-track"><div className="hbar-fill" style={{ width: `${(i.value / max) * 100}%`, background: color }} /><span className="hbar-val">{fmtInt(i.value)}</span></div>
        </div>
      ))}
    </div>
  );
}

/** One stacked bar (2px gaps) + legend with counts. Status colors always come with an icon + label. */
export function SegmentBar({ segments }: { segments: { label: string; value: number; color: string; icon?: string }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div>
      {total === 0 ? <p className="muted">No plays in this period.</p> : (
        <div className="segbar" role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(', ')}>
          {segments.filter((s) => s.value > 0).map((s) => <div key={s.label} style={{ flex: s.value, background: s.color }} title={`${s.label}: ${s.value} (${pct(s.value / total)})`} />)}
        </div>
      )}
      <Legend items={segments.map((s) => ({ label: `${s.label} — ${fmtInt(s.value)}${total ? ` (${pct(s.value / total)})` : ''}`, color: s.color, prefix: s.icon ? `${s.icon} ` : '' }))} />
    </div>
  );
}
