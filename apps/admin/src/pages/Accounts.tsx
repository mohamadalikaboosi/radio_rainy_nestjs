import { useState } from 'react';
import { AccountSummary, LedgerEntry, api } from '../api';
import { timeAgo } from '../format';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';

function Credit({ account, onDone }: { account: AccountSummary; onDone: () => void }) {
  const t = useT();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  return (
    <span className="row wrap">
      <input aria-label={t('accounts.amount')} className="weight" style={{ width: '7rem' }} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="+/-" />
      <input aria-label={t('accounts.note')} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('accounts.note')} maxLength={200} />
      <ActionButton className="btn-small" disabled={!Number(amount)} onAction={async () => { await api(`/admin/accounts/${account.id}/credit`, { method: 'POST', body: { amountCents: Math.round(Number(amount)), note: note || undefined } }); setAmount(''); setNote(''); onDone(); }}>
        {t('accounts.addCredit')}
      </ActionButton>
    </span>
  );
}

export function Accounts() {
  const t = useT();
  const list = useAsync(() => api<AccountSummary[]>('/admin/accounts'), []);
  const [ledger, setLedger] = useState<{ name: string; rows: LedgerEntry[] } | null>(null);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('accounts.title')}</h1>
      </div>
      <ErrorBox error={list.error} />
      <Card title={t('accounts.list')}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('ads.name')}</th>
                <th>{t('portal.email')}</th>
                <th>{t('accounts.credit')}</th>
                <th>{t('accounts.usage')}</th>
                <th>{t('common.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((a) => (
                <tr key={a.id} className={a.status === 'SUSPENDED' ? 'row-dim' : ''}>
                  <td>
                    <b>{a.name}</b>
                    <br />
                    <small className="muted">{timeAgo(a.createdAt)}</small>
                  </td>
                  <td>{a.email}</td>
                  <td>
                    <b>{a.creditCents}</b>
                    <br />
                    <Credit account={a} onDone={list.reload} />
                  </td>
                  <td>
                    <small>
                      {t('accounts.campaigns', { n: a.campaigns })} · {t('accounts.stations', { n: a.stations })}
                    </small>
                  </td>
                  <td>
                    <Badge tone={a.status === 'ACTIVE' ? 'good' : 'bad'}>{t(`accounts.status.${a.status}`)}</Badge>
                  </td>
                  <td className="row wrap">
                    <ActionButton className="btn-small" onAction={async () => setLedger({ name: a.name, rows: await api<LedgerEntry[]>(`/admin/accounts/${a.id}/ledger`) })}>
                      {t('accounts.ledger')}
                    </ActionButton>
                    <ActionButton className={`btn-small ${a.status === 'ACTIVE' ? 'btn-danger' : ''}`} confirm={a.status === 'ACTIVE' ? t('accounts.confirmSuspend', { name: a.name }) : undefined} onAction={async () => { await api(`/admin/accounts/${a.id}`, { method: 'PATCH', body: { status: a.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' } }); list.reload(); }}>
                      {a.status === 'ACTIVE' ? t('accounts.suspend') : t('accounts.activate')}
                    </ActionButton>
                  </td>
                </tr>
              ))}
              {list.data?.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    {t('accounts.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {ledger && (
        <Card title={`${t('accounts.ledger')}: ${ledger.name}`} actions={<button className="btn btn-small" onClick={() => setLedger(null)}>{t('common.cancel')}</button>}>
          <table>
            <tbody>
              {ledger.rows.map((l) => (
                <tr key={l.id}>
                  <td>{timeAgo(l.createdAt)}</td>
                  <td>{t(`portal.kind.${l.kind}`)}</td>
                  <td>{l.amountCents > 0 ? `+${l.amountCents}` : l.amountCents}</td>
                  <td>{l.balanceAfter}</td>
                  <td className="muted">{l.note}</td>
                </tr>
              ))}
              {ledger.rows.length === 0 && (
                <tr>
                  <td className="muted">{t('portal.noLedger')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
