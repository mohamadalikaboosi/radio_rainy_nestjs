import { FormEvent, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { PORTAL_UNAUTHORIZED_EVENT, PortalMe, PublicPlatform, api, portalStore } from '../api';
import { errorMessage, useAsync } from '../hooks';
import { LanguageSwitcher, useT } from '../i18n';
import { ErrorBox } from '../ui';
import { PortalBilling } from './PortalBilling';
import { PortalCampaigns } from './PortalCampaigns';
import { PortalStations } from './PortalStations';
import './portal.css';

/** What does this platform charge? Everything is free until the operator switches billing on. */
export function PlanNote({ platform }: { platform: PublicPlatform | undefined }) {
  const t = useT();
  if (!platform) return null;
  return platform.billingEnabled ? (
    <div className="alert alert-warn">{t('portal.paidNote', { play: platform.pricePerPlayCents, click: platform.pricePerClickCents, currency: platform.currency })}</div>
  ) : (
    <div className="alert alert-good">{t('portal.freeNote')}</div>
  );
}

function PortalLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const t = useT();
  const cfg = useAsync(() => api<PublicPlatform>('/portal/auth/config'), []);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ accountName: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSignup = cfg.data?.selfSignupEnabled ?? true;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'login' ? await api<{ token: string }>('/portal/auth/login', { method: 'POST', body: { email: form.email, password: form.password } }) : await api<{ token: string }>('/portal/auth/signup', { method: 'POST', body: form });
      portalStore.set(r.token);
      onLoggedIn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card login-card" onSubmit={(e) => void submit(e)}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>🌧 {t('portal.title')}</h1>
          <LanguageSwitcher />
        </div>
        <p className="muted">{t('portal.tagline')}</p>
        <PlanNote platform={cfg.data ?? undefined} />
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-pressed={mode === 'login'} onClick={() => setMode('login')}>
            {t('portal.signIn')}
          </button>
          {canSignup && (
            <button type="button" role="tab" aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>
              {t('portal.signUp')}
            </button>
          )}
        </div>
        {mode === 'signup' && (
          <label>
            {t('portal.accountName')}
            <input value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} required minLength={2} maxLength={80} />
          </label>
        )}
        <label>
          {t('portal.email')}
          <input type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </label>
        <label>
          {t('portal.password')}
          <input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'signup' ? 8 : 1} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </label>
        <ErrorBox error={error} />
        <button className="btn btn-primary" disabled={busy}>
          {mode === 'login' ? t('portal.signIn') : t('portal.createAccount')}
        </button>
        <a className="muted" href="/listen">
          ← {t('portal.backToRadio')}
        </a>
      </form>
    </main>
  );
}

/** Customer portal: advertisers run campaigns, station owners manage their station. Separate session from the Super Admin panel. */
export function PortalApp() {
  const t = useT();
  const [authed, setAuthed] = useState<boolean>(() => portalStore.get() !== null);
  useEffect(() => {
    const off = (): void => setAuthed(false);
    window.addEventListener(PORTAL_UNAUTHORIZED_EVENT, off);
    return () => window.removeEventListener(PORTAL_UNAUTHORIZED_EVENT, off);
  }, []);
  const me = useAsync(() => (authed ? api<PortalMe>('/portal/me', { auth: 'portal' }) : Promise.resolve(null)), [authed]);

  if (!authed) return <PortalLogin onLoggedIn={() => setAuthed(true)} />;
  return (
    <div className="shell">
      <nav className="side" aria-label="Portal">
        <div className="brand">🌧 {t('portal.title')}</div>
        <div className="picker">
          <LanguageSwitcher />
        </div>
        <NavLink to="/partner" end>
          {t('portal.nav.campaigns')}
        </NavLink>
        <NavLink to="/partner/billing">{t('portal.nav.billing')}</NavLink>
        <NavLink to="/partner/stations">{t('portal.nav.stations')}</NavLink>
      </nav>
      <div className="main-col">
        <header className="topbar">
          <span className="chip">{me.data?.account.name ?? '…'}</span>
          <span className="muted">{me.data?.email}</span>
          <span className="spacer" />
          <a className="chip" href="/listen">
            {t('portal.backToRadio')}
          </a>
          <button
            className="btn btn-small"
            onClick={() => {
              portalStore.clear();
              setAuthed(false);
            }}
          >
            {t('topbar.signOut')}
          </button>
        </header>
        <div className="content">
          <PlanNote platform={me.data?.platform} />
          <Routes>
            <Route index element={<PortalCampaigns me={me.data} />} />
            <Route path="billing" element={<PortalBilling />} />
            <Route path="stations" element={<PortalStations />} />
            <Route path="*" element={<Navigate to="/partner" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
