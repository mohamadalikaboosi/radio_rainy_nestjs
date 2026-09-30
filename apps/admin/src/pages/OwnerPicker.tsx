import { AccountSummary, ChannelItem, api } from '../api';
import { useAsync } from '../hooks';
import { useT } from '../i18n';

/** Hands the station to a customer account (their portal then shows its stats/settings) or takes it back. Hidden until accounts exist. */
export function OwnerPicker({ channel, onChanged }: { channel: ChannelItem; onChanged: () => void }) {
  const t = useT();
  const accounts = useAsync(() => api<AccountSummary[]>('/admin/accounts'), []);
  if (!accounts.data || accounts.data.length === 0) return null;
  return (
    <label className="radio-line">
      <span className="muted">{t('accounts.owner')}</span>
      <select
        aria-label={`${t('accounts.owner')} ${channel.title}`}
        value={channel.ownerAccountId ?? ''}
        onChange={(e) => void api(`/admin/channels/${channel.id}/owner`, { method: 'PUT', body: { accountId: e.target.value || null } }).then(onChanged)}
      >
        <option value="">{t('accounts.noOwner')}</option>
        {accounts.data.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}
