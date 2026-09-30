import { LedgerEntry, PublicPlatform, api } from '../api';
import { timeAgo } from '../format';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { Badge, Card, ErrorBox, Stat } from '../ui';

export function PortalBilling() {
  const t = useT();
  const b = useAsync(() => api<{ creditCents: number; ledger: LedgerEntry[]; platform: PublicPlatform }>('/portal/billing', { auth: 'portal' }), []);
  const d = b.data;
  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('portal.nav.billing')}</h1>
      </div>
      <ErrorBox error={b.error} />
      {d && (
        <>
          <div className="stats">
            <Stat label={t('portal.balance', { currency: d.platform.currency })} value={d.creditCents} tone={d.platform.billingEnabled && d.creditCents <= 0 ? 'bad' : undefined} />
            <Stat label={t('portal.pricePlay')} value={d.platform.billingEnabled ? d.platform.pricePerPlayCents : 0} />
            <Stat label={t('portal.priceClick')} value={d.platform.billingEnabled ? d.platform.pricePerClickCents : 0} />
          </div>
          <p className="muted">{d.platform.billingEnabled ? t('portal.howToTopUp') : t('portal.freeNote')}</p>
          <Card title={t('portal.ledger')}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('engagement.opened')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('portal.amount')}</th>
                    <th>{t('portal.balanceAfter')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.ledger.map((l) => (
                    <tr key={l.id}>
                      <td>{timeAgo(l.createdAt)}</td>
                      <td>
                        <Badge tone={l.amountCents > 0 ? 'good' : 'neutral'}>{t(`portal.kind.${l.kind}`)}</Badge> <small className="muted">{l.note}</small>
                      </td>
                      <td>{l.amountCents > 0 ? `+${l.amountCents}` : l.amountCents}</td>
                      <td>{l.balanceAfter}</td>
                    </tr>
                  ))}
                  {d.ledger.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted">
                        {t('portal.noLedger')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
