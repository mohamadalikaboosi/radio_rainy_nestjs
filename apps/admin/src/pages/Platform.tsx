import { FormEvent, useEffect, useState } from 'react';
import { PlatformSettings, api } from '../api';
import { errorMessage, useAsync } from '../hooks';
import { useT } from '../i18n';
import { Badge, Card, ErrorBox } from '../ui';

const num = (v: string, max: number): number => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));

/** Operator switches. Billing is OFF by default: everything is free and unlimited until this is turned on. */
export function Platform() {
  const t = useT();
  const settings = useAsync(() => api<PlatformSettings>('/admin/platform'), []);
  const [form, setForm] = useState<PlatformSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const set = (p: Partial<PlatformSettings>): void => setForm((f) => (f ? { ...f, ...p } : f));
  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    setSaved(false);
    try {
      await api('/admin/platform', { method: 'PUT', body: form });
      setSaved(true);
      settings.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('platform.title')}</h1>
        {form && <Badge tone={form.billingEnabled ? 'warn' : 'good'}>{form.billingEnabled ? t('platform.billingOn') : t('platform.billingOff')}</Badge>}
      </div>
      <ErrorBox error={settings.error} />
      {form && (
        <form className="stack" onSubmit={(e) => void save(e)}>
          <Card title={t('platform.billing')}>
            <p className="muted">{t('platform.billingHelp')}</p>
            <label className="radio-line">
              <input type="checkbox" checked={form.billingEnabled} onChange={(e) => set({ billingEnabled: e.target.checked })} />
              {t('platform.billingEnabled')}
            </label>
            <div className="row wrap">
              <label>
                {t('platform.pricePlay')}
                <input type="number" min={0} value={form.pricePerPlayCents} onChange={(e) => set({ pricePerPlayCents: num(e.target.value, 1_000_000_000) })} />
              </label>
              <label>
                {t('platform.priceClick')}
                <input type="number" min={0} value={form.pricePerClickCents} onChange={(e) => set({ pricePerClickCents: num(e.target.value, 1_000_000_000) })} />
              </label>
              <label>
                {t('platform.currency')}
                <input value={form.currency} maxLength={8} onChange={(e) => set({ currency: e.target.value })} required />
              </label>
            </div>
          </Card>
          <Card title={t('platform.access')}>
            <label className="radio-line">
              <input type="checkbox" checked={form.selfSignupEnabled} onChange={(e) => set({ selfSignupEnabled: e.target.checked })} />
              {t('platform.selfSignup')}
            </label>
            <label className="radio-line">
              <input type="checkbox" checked={form.campaignApprovalRequired} onChange={(e) => set({ campaignApprovalRequired: e.target.checked })} />
              {t('platform.approval')}
            </label>
            <label>
              {t('platform.maxCampaigns')}
              <input type="number" min={0} value={form.maxCampaignsPerAccount} onChange={(e) => set({ maxCampaignsPerAccount: num(e.target.value, 10_000) })} />
            </label>
          </Card>
          <div className="row">
            <button className="btn btn-primary">{t('common.save')}</button>
            {saved && <Badge tone="good">{t('common.saved')}</Badge>}
          </div>
          <ErrorBox error={error} />
        </form>
      )}
    </div>
  );
}
