import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { mmss } from '../format';
import { useAsync } from '../hooks';

interface Current { status: string; trackId?: string; title?: string; artist?: string | null; duration?: number | null; position?: number }
interface Lyrics { trackId: string; status: string; lines?: { start: number; end: number; text: string }[]; plain?: string[] }
interface Active { index: number; text: string | null; status: string; trackId?: string }

/** Public listener page: stream + live synchronized lyrics. All state comes from the public API. */
export function Player() {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const current = useAsync(() => api<Current>('/radio/current'), [], 1000);
  const trackId = current.data?.trackId;
  const lyrics = useAsync(() => (trackId ? api<Lyrics>('/radio/current/lyrics') : Promise.resolve(null)), [trackId]);
  const active = useAsync(() => api<Active>('/radio/current/lyrics/active'), [], 500);
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active.data?.index]);

  const toggle = (): void => {
    const el = audio.current;
    if (!el) return;
    if (playing) {
      el.pause();
      el.removeAttribute('src'); // drop the buffer: resume joins the live edge instead of stale audio
      el.load();
      setPlaying(false);
    } else {
      el.src = `/radio/stream?ts=${Date.now()}`;
      void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  const c = current.data;
  const lines = lyrics.data?.lines;
  return (
    <main className="player">
      <h1>🌧 radio_rainy</h1>
      <button className="btn btn-primary btn-big" onClick={toggle} aria-pressed={playing}>{playing ? '⏸ Pause' : '▶ Listen live'}</button>
      <audio ref={audio} preload="none" />
      {c?.status === 'PLAYING' ? (
        <>
          <div className="now-title">{c.artist ? `${c.artist} – ` : ''}{c.title}</div>
          <div className="muted">{mmss(c.position)} / {mmss(c.duration)}</div>
        </>
      ) : (
        <p className="muted">The radio is {c?.status === 'IDLE' ? 'waiting for music' : c?.status?.toLowerCase() ?? 'loading'}…</p>
      )}
      <ul className="lyrics" aria-label="lyrics">
        {lines?.map((l, i) => (
          <li key={i} ref={active.data?.index === i ? activeRef : undefined} className={active.data?.index === i ? 'active' : ''}>{l.text}</li>
        ))}
        {lyrics.data?.status === 'PLAIN' && lyrics.data.plain?.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
      {lyrics.data && !lines && lyrics.data.status !== 'PLAIN' && <p className="muted">Lyrics: {lyrics.data.status.toLowerCase()}</p>}
    </main>
  );
}
