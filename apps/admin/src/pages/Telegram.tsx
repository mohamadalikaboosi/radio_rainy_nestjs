import { FormEvent, useState } from 'react';
import { TelegramStatus, api } from '../api';
import { errorMessage, useAsync } from '../hooks';
import { Link } from 'react-router-dom';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';

const tone = (s: TelegramStatus['state']) => (s === 'READY' ? 'good' : s === 'ERROR' || s === 'DISCONNECTED' ? 'bad' : 'warn');

export function Telegram() {
  const status = useAsync(() => api<TelegramStatus>('/admin/telegram/status'), [], 4000);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = status.data;

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      status.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (fn: () => Promise<unknown>) => (e: FormEvent): void => {
    e.preventDefault();
    void run(fn);
  };

  return (
    <div className="stack">
      <Card title="Telegram account" actions={s && <Badge tone={tone(s.state)}>{s.state}</Badge>}>
        <ErrorBox error={status.error} />
        {s?.accountLabel && <p>Logged in as <b>{s.accountLabel}</b></p>}
        {s?.error && <p className="alert alert-warn">{s.error}</p>}
        <p className="muted">The session is stored <b>encrypted</b> in the database. Your phone number, code and 2FA password are sent straight to Telegram and never stored or logged. After logging in, add channels on the <Link to="/panel/channels">Channels</Link> page.</p>

        {s?.state === 'NOT_CONFIGURED' && (
          <div className="alert alert-warn">Telegram API ID / hash are not set yet. Enter them on the <Link to="/panel/settings">Settings</Link> page first.</div>
        )}
        {(s?.state === 'NOT_LOGGED_IN' || s?.state === 'DISCONNECTED' || s?.state === 'ERROR') && (
          <form className="row wrap" onSubmit={submit(() => api('/admin/telegram/login/start', { method: 'POST', body: { phone } }))}>
            <label>Phone (international format) <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+989123456789" inputMode="tel" required /></label>
            <button className="btn btn-primary" disabled={busy}>Send login code</button>
          </form>
        )}
        {s?.state === 'AWAITING_CODE' && (
          <form className="row wrap" onSubmit={submit(async () => { await api('/admin/telegram/login/code', { method: 'POST', body: { code } }); setCode(''); })}>
            <label>Code from Telegram <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required /></label>
            <button className="btn btn-primary" disabled={busy}>Verify</button>
            <ActionButton onAction={async () => { await api('/admin/telegram/login/cancel', { method: 'POST' }); status.reload(); }}>Cancel</ActionButton>
          </form>
        )}
        {s?.state === 'AWAITING_PASSWORD' && (
          <form className="row wrap" onSubmit={submit(async () => { await api('/admin/telegram/login/password', { method: 'POST', body: { password } }); setPassword(''); })}>
            <label>Two-step verification password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required /></label>
            <button className="btn btn-primary" disabled={busy}>Sign in</button>
          </form>
        )}
        <ErrorBox error={error} />
        {s?.state === 'READY' && (
          <div className="row">
            <ActionButton onAction={async () => { await api('/admin/sync', { method: 'POST', body: { full: false } }); }}>Sync all channels</ActionButton>
            <ActionButton onAction={async () => { await api('/admin/sync', { method: 'POST', body: { full: true } }); }}>Full re-sync (all)</ActionButton>
            <ActionButton className="btn-danger" confirm="Log out of Telegram and delete the stored session?" onAction={async () => { await api('/admin/telegram/logout', { method: 'POST' }); status.reload(); }}>Log out</ActionButton>
          </div>
        )}
      </Card>
    </div>
  );
}
