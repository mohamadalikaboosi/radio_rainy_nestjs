import { FormEvent, useState } from 'react';
import { AdItem, api, uploadFile } from '../api';
import { useChannels } from '../channel-context';
import { mmss, timeAgo } from '../format';
import { errorMessage, useAsync } from '../hooks';
import { useT } from '../i18n';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';
import { FilePick } from './FilePick';

const kb = (n: number | null): string => (n === null ? '—' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function Ads() {
  const t = useT();
  const { selected } = useChannels();
  const ads = useAsync(() => api<AdItem[]>('/admin/ads', { query: { channelId: selected?.id } }), [selected?.id]);
  const [form, setForm] = useState({ name: '', linkUrl: '', ctaLabel: '', weight: 1, allChannels: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/admin/ads', { method: 'POST', body: { name: form.name, linkUrl: form.linkUrl || null, ctaLabel: form.ctaLabel || null, weight: form.weight, channelId: form.allChannels ? null : (selected?.id ?? null) } });
      setForm({ name: '', linkUrl: '', ctaLabel: '', weight: 1, allChannels: form.allChannels });
      ads.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const patch = (id: string, body: Partial<AdItem>) => async (): Promise<void> => {
    await api(`/admin/ads/${id}`, { method: 'PATCH', body });
    ads.reload();
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('ads.title')}</h1>
      </div>
      <Card title={t('ads.new')}>
        <p className="muted">{t('ads.help')}</p>
        <form className="row wrap" onSubmit={(e) => void create(e)}>
          <label>
            {t('ads.name')}
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
          </label>
          <label className="grow">
            {t('ads.link')}
            <input type="url" value={form.linkUrl} onChange={(e) => setForm({ ...form, linkUrl: e.target.value })} placeholder="https://" />
          </label>
          <label>
            {t('ads.cta')}
            <input value={form.ctaLabel} onChange={(e) => setForm({ ...form, ctaLabel: e.target.value })} maxLength={40} />
          </label>
          <label>
            {t('ads.weight')}
            <input type="number" min={1} max={100} value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} />
          </label>
          <label className="radio-line">
            <input type="checkbox" checked={form.allChannels} onChange={(e) => setForm({ ...form, allChannels: e.target.checked })} />
            {t('ads.allChannels')}
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {t('common.add')}
          </button>
        </form>
        <ErrorBox error={error} />
      </Card>

      <Card title={t('ads.list')}>
        <ErrorBox error={ads.error} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('ads.name')}</th>
                <th>{t('ads.audio')}</th>
                <th>{t('ads.image')}</th>
                <th>{t('ads.weight')}</th>
                <th>{t('ads.stats')}</th>
                <th>{t('common.enabled')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(ads.data ?? []).map((a) => (
                <tr key={a.id} className={a.enabled ? '' : 'row-dim'}>
                  <td>
                    <b>{a.name}</b>
                    <br />
                    <small className="muted">{a.channelId ? t('ads.thisChannel') : t('ads.everywhere')}</small>
                    {a.linkUrl && (
                      <>
                        <br />
                        <small>
                          <a href={a.linkUrl} target="_blank" rel="noreferrer">{a.ctaLabel || t('ads.link')}</a>
                        </small>
                      </>
                    )}
                  </td>
                  <td>
                    {a.hasAudio ? <Badge tone="good">{a.durationSeconds ? mmss(a.durationSeconds) : a.audioMime}</Badge> : <Badge tone="warn">{t('ads.noAudio')}</Badge>} <small className="muted">{kb(a.audioSize)}</small>
                    <br />
                    <FilePick accept="audio/*" onFile={async (f) => { await uploadFile(`/admin/ads/${a.id}/audio`, f); ads.reload(); }}>
                      {a.hasAudio ? t('ads.replaceAudio') : t('ads.uploadAudio')}
                    </FilePick>
                  </td>
                  <td>
                    {a.hasImage ? <img src={`/radio/ads/${a.id}/image`} alt="" className="thumb" /> : <span className="muted">—</span>}
                    <br />
                    <FilePick accept="image/png,image/jpeg,image/webp,image/gif" onFile={async (f) => { await uploadFile(`/admin/ads/${a.id}/image`, f); ads.reload(); }}>
                      {a.hasImage ? t('ads.replaceImage') : t('ads.uploadImage')}
                    </FilePick>
                  </td>
                  <td>
                    <input className="weight" type="number" min={1} max={100} defaultValue={a.weight} aria-label={t('ads.weight')} onBlur={(e) => { const w = Number(e.target.value); if (w >= 1 && w !== a.weight) void patch(a.id, { weight: w })(); }} />
                  </td>
                  <td>
                    <small>
                      {t('ads.plays', { n: a.plays })} · {t('ads.clicks', { n: a.clicks })}
                      <br />
                      {a.lastPlayedAt ? timeAgo(a.lastPlayedAt) : '—'}
                    </small>
                  </td>
                  <td>
                    <input type="checkbox" checked={a.enabled} aria-label={`${t('common.enabled')} ${a.name}`} onChange={(e) => void patch(a.id, { enabled: e.target.checked })()} />
                  </td>
                  <td>
                    <ActionButton className="btn-small btn-danger" confirm={t('common.confirmDelete', { name: a.name })} onAction={async () => { await api(`/admin/ads/${a.id}`, { method: 'DELETE' }); ads.reload(); }}>
                      {t('common.delete')}
                    </ActionButton>
                  </td>
                </tr>
              ))}
              {ads.data?.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    {t('ads.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
