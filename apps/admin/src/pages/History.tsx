import { api } from '../api';
import { timeAgo } from '../format';
import { NeedChannel, radioPath } from '../channel-context';
import { useAsync } from '../hooks';
import { Badge, Card, ErrorBox } from '../ui';

interface Row { id: string; trackId: string; title: string; artist: string | null; startedAt: string; endedAt: string | null; endReason: string | null }

export function History() {
  return <NeedChannel>{(c) => <HistoryFor key={c.id} channelId={c.id} title={c.title} />}</NeedChannel>;
}

function HistoryFor({ channelId, title }: { channelId: string; title: string }) {
  const { data, error } = useAsync(() => api<Row[]>(radioPath(channelId, 'history'), { query: { limit: 100 } }), [channelId], 5000);
  return (
    <Card title={`Playback history — ${title}`}>
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
