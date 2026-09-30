import { FormEvent, useState } from 'react';
import { ChannelItem, api } from '../api';
import { errorMessage } from '../hooks';
import { useT } from '../i18n';

/**
 * Manual Telegram live target: the "Server URL" and "Stream key" of Telegram's "Stream with..." screen (works like OBS).
 * The key is write-only: the server never sends it back.
 */
export function LiveTarget({ channel, onChanged }: { channel: ChannelItem; onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/channels/${channel.id}/live-target`, { method: 'PUT', body: { url, ...(key ? { key } : {}) } });
      setUrl('');
      setKey('');
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const clear = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/channels/${channel.id}/live-target`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="live-target">
      <small className="muted">
        {channel.liveRtmpUrl ? (
          <>
            {t('liveTarget.manual')}: <code>{channel.liveRtmpUrl}</code> ({t('liveTarget.keySaved')})
          </>
        ) : (
          t('liveTarget.auto')
        )}
      </small>{' '}
      <button type="button" className="btn btn-small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {channel.liveRtmpUrl ? t('liveTarget.change') : t('liveTarget.useLink')}
      </button>
      {channel.liveRtmpUrl && (
        <button type="button" className="btn btn-small btn-danger" onClick={() => void clear()} disabled={busy}>
          {t('liveTarget.clear')}
        </button>
      )}
      {open && (
        <form className="picker-pop" onSubmit={(e) => void save(e)}>
          <p className="muted">{t('liveTarget.help')}</p>
          <label>
            {t('liveTarget.url')}
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="rtmps://dc4-1.rtmp.t.me/s/" required autoComplete="off" />
          </label>
          <label>
            {t('liveTarget.key')}
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('liveTarget.keyOptional')} autoComplete="off" />
          </label>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="row">
            <button className="btn btn-primary btn-small" disabled={busy}>
              {t('common.save')}
            </button>
            <button type="button" className="btn btn-small" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      {!open && error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
