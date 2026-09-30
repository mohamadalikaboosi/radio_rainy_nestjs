import { useState } from 'react';
import { Link } from 'react-router-dom';
import { HashtagStat, api } from '../api';
import { timeAgo } from '../format';
import { useAsync } from '../hooks';
import { ActionButton, Card, ErrorBox } from '../ui';

interface Analytics { items: HashtagStat[]; refreshedAt: string | null; mostPlayed: HashtagStat[]; noPlayableTracks: HashtagStat[]; withFailedLyrics: HashtagStat[]; recentlyAdded: HashtagStat[] }
interface MiniTrack { id: string; title: string; artist: string | null; enabled: boolean; status: string }

const Table = ({ rows, onPick }: { rows: HashtagStat[]; onPick?: (h: HashtagStat) => void }) => (
  <table>
    <thead><tr><th>Hashtag</th><th>Tracks</th><th>Playable</th><th>Plays</th><th>Failed lyrics</th><th>Last played</th></tr></thead>
    <tbody>
      {rows.map((h) => (
        <tr key={h.hashtagId}>
          <td>{onPick ? <a href="#tracks" onClick={(e) => { e.preventDefault(); onPick(h); }}>#{h.value}</a> : `#${h.value}`}</td>
          <td>{h.trackCount}</td><td>{h.playableCount}</td><td>{h.plays}</td><td>{h.failedLyricsCount}</td><td>{timeAgo(h.lastPlayedAt)}</td>
        </tr>
      ))}
      {rows.length === 0 && <tr><td colSpan={6} className="muted">None.</td></tr>}
    </tbody>
  </table>
);

export function Hashtags() {
  const stats = useAsync(() => api<Analytics>('/admin/hashtags/stats'), []);
  const [picked, setPicked] = useState<HashtagStat | null>(null);
  const tracks = useAsync(() => (picked ? api<MiniTrack[]>(`/admin/hashtags/${picked.hashtagId}/tracks`) : Promise.resolve([])), [picked?.hashtagId]);
  const d = stats.data;

  return (
    <div className="stack">
      <ErrorBox error={stats.error} />
      <Card title="Hashtags" actions={<><span className="muted">Aggregated {timeAgo(d?.refreshedAt ?? null)}</span><ActionButton onAction={async () => { await api('/admin/hashtags/stats/refresh', { method: 'POST' }); stats.reload(); }}>Refresh</ActionButton></>}>
        <Table rows={d?.items ?? []} onPick={setPicked} />
      </Card>
      {picked && (
        <Card title={`Tracks with #${picked.value}`} actions={<button className="btn btn-small" onClick={() => setPicked(null)}>Close</button>}>
          <ul>{(tracks.data ?? []).map((t) => <li key={t.id}><Link to={`/panel/tracks/${t.id}`}>{t.artist ? `${t.artist} – ` : ''}{t.title}</Link> {!t.enabled && <small className="muted">(disabled)</small>}</li>)}</ul>
        </Card>
      )}
      <div className="cols">
        <Card title="Most played"><Table rows={d?.mostPlayed ?? []} /></Card>
        <Card title="No playable tracks"><Table rows={d?.noPlayableTracks ?? []} /></Card>
        <Card title="With failed lyrics"><Table rows={d?.withFailedLyrics ?? []} /></Card>
        <Card title="Recently added"><Table rows={d?.recentlyAdded ?? []} /></Card>
      </div>
    </div>
  );
}
