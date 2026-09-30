import { useEffect, useState } from 'react';
import { ApiError, ConfigView, HashtagStat, PreviewResult, RadioMode, api } from '../api';
import { NeedChannel, radioPath } from '../channel-context';
import { errorMessage, useAsync } from '../hooks';
import { ActionButton, Badge, Card, ErrorBox, HashtagChecklist } from '../ui';

export interface Draft {
  mode: RadioMode;
  hashtagMatchMode: 'ANY' | 'ALL';
  recentTrackWindow: number;
  fallbackToGlobal: boolean;
  enabled: boolean;
  selected: string[];
  weights: Record<string, number>;
}

export function draftFrom(c: ConfigView): Draft {
  return {
    mode: c.mode,
    hashtagMatchMode: c.hashtagMatchMode,
    recentTrackWindow: c.recentTrackWindow,
    fallbackToGlobal: c.fallbackToGlobal,
    enabled: c.enabled,
    selected: c.hashtags.map((h) => h.hashtag),
    weights: Object.fromEntries(c.hashtags.map((h) => [h.hashtag, h.weight])),
  };
}

/** Exactly what is sent to the API: the UI never selects tracks itself, the backend RadioRuleEngine does. */
export function toUpdateBody(d: Draft, expectedVersion: number, apply: 'NEXT_TRACK' | 'IMMEDIATE') {
  return {
    mode: d.mode,
    hashtagMatchMode: d.hashtagMatchMode,
    recentTrackWindow: d.recentTrackWindow,
    fallbackToGlobal: d.fallbackToGlobal,
    enabled: d.enabled,
    hashtags: d.selected.map((hashtag) => ({ hashtag, weight: d.weights[hashtag] ?? 1 })),
    expectedVersion,
    apply,
  };
}

const MODES: { value: RadioMode; label: string; hint: string }[] = [
  { value: 'GLOBAL_RANDOM', label: 'Global Random', hint: 'Any enabled track.' },
  { value: 'HASHTAG_RANDOM', label: 'Hashtag Random', hint: 'Random among tracks matching the selected hashtags.' },
  { value: 'HASHTAG_ROTATION', label: 'Hashtag Rotation', hint: 'Cycle through the selected hashtags in order, random track inside each.' },
  { value: 'CUSTOM_RULE', label: 'Custom Rules', hint: 'Prioritized rules (see Rules page).' },
];

export function PreviewPanel({ draft, channelId }: { draft: Draft; channelId: string }) {
  const [seed, setSeed] = useState('');
  const [limit, setLimit] = useState(10);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setError(null);
    try {
      setResult(
        await api<PreviewResult>(radioPath(channelId, 'preview'), {
          method: 'POST',
          body: {
            mode: draft.mode,
            hashtags: draft.selected.map((hashtag) => ({ hashtag, weight: draft.weights[hashtag] ?? 1 })),
            match: draft.hashtagMatchMode,
            recentTrackWindow: draft.recentTrackWindow,
            limit,
            ...(seed.trim() !== '' ? { seed: Number(seed) } : {}),
          },
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Card title="Preview" actions={<ActionButton onAction={run}>Preview selection</ActionButton>}>
      <div className="row">
        <label>Limit <input type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>
        <label>Seed (optional) <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" /></label>
      </div>
      <ErrorBox error={error} />
      {result && (
        <>
          <p>
            Mode <b>{result.mode}</b> · eligible tracks <b>{result.eligibleCount}</b> · seed <code>{result.seed}</code>
          </p>
          <ol className="preview-list">
            {result.tracks.map((t, i) => (
              <li key={`${t.id}-${i}`}>
                {t.artist ? `${t.artist} – ` : ''}{t.title} <span className="muted">{t.hashtags.map((h) => `#${h}`).join(' ')}</span>
              </li>
            ))}
          </ol>
          {result.tracks.length === 0 && <p className="muted">No track could be selected with this configuration.</p>}
        </>
      )}
    </Card>
  );
}

export function RadioConfig() {
  return <NeedChannel>{(c) => <RadioConfigFor key={c.id} channelId={c.id} title={c.title} />}</NeedChannel>;
}

function RadioConfigFor({ channelId, title }: { channelId: string; title: string }) {
  const cfg = useAsync(() => api<ConfigView>(radioPath(channelId, 'config')), [channelId]);
  const tags = useAsync(() => api<{ items: HashtagStat[] }>('/admin/hashtags'), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (cfg.data) setDraft(draftFrom(cfg.data));
  }, [cfg.data]);

  if (!draft || !cfg.data) return <ErrorBox error={cfg.error} />;
  const set = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch });
  const usesTags = draft.mode === 'HASHTAG_RANDOM' || draft.mode === 'HASHTAG_ROTATION';

  const apply = (mode: 'NEXT_TRACK' | 'IMMEDIATE') => async (): Promise<void> => {
    setSaved(null);
    setConflict(false);
    try {
      const updated = await api<ConfigView>(radioPath(channelId, 'config'), { method: 'PUT', body: toUpdateBody(draft, cfg.data?.version ?? 0, mode) });
      setSaved(`Saved as version ${updated.version} (${mode === 'IMMEDIATE' ? 'applied immediately' : 'applies from the next track'}).`);
      cfg.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      throw e;
    }
  };

  const move = (i: number, dir: -1 | 1): void => {
    const next = [...draft.selected];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    set({ selected: next });
  };

  return (
    <div className="stack">
      <Card title={`Radio configuration — ${title}`} actions={<Badge tone="info">version {cfg.data.version}</Badge>}>
        <fieldset>
          <legend>Selection mode</legend>
          {MODES.map((m) => (
            <label key={m.value} className="radio-line">
              <input type="radio" name="mode" checked={draft.mode === m.value} onChange={() => set({ mode: m.value })} />
              <span><b>{m.label}</b> <small className="muted">{m.hint}</small></span>
            </label>
          ))}
        </fieldset>

        {usesTags && (
          <>
            <h3>Available hashtags</h3>
            <HashtagChecklist
              all={(tags.data?.items ?? []).map((h) => ({ normalized: h.normalized, value: h.value, trackCount: h.playableCount }))}
              selected={draft.selected}
              onChange={(selected) => set({ selected })}
              weights={draft.mode === 'HASHTAG_RANDOM' ? draft.weights : undefined}
              onWeight={(t, w) => set({ weights: { ...draft.weights, [t]: w } })}
            />
            {draft.mode === 'HASHTAG_RANDOM' && (
              <fieldset>
                <legend>Match mode</legend>
                <label className="radio-line"><input type="radio" name="match" checked={draft.hashtagMatchMode === 'ANY'} onChange={() => set({ hashtagMatchMode: 'ANY' })} /> ANY selected hashtag</label>
                <label className="radio-line"><input type="radio" name="match" checked={draft.hashtagMatchMode === 'ALL'} onChange={() => set({ hashtagMatchMode: 'ALL' })} /> ALL selected hashtags</label>
              </fieldset>
            )}
            {draft.mode === 'HASHTAG_ROTATION' && draft.selected.length > 1 && (
              <div>
                <h3>Rotation order</h3>
                <ol>
                  {draft.selected.map((t, i) => (
                    <li key={t}>#{t} <button className="btn btn-small" onClick={() => move(i, -1)} aria-label={`move ${t} up`}>↑</button> <button className="btn btn-small" onClick={() => move(i, 1)} aria-label={`move ${t} down`}>↓</button></li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}

        <div className="row wrap">
          <label>Recent track window <input type="number" min={0} value={draft.recentTrackWindow} onChange={(e) => set({ recentTrackWindow: Number(e.target.value) })} /></label>
          <label className="radio-line"><input type="checkbox" checked={draft.fallbackToGlobal} onChange={(e) => set({ fallbackToGlobal: e.target.checked })} /> Fall back to global random when nothing matches</label>
          <label className="radio-line"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Radio enabled</label>
        </div>

        {conflict && (
          <div className="alert alert-warn" role="alert">
            Another admin changed the configuration. <button className="btn btn-small" onClick={cfg.reload}>Reload latest</button>
          </div>
        )}
        {saved && <div className="alert alert-good">{saved}</div>}
        <div className="row">
          <ActionButton className="btn-primary" onAction={apply('NEXT_TRACK')}>Apply for next track</ActionButton>
          <ActionButton className="btn-danger" confirm="This stops the current track and selects a new one right now. Continue?" onAction={apply('IMMEDIATE')}>Apply immediately</ActionButton>
        </div>
      </Card>
      <PreviewPanel draft={draft} channelId={channelId} />
    </div>
  );
}
