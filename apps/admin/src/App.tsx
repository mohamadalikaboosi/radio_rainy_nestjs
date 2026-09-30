import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { UNAUTHORIZED_EVENT, api, authStore } from './api';
import { ChannelProvider, useChannels } from './channel-context';
import { Icon } from './icons';
import { LiveProvider, useLive } from './live-context';
import { Audit } from './pages/Audit';
import { Channels } from './pages/Channels';
import { Dashboard } from './pages/Dashboard';
import { Hashtags } from './pages/Hashtags';
import { History } from './pages/History';
import { Language } from './pages/Language';
import { Live } from './pages/Live';
import { Login } from './pages/Login';
import { Player } from './pages/Player';
import { RadioConfig } from './pages/RadioConfig';
import { Reports } from './pages/Reports';
import { Rules } from './pages/Rules';
import { Settings } from './pages/Settings';
import { Telegram } from './pages/Telegram';
import { TrackDetail } from './pages/TrackDetail';
import { Tracks } from './pages/Tracks';

interface NavItem { to: string; label: string; icon: string; end?: boolean; sub?: boolean }
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'On air', items: [
    { to: '/panel', label: 'Live control', icon: 'live', end: true },
    { to: '/panel/dashboard', label: 'Overview', icon: 'dashboard' },
  ] },
  { group: 'Radio', items: [
    { to: '/panel/channels', label: 'Channels', icon: 'channels' },
    { to: '/panel/radio', label: 'Selection & hashtags', icon: 'radio' },
    { to: '/panel/rules', label: 'Rules', icon: 'rules' },
    { to: '/panel/history', label: 'History', icon: 'history' },
  ] },
  { group: 'Library', items: [
    { to: '/panel/tracks', label: 'Tracks', icon: 'tracks', end: true },
    { to: '/panel/tracks-enabled', label: 'Enabled', icon: 'tracks', sub: true },
    { to: '/panel/tracks-disabled', label: 'Disabled', icon: 'tracks', sub: true },
    { to: '/panel/hashtags', label: 'Hashtags', icon: 'hashtags' },
    { to: '/panel/lyrics/pending', label: 'Lyrics: pending', icon: 'lyrics', sub: true },
    { to: '/panel/lyrics/processing', label: 'Lyrics: processing', icon: 'lyrics', sub: true },
    { to: '/panel/lyrics/ready', label: 'Lyrics: ready', icon: 'lyrics', sub: true },
    { to: '/panel/lyrics/failed', label: 'Lyrics: failed', icon: 'lyrics', sub: true },
  ] },
  { group: 'Insights', items: [
    { to: '/panel/reports', label: 'Reports', icon: 'reports' },
    { to: '/panel/language', label: 'Language (fa/en)', icon: 'language' },
  ] },
  { group: 'System', items: [
    { to: '/panel/telegram', label: 'Telegram', icon: 'telegram' },
    { to: '/panel/settings', label: 'Settings', icon: 'settings' },
    { to: '/panel/audit', label: 'Audit log', icon: 'audit' },
  ] },
];

function ChannelPicker() {
  const { channels, selected, select } = useChannels();
  if (channels.length === 0) return <div className="muted picker">No channel yet</div>;
  return (
    <label className="picker">Working on
      <select value={selected?.id ?? ''} onChange={(e) => select(e.target.value)} aria-label="selected channel">
        {channels.map((c) => <option key={c.id} value={c.id}>{c.title}{c.started ? ' ●' : ''}</option>)}
      </select>
    </label>
  );
}

/** Global status strip: what is on air, how many people listen, is Telegram connected. */
function TopBar({ onSignOut }: { onSignOut: () => void }) {
  const { stations } = useLive();
  const [tg, setTg] = useState<string>('…');
  useEffect(() => {
    let alive = true;
    const load = (): void => void api<{ state: string }>('/admin/telegram/status').then((s) => alive && setTg(s.state)).catch(() => alive && setTg('?'));
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const onAir = stations.filter((s) => s.running && s.status === 'PLAYING').length;
  const listeners = stations.reduce((n, s) => n + s.listeners, 0);
  const problems = stations.filter((s) => s.started && (s.status === 'ERROR' || s.liveOnTelegram.status === 'ERROR')).length;
  return (
    <header className="topbar">
      <span className="chip"><span className={`dot ${onAir > 0 ? 'dot-good' : ''}`} />{onAir}/{stations.filter((s) => s.started).length} stations on air</span>
      <span className="chip">👥 {listeners} listening</span>
      <span className="chip"><span className={`dot ${tg === 'READY' ? 'dot-good' : tg === 'NOT_LOGGED_IN' || tg === 'NOT_CONFIGURED' ? 'dot-warn' : 'dot-bad'}`} />Telegram {tg.toLowerCase().replace(/_/g, ' ')}</span>
      {problems > 0 && <span className="chip"><span className="dot dot-bad" />✕ {problems} station{problems > 1 ? 's' : ''} with problems</span>}
      <span className="spacer" />
      <a className="chip" href="/" target="_blank" rel="noreferrer"><Icon name="external" /> Public player</a>
      <button className="btn btn-small" onClick={onSignOut}>Sign out</button>
    </header>
  );
}

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
  const signOut = (): void => { authStore.clear(); setAuthed(false); };
  return (
    <ChannelProvider>
      <LiveProvider>
        <div className="shell">
          <nav className="side" aria-label="Main">
            <div className="brand">🌧 radio_rainy</div>
            <ChannelPicker />
            {NAV.map((g) => (
              <div key={g.group}>
                <div className="group">{g.group}</div>
                {g.items.map((n) => <NavLink key={n.to} to={n.to} end={n.end} style={n.sub ? { paddingLeft: '1.9rem', fontSize: '.88rem' } : undefined}>{!n.sub && <Icon name={n.icon} />}{n.label}</NavLink>)}
              </div>
            ))}
          </nav>
          <div className="main-col">
            <TopBar onSignOut={signOut} />
            <div className="content">
              <Routes>
                <Route index element={<Live />} />
                <Route path="dashboard" element={<Dashboard />} />
                <Route path="channels" element={<Channels />} />
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
                <Route path="reports" element={<Reports />} />
                <Route path="language" element={<Language />} />
                <Route path="telegram" element={<Telegram />} />
                <Route path="settings" element={<Settings />} />
                <Route path="audit" element={<Audit />} />
                <Route path="*" element={<Navigate to="/panel" replace />} />
              </Routes>
            </div>
          </div>
        </div>
      </LiveProvider>
    </ChannelProvider>
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
