import { Link } from 'react-router-dom';
import { api } from '../api';
import { NeedChannel, radioPath, useChannels } from '../channel-context';
import { mmss, timeAgo } from '../format';
import { useAsync } from '../hooks';
import { ActionButton, Badge, Card, ErrorBox, Stat } from '../ui';

interface Counts { totalTracks: number; playableTracks: number; tracksWithLyrics: number; tracksWaitingForLyrics: number; failedTracks: number; failedLyrics: number; disabledTracks: number; hashtags: number }
interface Overview {
  stations: { id: string; slug: string; title: string; started: boolean; running: boolean; status: string; statusReason: string | null; listeners: number; liveOnTelegram: { enabled: boolean; status: string; error: string | null }; current: { title: string; artist: string | null } | null }[];
  counts: Counts;
  telegram: { state: string; accountLabel: string | null };
}
interface ChannelDashboard {
  channel: { id: string; title: string; slug: string };
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
  counts: Counts;
  recentlyPlayed: { id: string; trackId: string; title: string; artist: string | null; startedAt: string; endReason: string | null }[];
}

const MODE_LABEL: Record<string, string> = { GLOBAL_RANDOM: 'Global Random', HASHTAG_RANDOM: 'Hashtag Random', HASHTAG_ROTATION: 'Hashtag Rotation', CUSTOM_RULE: 'Custom Rules' };
const tone = (s: string) => (s === 'PLAYING' ? 'good' : s === 'ERROR' ? 'bad' : 'warn');
const liveTone = (s: string) => (s === 'LIVE' ? 'good' : s === 'ERROR' ? 'bad' : s === 'STARTING' ? 'warn' : 'neutral');

export function Dashboard() {
  const overview = useAsync(() => api<Overview>('/admin/dashboard'), [], 4000);
  const { select, reload } = useChannels();
  const o = overview.data;
  return (
    <div className="stack">
      <ErrorBox error={overview.error} />
      <Card title="Stations" actions={<Link to="/panel/channels">Manage channels →</Link>}>
        <table>
          <thead><tr><th>Station</th><th>Status</th><th>Now playing</th><th>Listeners</th><th>In Telegram</th><th /></tr></thead>
          <tbody>
            {(o?.stations ?? []).map((s) => (
              <tr key={s.id}>
                <td><a href="#select" onClick={(e) => { e.preventDefault(); select(s.id); }}>{s.title}</a> <small className="muted">/{s.slug}</small></td>
                <td>{s.started ? <Badge tone={tone(s.status)}>{s.status}</Badge> : <Badge>stopped</Badge>}</td>
                <td>{s.current ? `${s.current.artist ? `${s.current.artist} – ` : ''}${s.current.title}` : <span className="muted">{s.started ? (s.statusReason ?? '—') : '—'}</span>}</td>
                <td>{s.listeners}</td>
                <td>{s.liveOnTelegram.enabled ? <Badge tone={liveTone(s.liveOnTelegram.status)}>{s.liveOnTelegram.status}</Badge> : <span className="muted">off</span>}</td>
                <td>
                  <ActionButton className="btn-small" onAction={async () => { await api(`/admin/channels/${s.id}/${s.started ? 'stop' : 'start'}`, { method: 'POST' }); overview.reload(); reload(); }}>{s.started ? '■ Stop' : '▶ Start'}</ActionButton>
                </td>
              </tr>
            ))}
            {o && o.stations.length === 0 && <tr><td colSpan={6} className="muted">No channels yet. Log in to Telegram, then add a channel.</td></tr>}
          </tbody>
        </table>
        {o && <p className="muted">Telegram: <Link to="/panel/telegram">{o.telegram.state}{o.telegram.accountLabel ? ` · ${o.telegram.accountLabel}` : ''}</Link></p>}
      </Card>
      <NeedChannel>{(c) => <ChannelSection key={c.id} channelId={c.id} />}</NeedChannel>
    </div>
  );
}

function ChannelSection({ channelId }: { channelId: string }) {
  const { data, error, reload } = useAsync(() => api<ChannelDashboard>(radioPath(channelId, 'dashboard')), [channelId], 3000);
  if (!data) return <ErrorBox error={error} />;
  const { radio, counts } = data;
  const cur = radio.current;
  const pct = cur && cur.duration ? Math.min(100, (cur.position / cur.duration) * 100) : 0;

  return (
    <>
      <Card title={`Radio — ${data.channel.title}`} actions={<Badge tone={tone(radio.status)}>{radio.status}</Badge>}>
        <ErrorBox error={error} />
        {cur ? (
          <>
            <div className="now">
              <div className="now-title">{cur.artist ? `${cur.artist} – ` : ''}{cur.title}</div>
              <div className="progress" aria-label="playback position"><div style={{ width: `${pct}%` }} /></div>
              <div className="muted">{mmss(cur.position)} / {mmss(cur.duration)} · {radio.listeners} listener(s)</div>
            </div>
            <div className="row">
              <ActionButton onAction={async () => { await api(radioPath(channelId, 'skip'), { method: 'POST', body: { expectedSeq: radio.transitionSeq } }); reload(); }}>⏭ Skip current</ActionButton>
              <ActionButton onAction={async () => { await api(radioPath(channelId, 'play-next'), { method: 'POST', body: {} }); reload(); }}>▶ Play next</ActionButton>
            </div>
          </>
        ) : (
          <p className="muted">Nothing is playing{radio.statusReason ? ` — ${radio.statusReason}` : ''}.</p>
        )}
        {radio.next && <p className="muted">Next: {radio.next.artist ? `${radio.next.artist} – ` : ''}{radio.next.title}</p>}
        <hr />
        <div className="kv">
          <span>Selection</span><b>{MODE_LABEL[radio.selection.mode] ?? radio.selection.mode}</b>
          {radio.selection.activeHashtags.length > 0 && (<><span>Active hashtags ({radio.selection.matchMode})</span><b>{radio.selection.activeHashtags.map((h) => `#${h}`).join(' ')}</b></>)}
          <span>Recent window</span><b>{radio.selection.recentTrackWindow}</b>
          <span>Config version</span><b>{radio.configurationVersion}</b>
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
    </>
  );
}
