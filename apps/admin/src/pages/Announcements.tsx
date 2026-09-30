import { FormEvent, useState } from 'react';
import { api } from '../api';
import { timeAgo } from '../format';
import { errorMessage, useAsync } from '../hooks';
import { useT } from '../i18n';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';

interface Msg {
  id: string;
  text: string;
  level: 'INFO' | 'WARN';
  createdAt: string;
  expiresAt: string;
  createdBy: string;
}

/** Live announcements: they appear on every listener's screen at once (WebSocket) until they expire or are removed. */
export function Announcements({ stationId, prefix, auth }: { stationId: string; prefix: '/admin/channels' | '/portal/stations'; auth: 'admin' | 'portal' }) {
  const t = useT();
  const list = useAsync(() => api<Msg[]>(`${prefix}/${stationId}/messages`, { auth }), [stationId, prefix], 10_000);
  const [text, setText] = useState('');
  const [level, setLevel] = useState<'INFO' | 'WARN'>('INFO');
  const [minutes, setMinutes] = useState(10);
  const [error, setError] = useState<string | null>(null);

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await api(`${prefix}/${stationId}/messages`, { auth, method: 'POST', body: { text, level, minutes } });
      setText('');
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card title={t('announce.title')}>
      <p className="muted">{t('announce.help')}</p>
      <form className="row wrap" onSubmit={(e) => void send(e)}>
        <label className="grow">
          {t('announce.text')}
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} required />
        </label>
        <label>
          {t('announce.level')}
          <select value={level} onChange={(e) => setLevel(e.target.value as 'INFO' | 'WARN')}>
            <option value="INFO">{t('announce.info')}</option>
            <option value="WARN">{t('announce.warn')}</option>
          </select>
        </label>
        <label>
          {t('announce.minutes')}
          <input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(Math.min(1440, Math.max(1, Math.round(Number(e.target.value) || 1))))} />
        </label>
        <button className="btn btn-primary" disabled={!text.trim()}>
          {t('announce.send')}
        </button>
      </form>
      <ErrorBox error={error ?? list.error} />
      <ul className="mini-list">
        {(list.data ?? []).map((m) => (
          <li key={m.id}>
            <span>
              <Badge tone={m.level === 'WARN' ? 'warn' : 'info'}>{m.level === 'WARN' ? t('announce.warn') : t('announce.info')}</Badge> {m.text}{' '}
              <small className="muted">
                {timeAgo(m.createdAt)} · {m.createdBy}
              </small>
            </span>
            <ActionButton className="btn-small btn-danger" onAction={async () => { await api(`${prefix}/${stationId}/messages/${m.id}`, { auth, method: 'DELETE' }); list.reload(); }}>
              {t('common.delete')}
            </ActionButton>
          </li>
        ))}
        {list.data?.length === 0 && <li className="muted">{t('announce.none')}</li>}
      </ul>
    </Card>
  );
}
