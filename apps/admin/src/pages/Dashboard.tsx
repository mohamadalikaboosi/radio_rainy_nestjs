import { Link } from 'react-router-dom';
import { api } from '../api';
import { mmss, timeAgo } from '../format';
import { useAsync } from '../hooks';
import { ActionButton, Badge, Card, ErrorBox, Stat } from '../ui';

interface DashboardData {
  radio: {
    status: 'PLAYING' | 'STOPPED' | 'IDLE' | 'ERROR';
    statusReason: string | null;
    transitionSeq: number;
    configurationVersion: number;
    listeners: number;
    current: { trackId: string; title: string; artist: string | null; duration: number | null; position: number } | null;
    next: { trackId: string; title: string; artist: string | null } | null;
    selection: { mode: string; matchMode: string; activeHashtags: string[]; recentTrackWindow: number; enabled: boolean };
  };
  counts: { totalTracks: number; playableTracks: number; tracksWithLyrics: number; tracksWaitingForLyrics: number; failedTracks: number; failedLyrics: number; disabledTracks: number; hashtags: number };
  recentlyPlayed: { id: string; trackId: string; title: string; artist: string | null; startedAt: string; endReason: string | null }[];
  telegram: { state: string; accountLabel: string | null };
}

const MODE_LABEL: Record<string, string> = { GLOBAL_RANDOM: 'Global Random', HASHTAG_RANDOM: 'Hashtag Random', HASHTAG_ROTATION: 'Hashtag Rotation', CUSTOM_RULE: 'Custom Rules' };
const tone = (s: string) => (s === 'PLAYING' ? 'good' : s === 'ERROR' ? 'bad' : 'warn');

export function Dashboard() {
  const { data, error, reload } = useAsync(() => api<DashboardData>('/admin/dashboard'), [], 3000);
  if (!data) return <ErrorBox error={error} />;
  const { radio, counts } = data;
  const cur = radio.current;
  const pct = cur && cur.duration ? Math.min(100, (cur.position / cur.duration) * 100) : 0;

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <Card title="Radio status" actions={<Badge tone={tone(radio.status)}>{radio.status}</Badge>}>
        {cur ? (
          <>
            <div className="now">
              <div className="now-title">{cur.artist ? `${cur.artist} – ` : ''}{cur.title}</div>
              <div className="progress" aria-label="playback position">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="muted">{mmss(cur.position)} / {mmss(cur.duration)} · {radio.listeners} listener(s)</div>
            </div>
            <div className="row">
              <ActionButton onAction={async () => { await api('/admin/radio/skip', { method: 'POST', body: { expectedSeq: radio.transitionSeq } }); reload(); }}>⏭ Skip current</ActionButton>
              <ActionButton onAction={async () => { await api('/admin/radio/play-next', { method: 'POST', body: {} }); reload(); }}>▶ Play next</ActionButton>
            </div>
          </>
        ) : (
          <p className="muted">Nothing is playing{radio.statusReason ? ` — ${radio.statusReason}` : ''}.</p>
        )}
        {radio.next && <p className="muted">Next: {radio.next.artist ? `${radio.next.artist} – ` : ''}{radio.next.title}</p>}
        <hr />
        <div className="kv">
          <span>Selection</span>
          <b>{MODE_LABEL[radio.selection.mode] ?? radio.selection.mode}</b>
          {radio.selection.activeHashtags.length > 0 && (
            <>
              <span>Active hashtags ({radio.selection.matchMode})</span>
              <b>{radio.selection.activeHashtags.map((h) => `#${h}`).join(' ')}</b>
            </>
          )}
          <span>Recent window</span>
          <b>{radio.selection.recentTrackWindow}</b>
          <span>Config version</span>
          <b>{radio.configurationVersion}</b>
          <span>Telegram</span>
          <b><Link to="/panel/telegram">{data.telegram.state}{data.telegram.accountLabel ? ` · ${data.telegram.accountLabel}` : ''}</Link></b>
        </div>
      </Card>

      <div className="stats">
        <Stat label="Total tracks" value={counts.totalTracks} />
        <Stat label="Playable" value={counts.playableTracks} tone="good" />
        <Stat label="With lyrics" value={counts.tracksWithLyrics} />
        <Stat label="Waiting for lyrics" value={counts.tracksWaitingForLyrics} tone={counts.tracksWaitingForLyrics ? 'warn' : undefined} />
        <Stat label="Failed tracks" value={counts.failedTracks} tone={counts.failedTracks ? 'bad' : undefined} />
        <Stat label="Failed lyrics" value={counts.failedLyrics} tone={counts.failedLyrics ? 'bad' : undefined} />
        <Stat label="Hashtags" value={counts.hashtags} />
      </div>

      <Card title="Recently played">
        <table>
          <thead><tr><th>Track</th><th>Started</th><th>Ended</th></tr></thead>
          <tbody>
            {data.recentlyPlayed.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/panel/tracks/${r.trackId}`}>{r.artist ? `${r.artist} – ` : ''}{r.title}</Link></td>
                <td>{timeAgo(r.startedAt)}</td>
                <td>{r.endReason ?? 'playing'}</td>
              </tr>
            ))}
            {data.recentlyPlayed.length === 0 && <tr><td colSpan={3} className="muted">Nothing played yet.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
