import { DirectLink } from '../player/DirectLink';
import { FormEvent, useState } from 'react';
import { ChannelItem, api } from '../api';
import { useChannels } from '../channel-context';
import { errorMessage } from '../hooks';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';
import { LiveTarget } from './LiveTarget';
import { OwnerPicker } from './OwnerPicker';

const liveTone = (s: ChannelItem['liveStatus']) => (s === 'LIVE' ? 'good' : s === 'ERROR' ? 'bad' : s === 'STARTING' ? 'warn' : 'neutral');

export function Channels() {
  const { channels, reload, select, selected } = useChannels();
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api<ChannelItem>('/admin/channels', { method: 'POST', body: { reference } });
      setReference('');
      select(c.id);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const act = (path: string, method: 'POST' | 'PUT' | 'DELETE' = 'POST', body?: unknown) => async (): Promise<void> => {
    await api(path, { method, body });
    reload();
  };

  return (
    <div className="stack">
      <Card title="Add a channel">
        <p className="muted">
          Each channel is its own radio station with its own tracks, hashtags, rules, stream and (optionally) live stream inside Telegram.
          You must be logged in to Telegram (Telegram page) first.
        </p>
        <form className="row wrap" onSubmit={(e) => void add(e)}>
          <label>Channel (@username, t.me link or id)
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="@my_music_channel" required />
          </label>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add channel'}</button>
        </form>
        <ErrorBox error={error} />
      </Card>

      <Card title="Channels / stations">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Channel</th><th>Public stream</th><th>Station</th><th>Live in Telegram</th><th>Actions</th></tr></thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id} className={selected?.id === c.id ? 'row-selected' : ''}>
                  <td><b>{c.title}</b><br /><small className="muted">{c.reference}</small></td>
                  <td><code>/radio/{c.slug}/stream</code><DirectLink slug={c.slug} /></td>
                  <td>{c.started ? <Badge tone="good">started</Badge> : <Badge>stopped</Badge>}</td>
                  <td>
                    <label className="radio-line">
                      <input type="checkbox" checked={c.telegramLiveEnabled} aria-label={`live in Telegram for ${c.title}`} onChange={(e) => void api(`/admin/channels/${c.id}/live`, { method: 'PUT', body: { enabled: e.target.checked } }).then(reload)} />
                      stream inside Telegram
                    </label>
                    {c.telegramLiveEnabled && <Badge tone={liveTone(c.liveStatus)}>{c.liveStatus}</Badge>}
                    {c.liveError && <div className="inline-error" role="alert">{c.liveError}</div>}
                    <LiveTarget channel={c} onChanged={reload} />
                    <OwnerPicker channel={c} onChanged={reload} />
                  </td>
                  <td className="row wrap">
                    <ActionButton className={c.started ? 'btn-danger' : 'btn-primary'} onAction={act(`/admin/channels/${c.id}/${c.started ? 'stop' : 'start'}`)}>{c.started ? '■ Stop' : '▶ Start'}</ActionButton>
                    <ActionButton className="btn-small" onAction={act(`/admin/channels/${c.id}/sync`, 'POST', { full: false })}>Sync</ActionButton>
                    <ActionButton className="btn-small" onAction={act(`/admin/channels/${c.id}/sync`, 'POST', { full: true })}>Full sync</ActionButton>
                    <button className="btn btn-small" onClick={() => select(c.id)} disabled={selected?.id === c.id}>{selected?.id === c.id ? 'Selected' : 'Select'}</button>
                    <ActionButton className="btn-small btn-danger" confirm={`Remove "${c.title}" from radio_rainy? (Its Telegram channel is not touched.)`} onAction={act(`/admin/channels/${c.id}`, 'DELETE')}>Remove</ActionButton>
                    <ActionButton className="btn-small btn-danger" confirm={`Remove "${c.title}" AND delete all its tracks, lyrics and history from the database?`} onAction={async () => { await api(`/admin/channels/${c.id}?deleteTracks=true`, { method: 'DELETE' }); reload(); }}>Remove + delete tracks</ActionButton>
                  </td>
                </tr>
              ))}
              {channels.length === 0 && <tr><td colSpan={5} className="muted">No channels yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted">
          “Stream inside Telegram” publishes the same radio audio to the channel’s live stream (voice chat) via RTMP, so the music also plays in Telegram.
          The logged-in account must be an admin of the channel with the <b>Manage Live Streams</b> right, and ffmpeg must be installed on the server.
        </p>
      </Card>
    </div>
  );
}
