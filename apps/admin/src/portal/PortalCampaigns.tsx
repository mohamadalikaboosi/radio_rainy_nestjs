import { FormEvent, useState } from 'react';
import { AdItem, CampaignStatus, PortalMe, api, uploadFile } from '../api';
import { mmss } from '../format';
import { errorMessage, useAsync } from '../hooks';
import { useT } from '../i18n';
import { FilePick } from '../pages/FilePick';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';

const tone = (s: CampaignStatus): 'neutral' | 'good' | 'warn' | 'bad' | 'info' => (s === 'APPROVED' ? 'good' : s === 'PENDING' ? 'info' : s === 'REJECTED' ? 'bad' : s === 'PAUSED' ? 'warn' : 'neutral');
const toIso = (d: string, end: boolean): string | null => (d ? new Date(`${d}T${end ? '23:59:59' : '00:00:00'}`).toISOString() : null);
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '∞');

export function PortalCampaigns({ me }: { me: PortalMe | null }) {
  const t = useT();
  const list = useAsync(() => api<AdItem[]>('/portal/campaigns', { auth: 'portal' }), []);
  const stations = useAsync(() => api<{ id: string; slug: string; title: string }[]>('/portal/stations/public', { auth: 'portal' }), []);
  const [form, setForm] = useState({ name: '', channelId: '', linkUrl: '', ctaLabel: '', startsAt: '', endsAt: '', maxPlays: '' });
  const [error, setError] = useState<string | null>(null);
  const credit = me?.account.creditCents ?? 0;
  const billing = me?.platform.billingEnabled ?? false;

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await api('/portal/campaigns', {
        auth: 'portal',
        method: 'POST',
        body: { name: form.name, channelId: form.channelId || null, linkUrl: form.linkUrl || null, ctaLabel: form.ctaLabel || null, startsAt: toIso(form.startsAt, false), endsAt: toIso(form.endsAt, true), maxPlays: form.maxPlays ? Number(form.maxPlays) : null },
      });
      setForm({ name: '', channelId: form.channelId, linkUrl: '', ctaLabel: '', startsAt: '', endsAt: '', maxPlays: '' });
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const act = (id: string, verb: 'submit' | 'pause' | 'resume') => async (): Promise<void> => {
    await api(`/portal/campaigns/${id}/${verb}`, { auth: 'portal', method: 'POST' });
    list.reload();
  };
  const titleOf = (cid: string | null): string => (cid ? (stations.data?.find((s) => s.id === cid)?.title ?? cid) : t('portal.allStations'));

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('portal.nav.campaigns')}</h1>
      </div>

      <Card title={t('portal.newCampaign')}>
        <p className="muted">{t('portal.campaignHelp')}</p>
        <form className="row wrap" onSubmit={(e) => void create(e)}>
          <label>
            {t('ads.name')}
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={100} />
          </label>
          <label>
            {t('portal.station')}
            <select value={form.channelId} onChange={(e) => setForm({ ...form, channelId: e.target.value })}>
              <option value="">{t('portal.allStations')}</option>
              {(stations.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
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
            {t('sponsors.from')}
            <input type="date" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </label>
          <label>
            {t('sponsors.until')}
            <input type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </label>
          <label>
            {t('portal.maxPlays')}
            <input type="number" min={1} value={form.maxPlays} onChange={(e) => setForm({ ...form, maxPlays: e.target.value })} placeholder="∞" />
          </label>
          <button className="btn btn-primary">{t('common.add')}</button>
        </form>
        <ErrorBox error={error} />
      </Card>

      <Card title={t('portal.yourCampaigns')}>
        <ErrorBox error={list.error} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('ads.name')}</th>
                <th>{t('common.status')}</th>
                <th>{t('ads.audio')}</th>
                <th>{t('ads.image')}</th>
                <th>{t('sponsors.window')}</th>
                <th>{t('ads.stats')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>
                    <br />
                    <small className="muted">{titleOf(c.channelId)}</small>
                    {c.linkUrl && (
                      <>
                        <br />
                        <small>
                          <a href={c.linkUrl} target="_blank" rel="noreferrer">{c.ctaLabel || c.linkUrl}</a>
                        </small>
                      </>
                    )}
                  </td>
                  <td>
                    <Badge tone={tone(c.status)}>{t(`portal.status.${c.status}`)}</Badge>
                    {c.status === 'REJECTED' && c.reviewNote && <div className="inline-error" role="note">{c.reviewNote}</div>}
                    {billing && c.status === 'APPROVED' && credit < (me?.platform.pricePerPlayCents ?? 0) && <div className="inline-error">{t('portal.needsCredit')}</div>}
                  </td>
                  <td>
                    {c.hasAudio ? <Badge tone="good">{c.durationSeconds ? mmss(c.durationSeconds) : c.audioMime}</Badge> : <Badge tone="warn">{t('ads.noAudio')}</Badge>}
                    <br />
                    <FilePick accept="audio/*" onFile={async (f) => { await uploadFile(`/portal/campaigns/${c.id}/audio`, f, undefined, 'portal'); list.reload(); }}>
                      {c.hasAudio ? t('ads.replaceAudio') : t('ads.uploadAudio')}
                    </FilePick>
                  </td>
                  <td>
                    {c.hasImage ? <img src={`/radio/ads/${c.id}/image`} alt="" className="thumb" /> : <span className="muted">—</span>}
                    <br />
                    <FilePick accept="image/png,image/jpeg,image/webp,image/gif" onFile={async (f) => { await uploadFile(`/portal/campaigns/${c.id}/image`, f, undefined, 'portal'); list.reload(); }}>
                      {c.hasImage ? t('ads.replaceImage') : t('ads.uploadImage')}
                    </FilePick>
                  </td>
                  <td>
                    <small>
                      {day(c.startsAt)} → {day(c.endsAt)}
                      <br />
                      {c.maxPlays ? t('portal.capPlays', { n: c.maxPlays }) : t('portal.noCap')}
                    </small>
                  </td>
                  <td>
                    <small>
                      {t('ads.plays', { n: c.plays })} · {t('ads.clicks', { n: c.clicks })}
                      {c.plays > 0 && <> · {((c.clicks / c.plays) * 100).toFixed(1)}%</>}
                    </small>
                  </td>
                  <td className="row wrap">
                    {(c.status === 'DRAFT' || c.status === 'REJECTED') && (
                      <ActionButton className="btn-small btn-primary" disabled={!c.hasAudio} onAction={act(c.id, 'submit')}>
                        {t('portal.submit')}
                      </ActionButton>
                    )}
                    {c.status === 'APPROVED' && (
                      <ActionButton className="btn-small" onAction={act(c.id, 'pause')}>
                        {t('portal.pause')}
                      </ActionButton>
                    )}
                    {c.status === 'PAUSED' && (
                      <ActionButton className="btn-small" onAction={act(c.id, 'resume')}>
                        {t('portal.resume')}
                      </ActionButton>
                    )}
                    <ActionButton className="btn-small btn-danger" confirm={t('common.confirmDelete', { name: c.name })} onAction={async () => { await api(`/portal/campaigns/${c.id}`, { auth: 'portal', method: 'DELETE' }); list.reload(); }}>
                      {t('common.delete')}
                    </ActionButton>
                  </td>
                </tr>
              ))}
              {list.data?.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    {t('portal.noCampaigns')}
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
