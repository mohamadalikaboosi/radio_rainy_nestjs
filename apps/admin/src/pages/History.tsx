import { api } from '../api';
import { timeAgo } from '../format';
import { useAsync } from '../hooks';
import { Badge, Card, ErrorBox } from '../ui';

interface Row { id: string; trackId: string; title: string; artist: string | null; startedAt: string; endedAt: string | null; endReason: string | null }

export function History() {
  const { data, error } = useAsync(() => api<Row[]>('/admin/radio/history', { query: { limit: 100 } }), [], 5000);
  return (
    <Card title="Playback history">
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>Track</th><th>Started</th><th>Result</th></tr></thead>
        <tbody>
          {(data ?? []).map((r) => (
            <tr key={r.id}>
              <td>{r.artist ? `${r.artist} – ` : ''}{r.title}</td>
              <td>{timeAgo(r.startedAt)}</td>
              <td>{r.endReason ? <Badge tone={r.endReason === 'FINISHED' ? 'good' : r.endReason === 'ERROR' ? 'bad' : 'neutral'}>{r.endReason}</Badge> : <Badge tone="info">playing</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
