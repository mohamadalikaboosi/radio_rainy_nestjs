import { Link, useSearchParams } from 'react-router-dom';
import { HashtagStat, LyricsStatus, Paged, TrackItem, api } from '../api';
import { useChannels } from '../channel-context';
import { LYRICS_LABEL, mmss, timeAgo } from '../format';
import { useAsync } from '../hooks';
import { ActionButton, Badge, Card, ErrorBox, Pager } from '../ui';

export interface TracksPreset {
  title: string;
  enabled?: boolean;
  lyricsStatus?: LyricsStatus;
}

const lyricsTone = (s: LyricsStatus) => (s === 'LYRICS_READY' ? 'good' : s === 'LYRICS_FAILED' ? 'bad' : s === 'LYRICS_NONE' ? 'neutral' : 'warn');

export function Tracks({ preset }: { preset: TracksPreset }) {
  const [sp, setSp] = useSearchParams();
  const { channels, selected } = useChannels();
  const channelParam = sp.get('channel');
  // default: the channel picked in the top bar; ?channel=all shows every channel
  const channel = channelParam === 'all' ? '' : (channelParam ?? selected?.id ?? '');
  const f = {
    channel,
    q: sp.get('q') ?? '',
    artist: sp.get('artist') ?? '',
    album: sp.get('album') ?? '',
    hashtag: sp.get('hashtag') ?? '',
    lyricsStatus: preset.lyricsStatus ?? sp.get('lyricsStatus') ?? '',
    playback: sp.get('playback') ?? '',
    page: Number(sp.get('page') ?? 1),
    sort: sp.get('sort') ?? 'createdAt',
    order: sp.get('order') ?? 'desc',
  };
  const setFilter = (k: string, v: string): void => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setSp(next, { replace: true });
  };

  const list = useAsync(
    () => api<Paged<TrackItem>>('/admin/tracks', { query: { ...f, enabled: preset.enabled, pageSize: 25 } }),
    [sp.toString(), preset.enabled, preset.lyricsStatus, selected?.id],
  );
  const tags = useAsync(() => api<{ items: HashtagStat[] }>('/admin/hashtags'), []);

  return (
    <Card title={preset.title}>
      <div className="filters row wrap">
        <select value={channel || 'all'} onChange={(e) => setFilter('channel', e.target.value)} aria-label="channel filter">
          <option value="all">All channels</option>
          {channels.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <input placeholder="Search title / artist / album…" value={f.q} onChange={(e) => setFilter('q', e.target.value)} aria-label="search" />
        <input placeholder="Artist" value={f.artist} onChange={(e) => setFilter('artist', e.target.value)} aria-label="artist filter" />
        <input placeholder="Album" value={f.album} onChange={(e) => setFilter('album', e.target.value)} aria-label="album filter" />
        <select value={f.hashtag} onChange={(e) => setFilter('hashtag', e.target.value)} aria-label="hashtag filter">
          <option value="">All hashtags</option>
          {(tags.data?.items ?? []).map((h) => <option key={h.hashtagId} value={h.normalized}>#{h.value}</option>)}
        </select>
        {!preset.lyricsStatus && (
          <select value={f.lyricsStatus} onChange={(e) => setFilter('lyricsStatus', e.target.value)} aria-label="lyrics status filter">
            <option value="">Any lyrics status</option>
            {Object.entries(LYRICS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
        <select value={f.playback} onChange={(e) => setFilter('playback', e.target.value)} aria-label="playback filter">
          <option value="">Any playback state</option>
          <option value="PLAYABLE">Playable</option>
          <option value="DISABLED">Disabled</option>
          <option value="FAILED">Failed</option>
          <option value="UNAVAILABLE">Unavailable (deleted)</option>
        </select>
        <select value={`${f.sort}:${f.order}`} onChange={(e) => { const [s, o] = e.target.value.split(':'); const n = new URLSearchParams(sp); n.set('sort', s ?? 'createdAt'); n.set('order', o ?? 'desc'); setSp(n, { replace: true }); }} aria-label="sort">
          <option value="createdAt:desc">Newest</option>
          <option value="title:asc">Title A–Z</option>
          <option value="artist:asc">Artist A–Z</option>
          <option value="lastPlayedAt:desc">Recently played</option>
          <option value="playCount:desc">Most played</option>
        </select>
      </div>
      <ErrorBox error={list.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Track</th><th>Artist</th><th>Album</th><th>Hashtags</th><th>Duration</th><th>Lyrics</th><th>Enabled</th><th>Last played</th><th>Actions</th></tr></thead>
          <tbody>
            {(list.data?.items ?? []).map((t) => (
              <tr key={t.id} className={t.status !== 'READY' ? 'row-dim' : ''}>
                <td><Link to={`/panel/tracks/${t.id}`}>{t.title}</Link>{t.status !== 'READY' && <> <Badge tone="bad">{t.status}</Badge></>}</td>
                <td>{t.artist ?? '—'}</td>
                <td>{t.album ?? '—'}</td>
                <td>{t.hashtags.map((h) => `#${h}`).join(' ')}</td>
                <td>{mmss(t.duration)}</td>
                <td><Badge tone={lyricsTone(t.lyricsStatus)}>{LYRICS_LABEL[t.lyricsStatus]}</Badge></td>
                <td>
                  <input type="checkbox" checked={t.enabled} aria-label={`enabled ${t.title}`} onChange={(e) => void api(`/admin/tracks/${t.id}/enabled`, { method: 'PATCH', body: { enabled: e.target.checked } }).then(list.reload)} />
                </td>
                <td>{timeAgo(t.lastPlayedAt)}</td>
                <td className="row">
                  {t.lyricsUrl && <ActionButton className="btn-small" onAction={async () => { await api(`/admin/tracks/${t.id}/process-lyrics`, { method: 'POST', body: {} }); list.reload(); }}>Lyrics</ActionButton>}
                  <ActionButton className="btn-small" onAction={async () => { await api(`/admin/channels/${t.channelId}/radio/play-next`, { method: 'POST', body: { trackId: t.id } }); }} disabled={!t.enabled || t.status !== 'READY'}>▶ Play</ActionButton>
                </td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && <tr><td colSpan={9} className="muted">No tracks match.</td></tr>}
          </tbody>
        </table>
      </div>
      {list.data && <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setFilter('page', String(p))} />}
    </Card>
  );
}
