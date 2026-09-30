import { FormEvent, useState } from 'react';
import { HashtagStat, RuleView, api } from '../api';
import { NeedChannel, radioPath } from '../channel-context';
import { errorMessage, useAsync } from '../hooks';
import { ActionButton, Badge, Card, ErrorBox, HashtagChecklist } from '../ui';

interface RuleForm {
  id?: string;
  name: string;
  priority: number;
  matchMode: 'ANY' | 'ALL';
  weight: number;
  enabled: boolean;
  include: string[];
  exclude: string[];
}

const empty: RuleForm = { name: '', priority: 1, matchMode: 'ANY', weight: 1, enabled: true, include: [], exclude: [] };

export function Rules() {
  return <NeedChannel>{(c) => <RulesFor key={c.id} channelId={c.id} title={c.title} />}</NeedChannel>;
}

function RulesFor({ channelId, title }: { channelId: string; title: string }) {
  const cfg = useAsync(() => api<{ version: number; rules: RuleView[] }>(radioPath(channelId, 'config')), [channelId]);
  const tags = useAsync(() => api<{ items: HashtagStat[] }>('/admin/hashtags'), []);
  const [form, setForm] = useState<RuleForm | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    const { id, ...body } = form;
    try {
      if (id) await api(radioPath(channelId, `rules/${id}`), { method: 'PUT', body });
      else await api(radioPath(channelId, 'rules'), { method: 'POST', body });
      setForm(null);
      cfg.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const all = (tags.data?.items ?? []).map((h) => ({ normalized: h.normalized, value: h.value }));
  const rules = [...(cfg.data?.rules ?? [])].sort((a, b) => a.priority - b.priority);

  return (
    <div className="stack">
      <Card title={`Radio rules — ${title}`} actions={<button className="btn btn-primary" onClick={() => setForm({ ...empty, priority: (rules.at(-1)?.priority ?? 0) + 1 })}>+ New rule</button>}>
        <p className="muted">Used in “Custom Rules” mode. Rules are evaluated by priority (lowest number first); the first rule that has playable tracks wins. Rules sharing a priority form a tier and are weighted against each other.</p>
        <ErrorBox error={cfg.error} />
        <table>
          <thead><tr><th>Priority</th><th>Name</th><th>Match</th><th>Include</th><th>Exclude</th><th>Weight</th><th>Enabled</th><th /></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.priority}</td>
                <td>{r.name}</td>
                <td>{r.matchMode}</td>
                <td>{r.include.map((h) => `#${h}`).join(' ')}</td>
                <td>{r.exclude.map((h) => `#${h}`).join(' ')}</td>
                <td>{r.weight}</td>
                <td><Badge tone={r.enabled ? 'good' : 'neutral'}>{r.enabled ? 'yes' : 'no'}</Badge></td>
                <td className="row">
                  <button className="btn btn-small" onClick={() => setForm({ ...r })}>Edit</button>
                  <ActionButton className="btn-small btn-danger" confirm={`Delete rule "${r.name}"?`} onAction={async () => { await api(radioPath(channelId, `rules/${r.id}`), { method: 'DELETE' }); cfg.reload(); }}>Delete</ActionButton>
                </td>
              </tr>
            ))}
            {rules.length === 0 && <tr><td colSpan={8} className="muted">No rules yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      {form && (
        <Card title={form.id ? 'Edit rule' : 'New rule'}>
          <form className="stack" onSubmit={(e) => void save(e)}>
            <div className="row wrap">
              <label>Name <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
              <label>Priority <input type="number" min={0} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} /></label>
              <label>Weight <input type="number" min={0} value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} /></label>
              <label>Match <select value={form.matchMode} onChange={(e) => setForm({ ...form, matchMode: e.target.value as 'ANY' | 'ALL' })}><option>ANY</option><option>ALL</option></select></label>
              <label className="radio-line"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
            </div>
            <div className="cols">
              <div><h3>Include</h3><HashtagChecklist all={all} selected={form.include} onChange={(include) => setForm({ ...form, include })} /></div>
              <div><h3>Exclude</h3><HashtagChecklist all={all} selected={form.exclude} onChange={(exclude) => setForm({ ...form, exclude })} /></div>
            </div>
            <ErrorBox error={error} />
            <div className="row">
              <button className="btn btn-primary" disabled={form.include.length === 0}>Save rule</button>
              <button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
