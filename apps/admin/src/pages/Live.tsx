import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LiveStation, Paged, PreviewResult, TrackItem, api } from '../api';
import { Icon } from '../icons';
import { mmss, timeAgo } from '../format';
import { errorMessage } from '../hooks';
import { useLive } from '../live-context';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';

const statusTone = (s: LiveStation['status']) => (s === 'PLAYING' ? 'good' : s === 'ERROR' ? 'bad' : 'warn');
const liveTone = (s: string) => (s === 'LIVE' ? 'good' : s === 'ERROR' ? 'bad' : s === 'STARTING' ? 'warn' : 'neutral');

/** Search playable tracks of one station and either play one now (cuts the current) or queue it after the current one. */
export function TrackPicker({ channelId, mode, onDone }: { channelId: string; mode: 'play' | 'queue'; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<TrackItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api<Paged<TrackItem>>('/admin/tracks', { query: { channel: channelId, q, playback: 'PLAYABLE', pageSize: 8, sort: 'title', order: 'asc' } })
        .then((r) => !cancelled && setRows(r.items))
        .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, channelId]);
  const send = (t: TrackItem) => async (): Promise<void> => {
    await api(`/admin/channels/${channelId}/radio/${mode === 'play' ? 'play-next' : 'queue-next'}`, { method: 'POST', body: { trackId: t.id } });
    onDone();
  };
  return (
    <div className="picker-pop">
      <input autoFocus placeholder={mode === 'play' ? 'Search a track to play NOW…' : 'Search a track to play after this one…'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="search tracks" />
      <ErrorBox error={error} />
      <ul>
        {rows.map((t) => (
          <li key={t.id}>
            <span>{t.artist ? `${t.artist} – ` : ''}{t.title} <small className="muted">{mmss(t.duration)}</small></span>
            <ActionButton className="btn-small" onAction={send(t)}>{mode === 'play' ? '▶ Play now' : '+ Queue next'}</ActionButton>
          </li>
        ))}
        {rows.length === 0 && <li className="muted">No playable track found.</li>}
      </ul>
    </div>
  );
}

function Monitor({ url }: { url: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const toggle = (): void => {
    const el = audio.current;
    if (!el) return;
    if (on) {
      el.pause();
      el.removeAttribute('src');
      el.load();
      setOn(false);
    } else {
      el.src = `${url}?ts=${Date.now()}`;
      void el.play().then(() => setOn(true)).catch(() => setOn(false));
    }
  };
  return (
    <>
      <button className="btn btn-small" onClick={toggle} aria-pressed={on}>{on ? '⏸ Stop listening' : '🎧 Listen here'}</button>
      <audio ref={audio} preload="none" />
    </>
  );
}

function StationCard({ s, refresh }: { s: LiveStation; refresh: () => void }) {
  const [picker, setPicker] = useState<'play' | 'queue' | null>(null);
  const [skipping, setSkipping] = useState<number | null>(null);
  const [peek, setPeek] = useState<PreviewResult | null>(null);
  const np = s.nowPlaying;
  const pct = np && np.duration ? Math.min(100, (np.position / np.duration) * 100) : 0;
  useEffect(() => { if (skipping !== null && s.transitionSeq !== skipping) setSkipping(null); }, [s.transitionSeq, skipping]);

  const next = async (): Promise<void> => {
    setSkipping(s.transitionSeq);
    try {
      await api(`/admin/channels/${s.id}/radio/skip`, { method: 'POST', body: { expectedSeq: s.transitionSeq } });
      refresh();
    } catch (e) {
      setSkipping(null);
      throw e;
    }
  };

  return (
    <Card>
      <div className="station">
        <div className="station-head">
          <div><b>{s.title}</b> <small className="muted">/{s.slug}</small></div>
          <div className="row wrap">
            {s.started ? <Badge tone={statusTone(s.status)}>{s.running ? s.status : 'starting…'}</Badge> : <Badge>stopped</Badge>}
            <span className="chip"><span className={`dot ${s.listeners > 0 ? 'dot-good' : ''}`} />{s.listeners} listening</span>
            {s.liveOnTelegram.enabled && <span className="chip"><span className={`dot ${s.liveOnTelegram.status === 'LIVE' ? 'dot-live' : s.liveOnTelegram.status === 'ERROR' ? 'dot-bad' : 'dot-warn'}`} />Telegram {s.liveOnTelegram.status}</span>}
          </div>
        </div>

        {!s.started && (
          <div className="row">
            <span className="muted">This station is not on air.</span>
            <ActionButton className="btn-primary" onAction={async () => { await api(`/admin/channels/${s.id}/start`, { method: 'POST' }); refresh(); }}>▶ Start station</ActionButton>
          </div>
        )}

        {s.started && np && (
          <>
            <div>
              <div className="np-title">{np.title}</div>
              <div className="np-sub">{[np.artist, np.album].filter(Boolean).join(' · ') || ' '}</div>
            </div>
            <div>
              <div className="progress" aria-label="playback position"><div style={{ width: `${pct}%` }} /></div>
              <div className="row" style={{ justifyContent: 'space-between' }}><small className="muted">{mmss(np.position)}</small><small className="muted">{mmss(np.duration)}</small></div>
            </div>
            <div className="np-line" dir="auto" aria-live="polite">{np.activeLine ?? (np.lyricsStatus === 'LYRICS_READY' ? '♪' : '')}</div>
          </>
        )}
        {s.started && !np && <p className="muted">Nothing is playing{s.statusReason ? ` — ${s.statusReason}` : ''}.</p>}

        {s.started && (
          <div className="row wrap">
            <ActionButton className="btn-primary btn-xl" onAction={next} disabled={!np || skipping !== null}>{skipping !== null ? 'Skipping…' : <><Icon name="next" /> Next</>}</ActionButton>
            <button className="btn" onClick={() => setPicker(picker === 'play' ? null : 'play')}><Icon name="play" /> Play a track…</button>
            <button className="btn" onClick={() => setPicker(picker === 'queue' ? null : 'queue')}><Icon name="queue" /> Queue next…</button>
            <Monitor url={s.streamUrl} />
            <ActionButton className="btn-small btn-danger" confirm={`Stop "${s.title}"? Listeners will be disconnected.`} onAction={async () => { await api(`/admin/channels/${s.id}/stop`, { method: 'POST' }); refresh(); }}>■ Stop</ActionButton>
          </div>
        )}
        {picker && <TrackPicker channelId={s.id} mode={picker} onDone={() => { setPicker(null); refresh(); }} />}

        {s.started && (
          <div>
            <b>Up next</b>{' '}
            {s.upNext ? <span>{s.upNext.artist ? `${s.upNext.artist} – ` : ''}{s.upNext.title}</span> : <span className="muted">picked automatically near the end of the track</span>}{' '}
            <ActionButton className="btn-small" onAction={async () => setPeek(await api<PreviewResult>(`/admin/channels/${s.id}/radio/preview`, { method: 'POST', body: { limit: 3 } }))}>Peek likely next</ActionButton>
            {peek && <ol className="mini-list" aria-label="likely next tracks">{peek.tracks.map((t, i) => <li key={`${t.id}-${i}`}><span>{t.artist ? `${t.artist} – ` : ''}{t.title}</span><small className="muted">preview</small></li>)}</ol>}
          </div>
        )}

        {s.recent.length > 0 && (
          <details>
            <summary className="muted">Recently played</summary>
            <ul className="mini-list">{s.recent.map((r, i) => <li key={`${r.trackId}-${i}`}><span>{r.artist ? `${r.artist} – ` : ''}{r.title}</span><small className="muted">{timeAgo(r.startedAt)}{r.endReason && r.endReason !== 'FINISHED' ? ` · ${r.endReason.toLowerCase()}` : ''}</small></li>)}</ul>
          </details>
        )}
        {s.liveOnTelegram.error && <div className="inline-error" role="alert">Telegram live: {s.liveOnTelegram.error}</div>}
        <div className="row wrap"><Link to={`/panel/radio`}>Radio config →</Link><Link to="/panel/reports">Reports →</Link></div>
      </div>
    </Card>
  );
}

export function Live() {
  const { stations, error, loading, refresh } = useLive();
  return (
    <div className="stack">
      <div className="page-head"><h1>Live control</h1><span className="muted">Updates every second</span></div>
      <ErrorBox error={error} />
      <div className="stations">
        {stations.map((s) => <StationCard key={s.id} s={s} refresh={refresh} />)}
      </div>
      {!loading && stations.length === 0 && <Card><p className="muted">No channels yet. Log in to Telegram, then <Link to="/panel/channels">add a channel</Link>.</p></Card>}
    </div>
  );
}
