import { useState } from 'react';
import { AdItem, CampaignStatus, api } from '../api';
import { mmss, timeAgo } from '../format';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';

type Row = AdItem & { accountName: string };
const STATUSES: (CampaignStatus | '')[] = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DRAFT', ''];

/** The operator's review queue: listen/look, then approve or reject with a reason the advertiser will see. */
export function CampaignReview() {
  const t = useT();
  const [status, setStatus] = useState<CampaignStatus | ''>('PENDING');
  const list = useAsync(() => api<Row[]>('/admin/campaigns', { query: { status: status || undefined } }), [status], 10_000);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const act = (id: string, verb: string, body?: unknown) => async (): Promise<void> => {
    await api(`/admin/campaigns/${id}/${verb}`, { method: 'POST', body });
    list.reload();
  };
  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('review.title')}</h1>
        <div className="segmented">
          {STATUSES.map((s) => (
            <button key={s || 'all'} aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s ? t(`portal.status.${s}`) : t('review.all')}
            </button>
          ))}
        </div>
      </div>
      <ErrorBox error={list.error} />
      <Card>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('ads.name')}</th>
                <th>{t('review.advertiser')}</th>
                <th>{t('ads.audio')}</th>
                <th>{t('ads.image')}</th>
                <th>{t('common.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>
                    <br />
                    {c.linkUrl ? (
                      <small>
                        <a href={c.linkUrl} target="_blank" rel="noreferrer noopener">{c.linkUrl}</a> {c.ctaLabel && `(${c.ctaLabel})`}
                      </small>
                    ) : (
                      <small className="muted">—</small>
                    )}
                  </td>
                  <td>
                    {c.accountName}
                    <br />
                    <small className="muted">{timeAgo(c.createdAt)}</small>
                  </td>
                  <td>{c.hasAudio ? <Badge tone="good">{c.durationSeconds ? mmss(c.durationSeconds) : c.audioMime}</Badge> : <Badge tone="warn">{t('ads.noAudio')}</Badge>}</td>
                  <td>{c.hasImage ? <img src={`/radio/ads/${c.id}/image`} alt="" className="thumb" /> : <span className="muted">—</span>}</td>
                  <td>
                    <Badge tone={c.status === 'APPROVED' ? 'good' : c.status === 'PENDING' ? 'info' : c.status === 'REJECTED' ? 'bad' : 'neutral'}>{t(`portal.status.${c.status}`)}</Badge>
                    {c.reviewNote && <div className="muted"><small>{c.reviewNote}</small></div>}
                  </td>
                  <td>
                    <div className="row wrap">
                      {c.status === 'PENDING' && (
                        <ActionButton className="btn-small btn-primary" onAction={act(c.id, 'approve')}>
                          {t('review.approve')}
                        </ActionButton>
                      )}
                      {(c.status === 'PENDING' || c.status === 'APPROVED' || c.status === 'PAUSED') && (
                        <>
                          <input aria-label={t('review.reason')} placeholder={t('review.reason')} value={notes[c.id] ?? ''} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} maxLength={500} />
                          <ActionButton className="btn-small btn-danger" disabled={!(notes[c.id] ?? '').trim()} onAction={act(c.id, 'reject', { note: (notes[c.id] ?? '').trim() })}>
                            {t('review.reject')}
                          </ActionButton>
                        </>
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
                    </div>
                  </td>
                </tr>
              ))}
              {list.data?.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    {t('review.empty')}
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
