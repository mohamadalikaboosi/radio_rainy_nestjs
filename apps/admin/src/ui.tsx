import { ReactNode, useState } from 'react';
import { errorMessage } from './hooks';

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <h2>{title}</h2>
          <div className="row">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? (
    <div className="alert alert-bad" role="alert">
      {error}
    </div>
  ) : null;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** A button that runs an async action, shows progress, and reports failures instead of swallowing them. */
export function ActionButton({ onAction, children, confirm, className = '', disabled }: { onAction: () => Promise<unknown>; children: ReactNode; confirm?: string; className?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const click = async (): Promise<void> => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setErr(null);
    try {
      await onAction();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="action">
      <button className={`btn ${className}`} onClick={() => void click()} disabled={busy || disabled}>
        {busy ? '…' : children}
      </button>
      {err && (
        <span className="inline-error" role="alert">
          {err}
        </span>
      )}
    </span>
  );
}

/** Multi-select of existing hashtags shown as checkboxes (matches the "Available Hashtags" mock). */
export function HashtagChecklist({ all, selected, onChange, weights, onWeight }: {
  all: { normalized: string; value: string; trackCount?: number }[];
  selected: string[];
  onChange: (next: string[]) => void;
  weights?: Record<string, number>;
  onWeight?: (tag: string, w: number) => void;
}) {
  const toggle = (t: string): void => onChange(selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t]);
  return (
    <ul className="checklist">
      {all.map((h) => (
        <li key={h.normalized}>
          <label>
            <input type="checkbox" checked={selected.includes(h.normalized)} onChange={() => toggle(h.normalized)} />
            <span>#{h.value}</span>
            {h.trackCount !== undefined && <small className="muted"> {h.trackCount}</small>}
          </label>
          {weights && onWeight && selected.includes(h.normalized) && (
            <input aria-label={`weight for ${h.value}`} className="weight" type="number" min={0} value={weights[h.normalized] ?? 1} onChange={(e) => onWeight(h.normalized, Number(e.target.value))} />
          )}
        </li>
      ))}
      {all.length === 0 && <li className="muted">No hashtags yet. Sync the Telegram channel first.</li>}
    </ul>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager row">
      <button className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ Prev
      </button>
      <span className="muted">
        Page {page} / {pages} · {total} items
      </span>
      <button className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next ›
      </button>
    </div>
  );
}
