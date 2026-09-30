import { FormEvent, useState } from 'react';
import { api, authStore } from '../api';
import { errorMessage } from '../hooks';
import { useT } from '../i18n';
import { Badge, Card, ErrorBox } from '../ui';

/** Change the Super Admin password. `forced`: shown instead of the panel right after the first login with admin / admin. */
export function ChangePasswordForm({ forced = false, onDone }: { forced?: boolean; onDone?: () => void }) {
  const t = useT();
  const [current, setCurrent] = useState(forced ? 'admin' : '');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== again) return setError(t('account.mismatch'));
    setBusy(true);
    try {
      const r = await api<{ token: string }>('/admin/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      authStore.set(r.token); // the old token stops working the moment the password changes
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      {forced && <div className="alert alert-warn">{t('account.forced')}</div>}
      <label>
        {t('account.current')}
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label>
        {t('account.new')}
        <input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
      </label>
      <label>
        {t('account.again')}
        <input type="password" autoComplete="new-password" minLength={8} value={again} onChange={(e) => setAgain(e.target.value)} required />
      </label>
      <small className="muted">{t('account.rules')}</small>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn btn-primary" disabled={busy}>
          {t('account.change')}
        </button>
        {done && <Badge tone="good">{t('account.changed')}</Badge>}
      </div>
    </form>
  );
}

export function Account() {
  const t = useT();
  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('account.title')}</h1>
      </div>
      <Card title={t('account.changeTitle')}>
        <ChangePasswordForm />
      </Card>
      <Card title={t('account.forgotTitle')}>
        <p className="muted">{t('account.forgotHelp')}</p>
        <pre className="pre">pnpm --filter @radio_rainy/api reset-admin-password admin{'\n'}docker compose exec app node dist/scripts/reset-admin-password.js admin</pre>
      </Card>
    </div>
  );
}
