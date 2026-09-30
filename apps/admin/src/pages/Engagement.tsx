import { FormEvent, useEffect, useState } from 'react';
import { EngagementSettings, PollHistoryItem, VoteView, api } from '../api';
import { useChannels } from '../channel-context';
import { mmss, timeAgo } from '../format';
import { errorMessage, useAsync } from '../hooks';
import { useT } from '../i18n';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';

const num = (v: string, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(Number(v) || min)));

export function Engagement() {
  const t = useT();
  const { selected } = useChannels();
  const id = selected?.id;
  const settings = useAsync(() => (id ? api<EngagementSettings>(`/admin/channels/${id}/engagement`) : Promise.resolve(null)), [id]);
  const votes = useAsync(() => (id ? api<{ current: VoteView; history: PollHistoryItem[] }>(`/admin/channels/${id}/tag-votes`) : Promise.resolve(null)), [id], 5000);
  const [form, setForm] = useState<EngagementSettings | null>(null);
  const [allow, setAllow] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data) {
      setForm(settings.data);
      setAllow(settings.data.tagVoteAllowlist.join(', '));
    }
  }, [settings.data]);

  if (!selected) return <p className="muted">{t('common.pickChannel')}</p>;

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    setSaved(false);
    try {
      await api(`/admin/channels/${selected.id}/engagement`, { method: 'PUT', body: { ...form, tagVoteAllowlist: allow.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) } });
      setSaved(true);
      settings.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const set = (patch: Partial<EngagementSettings>): void => setForm((f) => (f ? { ...f, ...patch } : f));
  const cur = votes.data?.current;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('engagement.title')}</h1>
        <span className="muted">{selected.title}</span>
      </div>

      {form && (
        <form className="stack" onSubmit={(e) => void save(e)}>
          <Card title={t('engagement.adsTitle')}>
            <p className="muted">{t('engagement.adsHelp')}</p>
            <label>
              {t('engagement.adsEvery')}
              <input type="number" min={0} max={100} value={form.adsEveryNTracks} onChange={(e) => set({ adsEveryNTracks: num(e.target.value, 0, 100) })} />
            </label>
            <small className="muted">{form.adsEveryNTracks === 0 ? t('engagement.adsOff') : t('engagement.adsOn', { n: form.adsEveryNTracks })}</small>
          </Card>

          <Card title={t('engagement.voteTitle')}>
            <p className="muted">{t('engagement.voteHelp')}</p>
            <label className="radio-line">
              <input type="checkbox" checked={form.tagVoteEnabled} onChange={(e) => set({ tagVoteEnabled: e.target.checked })} />
              {t('engagement.voteEnabled')}
            </label>
            <div className="row wrap">
              <label>
                {t('engagement.interval')}
                <input type="number" min={1} max={1440} value={form.tagVoteIntervalMinutes} onChange={(e) => set({ tagVoteIntervalMinutes: num(e.target.value, 1, 1440) })} />
              </label>
              <label>
                {t('engagement.pollMinutes')}
                <input type="number" min={1} max={60} value={form.tagVotePollMinutes} onChange={(e) => set({ tagVotePollMinutes: num(e.target.value, 1, 60) })} />
              </label>
              <label>
                {t('engagement.playMinutes')}
                <input type="number" min={1} max={240} value={form.tagVotePlayMinutes} onChange={(e) => set({ tagVotePlayMinutes: num(e.target.value, 1, 240) })} />
              </label>
              <label>
                {t('engagement.options')}
                <input type="number" min={2} max={6} value={form.tagVoteOptions} onChange={(e) => set({ tagVoteOptions: num(e.target.value, 2, 6) })} />
              </label>
            </div>
            <label>
              {t('engagement.allowlist')}
              <input value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="rock, jazz, chill" />
            </label>
            <small className="muted">{t('engagement.allowlistHelp')}</small>
          </Card>

          <div className="row">
            <button className="btn btn-primary">{t('common.save')}</button>
            {saved && <Badge tone="good">{t('common.saved')}</Badge>}
          </div>
          <ErrorBox error={error ?? settings.error} />
        </form>
      )}

      <Card
        title={t('engagement.liveVote')}
        actions={
          <ActionButton className="btn-small" disabled={cur?.status !== 'NONE'} onAction={async () => { await api(`/admin/channels/${selected.id}/tag-votes/start`, { method: 'POST' }); votes.reload(); }}>
            {t('engagement.startNow')}
          </ActionButton>
        }
      >
        {cur?.status === 'OPEN' && cur.poll && (
          <p>
            <Badge tone="info">{t('engagement.open')}</Badge> {cur.poll.options.map((o) => `#${o.hashtag} (${o.votes})`).join(' · ')} — {t('engagement.totalVotes', { n: cur.poll.totalVotes })}
          </p>
        )}
        {cur?.status === 'PLAYING' && (
          <p>
            <Badge tone="good">{t('engagement.playing')}</Badge> #{cur.winner}
          </p>
        )}
        {cur?.status === 'NONE' && <p className="muted">{t('engagement.noneActive')}</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('engagement.opened')}</th>
                <th>{t('engagement.options')}</th>
                <th>{t('engagement.winner')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {(votes.data?.history ?? []).map((p) => (
                <tr key={p.id}>
                  <td>{timeAgo(p.opensAt)}</td>
                  <td>{p.options.map((o) => `#${o} (${p.tally[o] ?? 0})`).join(' · ')}</td>
                  <td>{p.winner ? <b>#{p.winner}</b> : <span className="muted">—</span>}</td>
                  <td>
                    {p.status === 'OPEN' ? <Badge tone="info">{t('engagement.open')}</Badge> : p.playUntil && Date.parse(p.playUntil) > Date.now() ? <Badge tone="good">{t('engagement.playing')} · {mmss((Date.parse(p.playUntil) - Date.now()) / 1000)}</Badge> : <Badge>{t('engagement.closed')}</Badge>}
                  </td>
                </tr>
              ))}
              {votes.data?.history.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    {t('engagement.noHistory')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
