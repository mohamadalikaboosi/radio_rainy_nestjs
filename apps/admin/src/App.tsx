import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { UNAUTHORIZED_EVENT, api, authStore } from './api';
import { Audit } from './pages/Audit';
import { Dashboard } from './pages/Dashboard';
import { Hashtags } from './pages/Hashtags';
import { History } from './pages/History';
import { Login } from './pages/Login';
import { Player } from './pages/Player';
import { RadioConfig } from './pages/RadioConfig';
import { Rules } from './pages/Rules';
import { Telegram } from './pages/Telegram';
import { TrackDetail } from './pages/TrackDetail';
import { Tracks } from './pages/Tracks';

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: '/panel', label: 'Dashboard', end: true },
  { to: '/panel/radio', label: 'Radio config' },
  { to: '/panel/rules', label: 'Rules' },
  { to: '/panel/history', label: 'History' },
  { to: '/panel/tracks', label: 'Tracks', end: true },
  { to: '/panel/tracks-enabled', label: '· Enabled' },
  { to: '/panel/tracks-disabled', label: '· Disabled' },
  { to: '/panel/hashtags', label: 'Hashtags' },
  { to: '/panel/lyrics/pending', label: 'Lyrics: Pending' },
  { to: '/panel/lyrics/processing', label: 'Lyrics: Processing' },
  { to: '/panel/lyrics/ready', label: 'Lyrics: Ready' },
  { to: '/panel/lyrics/failed', label: 'Lyrics: Failed' },
  { to: '/panel/telegram', label: 'Telegram' },
  { to: '/panel/audit', label: 'Audit log' },
];

function Panel() {
  const [authed, setAuthed] = useState<boolean>(() => authStore.get() !== null);
  useEffect(() => {
    const off = (): void => setAuthed(false);
    window.addEventListener(UNAUTHORIZED_EVENT, off);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, off);
  }, []);
  // The token is only a convenience for the UI: the backend enforces SUPER_ADMIN on every request.
  useEffect(() => {
    if (authed) void api('/admin/auth/me').catch(() => undefined);
  }, [authed]);

  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand">🌧 radio_rainy</div>
        {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end}>{n.label}</NavLink>)}
        <a href="/" target="_blank" rel="noreferrer">Open player ↗</a>
        <button className="btn btn-small" onClick={() => { authStore.clear(); setAuthed(false); }}>Sign out</button>
      </nav>
      <div className="content">
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="radio" element={<RadioConfig />} />
          <Route path="rules" element={<Rules />} />
          <Route path="history" element={<History />} />
          <Route path="tracks" element={<Tracks preset={{ title: 'All tracks' }} />} />
          <Route path="tracks-enabled" element={<Tracks preset={{ title: 'Enabled tracks', enabled: true }} />} />
          <Route path="tracks-disabled" element={<Tracks preset={{ title: 'Disabled tracks', enabled: false }} />} />
          <Route path="tracks/:id" element={<TrackDetail />} />
          <Route path="hashtags" element={<Hashtags />} />
          <Route path="lyrics/pending" element={<Tracks preset={{ title: 'Lyrics pending', lyricsStatus: 'LYRICS_PENDING' }} />} />
          <Route path="lyrics/processing" element={<Tracks preset={{ title: 'Lyrics processing', lyricsStatus: 'LYRICS_PROCESSING' }} />} />
          <Route path="lyrics/ready" element={<Tracks preset={{ title: 'Lyrics ready', lyricsStatus: 'LYRICS_READY' }} />} />
          <Route path="lyrics/failed" element={<Tracks preset={{ title: 'Lyrics failed', lyricsStatus: 'LYRICS_FAILED' }} />} />
          <Route path="telegram" element={<Telegram />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/panel" replace />} />
        </Routes>
      </div>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Player />} />
        <Route path="/panel/*" element={<Panel />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
