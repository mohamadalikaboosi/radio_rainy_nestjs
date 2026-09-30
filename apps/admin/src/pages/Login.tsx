import { FormEvent, useState } from 'react';
import { api, authStore } from '../api';
import { errorMessage } from '../hooks';
import { ErrorBox } from '../ui';

export function Login({ onLoggedIn }: { onLoggedIn: (mustChangePassword: boolean) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; mustChangePassword?: boolean }>('/admin/auth/login', { method: 'POST', body: { username, password } });
      authStore.set(r.token);
      onLoggedIn(r.mustChangePassword === true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card login-card" onSubmit={(e) => void submit(e)}>
        <h1>🌧 radio_rainy</h1>
        <p className="muted">Super Admin</p>
        <label>
          Username
          <input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <ErrorBox error={error} />
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
