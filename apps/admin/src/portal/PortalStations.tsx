import { DirectLink } from '../player/DirectLink';
import { useState } from 'react';
import { MyStation, api } from '../api';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { EngagementEditor } from '../pages/Engagement';
import { Badge, Card, ErrorBox, Stat } from '../ui';

/** Stations the operator assigned to this account: live numbers and the same engagement settings the operator has. */
export function PortalStations() {
  const t = useT();
  const list = useAsync(() => api<MyStation[]>('/portal/stations', { auth: 'portal' }), [], 15_000);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('portal.nav.stations')}</h1>
      </div>
      <ErrorBox error={list.error} />
      {list.data?.length === 0 && <p className="muted">{t('portal.noStations')}</p>}
      {(list.data ?? []).map((s) => (
        <Card key={s.id} title={s.title} actions={s.started ? <Badge tone="good">{t('portal.onAir')}</Badge> : <Badge>{t('portal.offAir')}</Badge>}>
          <div className="stats">
            <Stat label={t('portal.listenersNow')} value={s.listenersNow} />
            <Stat label={t('portal.plays24h')} value={s.plays24h} />
            <Stat label={t('portal.peak24h')} value={s.peakListeners24h} />
            <Stat label={t('portal.avg24h')} value={s.avgListeners24h} />
          </div>
          <p>
            <code>/radio/{s.slug}/stream</code>
          </p>
          <DirectLink slug={s.slug} />
          <button className="btn btn-small" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
            {t('portal.settings')}
          </button>
          {open === s.id && <EngagementEditor channelId={s.id} title={s.title} prefix="/portal/stations" auth="portal" />}
        </Card>
      ))}
    </div>
  );
}
