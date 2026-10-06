import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { PASSWORD_CHANGE_EVENT, UNAUTHORIZED_EVENT, api, authStore } from './api';
import { ChannelProvider, useChannels } from './channel-context';
import { Icon } from './icons';
import { LiveProvider, useLive } from './live-context';
import { I18nProvider, LanguageSwitcher, useT } from './i18n';
import { Account, ChangePasswordForm } from './pages/Account';
import { Accounts } from './pages/Accounts';
import { Ads } from './pages/Ads';
import { CampaignReview } from './pages/CampaignReview';
import { Platform } from './pages/Platform';
import { PortalApp } from './portal/PortalApp';
import { Audit } from './pages/Audit';
import { Engagement } from './pages/Engagement';
import { Sponsors } from './pages/Sponsors';
import { Channels } from './pages/Channels';
import { Dashboard } from './pages/Dashboard';
import { Hashtags } from './pages/Hashtags';
import { History } from './pages/History';
import { Language } from './pages/Language';
import { Live } from './pages/Live';
import { Login } from './pages/Login';
import { Player } from './pages/Player';
import { Landing } from './landing/Landing';
import { StationPage } from './player/StationPage';
import { RadioConfig } from './pages/RadioConfig';
import { Reports } from './pages/Reports';
import { Rules } from './pages/Rules';
import { Settings } from './pages/Settings';
import { Telegram } from './pages/Telegram';
import { TrackDetail } from './pages/TrackDetail';
import { Tracks } from './pages/Tracks';

interface NavItem { to: string; label: string; icon: string; end?: boolean; sub?: boolean }
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'nav.onAir', items: [
    { to: '/panel', label: 'nav.live', icon: 'live', end: true },
    { to: '/panel/dashboard', label: 'nav.overview', icon: 'dashboard' },
  ] },
  { group: 'nav.radio', items: [
    { to: '/panel/channels', label: 'nav.channels', icon: 'channels' },
    { to: '/panel/radio', label: 'nav.selection', icon: 'radio' },
    { to: '/panel/rules', label: 'nav.rules', icon: 'rules' },
    { to: '/panel/history', label: 'nav.history', icon: 'history' },
  ] },
  { group: 'nav.monetize', items: [
    { to: '/panel/engagement', label: 'nav.engagement', icon: 'radio' },
    { to: '/panel/ads', label: 'nav.ads', icon: 'live' },
    { to: '/panel/sponsors', label: 'nav.sponsors', icon: 'channels' },
  ] },
  { group: 'nav.business', items: [
    { to: '/panel/review', label: 'nav.review', icon: 'audit' },
    { to: '/panel/accounts', label: 'nav.accounts', icon: 'channels' },
    { to: '/panel/platform', label: 'nav.platform', icon: 'settings' },
  ] },
  { group: 'nav.library', items: [
    { to: '/panel/tracks', label: 'nav.tracks', icon: 'tracks', end: true },
    { to: '/panel/tracks-enabled', label: 'nav.enabled', icon: 'tracks', sub: true },
    { to: '/panel/tracks-disabled', label: 'nav.disabled', icon: 'tracks', sub: true },
    { to: '/panel/hashtags', label: 'nav.hashtags', icon: 'hashtags' },
    { to: '/panel/lyrics/pending', label: 'nav.lyricsPending', icon: 'lyrics', sub: true },
    { to: '/panel/lyrics/processing', label: 'nav.lyricsProcessing', icon: 'lyrics', sub: true },
    { to: '/panel/lyrics/ready', label: 'nav.lyricsReady', icon: 'lyrics', sub: true },
    { to: '/panel/lyrics/failed', label: 'nav.lyricsFailed', icon: 'lyrics', sub: true },
  ] },
  { group: 'nav.insights', items: [
    { to: '/panel/reports', label: 'nav.reports', icon: 'reports' },
    { to: '/panel/language', label: 'nav.language', icon: 'language' },
  ] },
  { group: 'nav.system', items: [
    { to: '/panel/telegram', label: 'nav.telegram', icon: 'telegram' },
    { to: '/panel/settings', label: 'nav.settings', icon: 'settings' },
    { to: '/panel/account', label: 'nav.account', icon: 'settings' },
    { to: '/panel/audit', label: 'nav.audit', icon: 'audit' },
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
  const t = useT();
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
      <span className="chip"><span className={`dot ${onAir > 0 ? 'dot-good' : ''}`} />{t('topbar.onAir', { on: onAir, total: stations.filter((s) => s.started).length })}</span>
      <span className="chip">👥 {t('topbar.listening', { n: listeners })}</span>
      <span className="chip"><span className={`dot ${tg === 'READY' ? 'dot-good' : tg === 'NOT_LOGGED_IN' || tg === 'NOT_CONFIGURED' ? 'dot-warn' : 'dot-bad'}`} />Telegram {tg.toLowerCase().replace(/_/g, ' ')}</span>
      {problems > 0 && <span className="chip"><span className="dot dot-bad" />✕ {problems} station{problems > 1 ? 's' : ''} with problems</span>}
      <span className="spacer" />
      <a className="chip" href="/listen" target="_blank" rel="noreferrer"><Icon name="external" /> {t('topbar.publicPlayer')}</a>
      <button className="btn btn-small" onClick={onSignOut}>{t('topbar.signOut')}</button>
    </header>
  );
}

function Panel() {
  const t = useT();
  const [authed, setAuthed] = useState<boolean>(() => authStore.get() !== null);
  useEffect(() => {
    const off = (): void => setAuthed(false);
    window.addEventListener(UNAUTHORIZED_EVENT, off);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, off);
  }, []);
  // The default admin / admin password must be replaced first: the server refuses everything else until then.
  const [mustChange, setMustChange] = useState(false);
  useEffect(() => {
    const on = (): void => setMustChange(true);
    window.addEventListener(PASSWORD_CHANGE_EVENT, on);
    return () => window.removeEventListener(PASSWORD_CHANGE_EVENT, on);
  }, []);
  useEffect(() => {
    if (authed) void api<{ mustChangePassword: boolean }>('/admin/auth/me').then((me) => setMustChange(me.mustChangePassword)).catch(() => undefined);
  }, [authed]);

  if (!authed) return <Login onLoggedIn={(must) => { setMustChange(must); setAuthed(true); }} />;
  if (mustChange) {
    return (
      <main className="login">
        <div className="card login-card">
          <h1>🌧 radio_rainy</h1>
          <h2>{t('account.changeTitle')}</h2>
          <ChangePasswordForm forced onDone={() => setMustChange(false)} />
        </div>
      </main>
    );
  }
  const signOut = (): void => { authStore.clear(); setAuthed(false); };
  return (
    <ChannelProvider>
      <LiveProvider>
        <div className="shell">
          <nav className="side" aria-label="Main">
            <div className="brand">🌧 radio_rainy</div>
            <div className="picker"><LanguageSwitcher /></div>
            <ChannelPicker />
            {NAV.map((g) => (
              <div key={g.group}>
                <div className="group">{t(g.group)}</div>
                {g.items.map((n) => <NavLink key={n.to} to={n.to} end={n.end} style={n.sub ? { paddingLeft: '1.9rem', fontSize: '.88rem' } : undefined}>{!n.sub && <Icon name={n.icon} />}{t(n.label)}</NavLink>)}
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
                <Route path="account" element={<Account />} />
                <Route path="engagement" element={<Engagement />} />
                <Route path="ads" element={<Ads />} />
                <Route path="sponsors" element={<Sponsors />} />
                <Route path="review" element={<CampaignReview />} />
                <Route path="accounts" element={<Accounts />} />
                <Route path="platform" element={<Platform />} />
                <Route path="*" element={<Navigate to="/panel" replace />} />
              </Routes>
            </div>
          </div>
        </div>
      </LiveProvider>
    </ChannelProvider>
  );
}

/** Older link of one station: /s/<slug> (still works). */
function StationBySlug() {
  const { slug } = useParams();
  return <Player key={slug} lockedSlug={slug ?? ''} />;
}

export function App() {
  return (
    <I18nProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/listen" element={<Player />} />
        <Route path="/s/:slug" element={<StationBySlug />} />
        <Route path="/panel/*" element={<Panel />} />
        <Route path="/partner/*" element={<PortalApp />} />
        <Route path="/:publicId" element={<StationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    </I18nProvider>
  );
}
