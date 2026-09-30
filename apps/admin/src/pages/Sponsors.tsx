import { FormEvent, useState } from 'react';
import { SponsorItem, api, uploadFile } from '../api';
import { useChannels } from '../channel-context';
import { errorMessage, useAsync } from '../hooks';
import { useT } from '../i18n';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';
import { FilePick } from './FilePick';

const dateOnly = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');
const toIso = (d: string, endOfDay: boolean): string | null => (d ? new Date(`${d}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString() : null);

function status(s: SponsorItem, now = Date.now()): 'off' | 'scheduled' | 'expired' | 'live' {
  if (!s.enabled) return 'off';
  if (s.startsAt && Date.parse(s.startsAt) > now) return 'scheduled';
  if (s.endsAt && Date.parse(s.endsAt) <= now) return 'expired';
  return 'live';
}

export function Sponsors() {
  const t = useT();
  const { selected } = useChannels();
  const list = useAsync(() => api<SponsorItem[]>('/admin/sponsors', { query: { channelId: selected?.id } }), [selected?.id]);
  const [form, setForm] = useState({ name: '', tagline: '', url: '', ctaLabel: 'Visit', weight: 1, startsAt: '', endsAt: '', allChannels: true });
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await api('/admin/sponsors', {
        method: 'POST',
        body: { name: form.name, tagline: form.tagline || null, url: form.url, ctaLabel: form.ctaLabel || 'Visit', weight: form.weight, startsAt: toIso(form.startsAt, false), endsAt: toIso(form.endsAt, true), channelId: form.allChannels ? null : (selected?.id ?? null) },
      });
      setForm({ ...form, name: '', tagline: '', url: '', startsAt: '', endsAt: '' });
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const patch = (id: string, body: Partial<SponsorItem>) => async (): Promise<void> => {
    await api(`/admin/sponsors/${id}`, { method: 'PATCH', body });
    list.reload();
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('sponsors.title')}</h1>
      </div>
      <Card title={t('sponsors.new')}>
        <p className="muted">{t('sponsors.help')}</p>
        <form className="row wrap" onSubmit={(e) => void create(e)}>
          <label>
            {t('sponsors.name')}
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
          </label>
          <label>
            {t('sponsors.tagline')}
            <input value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} maxLength={160} />
          </label>
          <label className="grow">
            {t('sponsors.url')}
            <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" required />
          </label>
          <label>
            {t('sponsors.button')}
            <input value={form.ctaLabel} onChange={(e) => setForm({ ...form, ctaLabel: e.target.value })} maxLength={40} required />
          </label>
          <label>
            {t('ads.weight')}
            <input type="number" min={1} max={100} value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} />
          </label>
          <label>
            {t('sponsors.from')}
            <input type="date" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </label>
          <label>
            {t('sponsors.until')}
            <input type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </label>
          <label className="radio-line">
            <input type="checkbox" checked={form.allChannels} onChange={(e) => setForm({ ...form, allChannels: e.target.checked })} />
            {t('ads.allChannels')}
          </label>
          <button className="btn btn-primary">{t('common.add')}</button>
        </form>
        <ErrorBox error={error} />
      </Card>

      <Card title={t('sponsors.list')}>
        <ErrorBox error={list.error} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('sponsors.name')}</th>
                <th>{t('sponsors.logo')}</th>
                <th>{t('sponsors.window')}</th>
                <th>{t('ads.stats')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.enabled')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((s) => {
                const st = status(s);
                return (
                  <tr key={s.id} className={s.enabled ? '' : 'row-dim'}>
                    <td>
                      <b>{s.name}</b>
                      <br />
                      <small className="muted">{s.tagline}</small>
                      <br />
                      <small>
                        <a href={s.url} target="_blank" rel="noreferrer">{s.ctaLabel}</a>
                      </small>
                    </td>
                    <td>
                      {s.hasLogo ? <img src={`/radio/sponsors/${s.id}/logo`} alt="" className="thumb" /> : <span className="muted">—</span>}
                      <br />
                      <FilePick accept="image/png,image/jpeg,image/webp,image/gif" onFile={async (f) => { await uploadFile(`/admin/sponsors/${s.id}/logo`, f); list.reload(); }}>
                        {s.hasLogo ? t('ads.replaceImage') : t('ads.uploadImage')}
                      </FilePick>
                    </td>
                    <td>
                      <small>
                        {dateOnly(s.startsAt) || '∞'} → {dateOnly(s.endsAt) || '∞'}
                      </small>
                    </td>
                    <td>
                      <small>
                        {t('sponsors.impressions', { n: s.impressions })} · {t('ads.clicks', { n: s.clicks })}
                        {s.impressions > 0 && <> · {((s.clicks / s.impressions) * 100).toFixed(1)}%</>}
                      </small>
                    </td>
                    <td>
                      <Badge tone={st === 'live' ? 'good' : st === 'scheduled' ? 'info' : 'neutral'}>{t(`sponsors.status.${st}`)}</Badge>
                    </td>
                    <td>
                      <input type="checkbox" checked={s.enabled} aria-label={`${t('common.enabled')} ${s.name}`} onChange={(e) => void patch(s.id, { enabled: e.target.checked })()} />
                    </td>
                    <td>
                      <ActionButton className="btn-small btn-danger" confirm={t('common.confirmDelete', { name: s.name })} onAction={async () => { await api(`/admin/sponsors/${s.id}`, { method: 'DELETE' }); list.reload(); }}>
                        {t('common.delete')}
                      </ActionButton>
                    </td>
                  </tr>
                );
              })}
              {list.data?.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    {t('sponsors.empty')}
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
