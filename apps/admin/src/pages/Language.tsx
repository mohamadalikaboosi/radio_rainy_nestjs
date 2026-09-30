import { useState } from 'react';
import { api, authStore } from '../api';
import { useAsync } from '../hooks';
import { ActionButton, Badge, Card, ErrorBox, Pager } from '../ui';

interface Stats { lexicon: { lang: string; entries: number; trusted: number; approved: number; rejected: number }[]; tracksByLanguage: { language: string; tracks: number }[] }
interface Entry { lang: string; asrWord: string; lyricWord: string; count: number; status: 'LEARNED' | 'APPROVED' | 'REJECTED' }
const PAGE = 30;
const tone = (s: Entry['status']) => (s === 'APPROVED' ? 'good' : s === 'REJECTED' ? 'bad' : 'warn');

export function Language() {
  const [lang, setLang] = useState<'fa' | 'en' | 'mixed'>('fa');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<string | null>(null);
  const stats = useAsync(() => api<Stats>('/admin/language/stats'), []);
  const list = useAsync(() => api<{ total: number; items: Entry[] }>('/admin/language/lexicon', { query: { lang, status, limit: PAGE, offset: (page - 1) * PAGE } }), [lang, status, page]);
  const refresh = (): void => { stats.reload(); list.reload(); };
  const set = (e: Entry, st: Entry['status']) => async (): Promise<void> => { await api('/admin/language/lexicon', { method: 'PATCH', body: { lang: e.lang, asrWord: e.asrWord, lyricWord: e.lyricWord, status: st } }); refresh(); };

  const download = async (): Promise<void> => {
    const res = await fetch('/admin/language/export', { headers: { Authorization: `Bearer ${authStore.get() ?? ''}` } });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'radio_rainy_training.jsonl';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <Card title="What the system has learned (Persian & English)">
        <p className="muted">
          Every well-aligned song teaches the system how Whisper’s spelling differs from your lyrics (e.g. <code>cuz</code> → <code>because</code>). A spelling is trusted after it is seen in 2 songs or approved here; trusted spellings make future lyric synchronization more accurate.
          This is statistical “training” (no GPU needed). For neural fine-tuning, export the dataset.
        </p>
        <ErrorBox error={stats.error} />
        <div className="stats">
          {(stats.data?.lexicon ?? []).map((l) => <div key={l.lang} className="stat"><div className="stat-value">{l.trusted}<small className="muted"> / {l.entries}</small></div><div className="stat-label">{l.lang === 'fa' ? 'Persian' : l.lang === 'en' ? 'English' : l.lang} trusted / learned</div></div>)}
          {(stats.data?.tracksByLanguage ?? []).map((l) => <div key={l.language} className="stat"><div className="stat-value">{l.tracks}</div><div className="stat-label">tracks: {l.language}</div></div>)}
        </div>
        <div className="row wrap">
          <ActionButton onAction={async () => { const r = await api<{ processed: number; improved: number; learned: number }>('/admin/language/retrain', { method: 'POST', body: { limit: 200, offset: 0 } }); setResult(`Re-aligned ${r.processed} songs: ${r.improved} improved, ${r.learned} new observations.`); refresh(); }}>Re-train on my songs</ActionButton>
          <ActionButton onAction={async () => { const r = await api<{ reviewed: number; approved: number; rejected: number; skipped: number }>('/admin/language/review', { method: 'POST', body: { lang, limit: 40 } }); setResult(`LLM reviewed ${r.reviewed}: ${r.approved} approved, ${r.rejected} rejected, ${r.skipped} skipped.`); refresh(); }}>Review with LLM ({lang})</ActionButton>
          <ActionButton onAction={download}>Export training dataset (JSONL)</ActionButton>
        </div>
        {result && <div className="alert alert-good">{result}</div>}
      </Card>

      <Card title="Learned spellings">
        <div className="row wrap">
          <label>Language <select value={lang} onChange={(e) => { setLang(e.target.value as 'fa' | 'en' | 'mixed'); setPage(1); }}><option value="fa">Persian</option><option value="en">English</option><option value="mixed">Mixed</option></select></label>
          <label>Status <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">Any</option><option value="LEARNED">Learned</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select></label>
        </div>
        <ErrorBox error={list.error} />
        <table>
          <thead><tr><th>Whisper wrote</th><th>Lyrics say</th><th>Seen</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(list.data?.items ?? []).map((e) => (
              <tr key={`${e.asrWord}>${e.lyricWord}`}>
                <td dir="auto">{e.asrWord}</td><td dir="auto">{e.lyricWord}</td><td>{e.count}</td><td><Badge tone={tone(e.status)}>{e.status}</Badge></td>
                <td className="row">
                  <ActionButton className="btn-small" onAction={set(e, 'APPROVED')}>Approve</ActionButton>
                  <ActionButton className="btn-small" onAction={set(e, 'REJECTED')}>Reject</ActionButton>
                  <ActionButton className="btn-small btn-danger" onAction={async () => { await api('/admin/language/lexicon', { method: 'DELETE', query: { lang: e.lang, asrWord: e.asrWord, lyricWord: e.lyricWord } }); refresh(); }}>Delete</ActionButton>
                </td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && <tr><td colSpan={5} className="muted">Nothing learned yet. It fills up as songs are synchronized.</td></tr>}
          </tbody>
        </table>
        {list.data && <Pager page={page} pageSize={PAGE} total={list.data.total} onPage={setPage} />}
      </Card>
    </div>
  );
}
