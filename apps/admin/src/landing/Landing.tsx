import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';
import { LanguageSwitcher, useT } from '../i18n';
import type { Station } from '../player/useRadio';
import './landing.css';

interface NowOnAir {
  status: string;
  title?: string | null;
  artist?: string | null;
}

/** Tiny inline icons (no icon library): one per feature. */
const ICONS: Record<string, string> = {
  sync: 'M12 3a9 9 0 1 0 9 9M12 7v5l3 2M17 3h4v4',
  telegram: 'M21 4 3 11l5 2 2 6 3-4 5 4 3-15ZM8 13l9-6',
  lyrics: 'M4 6h16M4 11h10M4 16h16M4 21h8',
  data: 'M3 17l4-5 4 3 5-8 5 6M3 21h18',
  ads: 'M4 5h16v11H4zM8 20h8M12 16v4',
  vote: 'M5 12l4 4L19 6M5 20h14',
  pwa: 'M7 3h10v18H7zM11 18h2',
  lang: 'M3 5h8M7 3v2m-3 8c2 0 4-2 5-8M9 11c-1 2-3 4-6 5M13 21l4-10 4 10m-6.5-3h5',
};
const Icon = ({ name }: { name: string }) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={ICONS[name] ?? ''} />
  </svg>
);

const FEATURES = ['sync', 'telegram', 'lyrics', 'data', 'ads', 'vote', 'pwa', 'lang'] as const;

/** What each live station is playing right now (public API, no login). */
function useOnAir(stations: Station[] | undefined): Record<string, NowOnAir> {
  const [now, setNow] = useState<Record<string, NowOnAir>>({});
  const key = (stations ?? []).filter((s) => s.live).map((s) => s.slug).slice(0, 6).join(',');
  useEffect(() => {
    if (!key) return;
    let dead = false;
    const load = async (): Promise<void> => {
      const entries = await Promise.all(
        key.split(',').map(async (slug) => [slug, await api<NowOnAir>(`/radio/${slug}/current`).catch(() => ({ status: 'NONE' }) as NowOnAir)] as const),
      );
      if (!dead) setNow(Object.fromEntries(entries));
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [key]);
  return now;
}

export function Landing() {
  const t = useT();
  const stations = useAsync(() => api<Station[]>('/radio/stations'), [], 30_000);
  const all = [...(stations.data ?? [])].sort((a, b) => Number(b.live) - Number(a.live) || a.title.localeCompare(b.title));
  const live = all.filter((s) => s.live);
  const now = useOnAir(stations.data ?? undefined);
  const first = live[0];
  const firstNow = first ? now[first.slug] : undefined;
  const hrefOf = (s: Station): string => (s.publicId ? `/${s.publicId}` : `/s/${s.slug}`);
  const listenHref = first ? hrefOf(first) : '/listen';

  return (
    <div className="lp">
      <div className="lp-rain" aria-hidden />
      <header className="lp-nav">
        <a className="lp-logo" href="/">
          🌧 radio_rainy
        </a>
        <nav className="lp-links" aria-label="Main">
          <a href="#stations">{t('landing.nav.stations')}</a>
          <a href="#features">{t('landing.nav.features')}</a>
          <a href="#how">{t('landing.nav.how')}</a>
          <a href="/partner">{t('landing.nav.advertise')}</a>
        </nav>
        <div className="lp-nav-end">
          <LanguageSwitcher className="lp-select" />
          <a className="lp-btn lp-btn-ghost" href="/panel">
            {t('landing.nav.operator')}
          </a>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow">{t('landing.eyebrow')}</p>
            <h1>{t('landing.title')}</h1>
            <p className="lp-lead">{t('landing.lead')}</p>
            <div className="lp-cta">
              <a className="lp-btn lp-btn-primary" href={listenHref}>
                ▶ {t('landing.listen')}
              </a>
              <a className="lp-btn lp-btn-ghost" href="/panel">
                {t('landing.start')}
              </a>
            </div>
            <ul className="lp-proof">
              <li>{t('landing.proof.sync')}</li>
              <li>{t('landing.proof.free')}</li>
              <li>{t('landing.proof.selfhost')}</li>
            </ul>
          </div>

          <div className="lp-device" aria-label={t('landing.device')}>
            <div className="lp-device-top">
              <span className={`lp-dot${first ? ' on' : ''}`} />
              {first ? t('landing.onAir') : t('landing.offAir')}
            </div>
            <div className="lp-cover" aria-hidden>
              <div className="lp-bars">
                {Array.from({ length: 24 }, (_, i) => (
                  <i key={i} style={{ animationDelay: `${(i * 97) % 900}ms` }} />
                ))}
              </div>
            </div>
            <div className="lp-track">
              <b>{firstNow?.title || (first ? first.title : t('landing.demo.title'))}</b>
              <span>{firstNow?.artist || (first ? t('landing.demo.station', { name: first.title }) : t('landing.demo.artist'))}</span>
            </div>
            <div className="lp-lines" aria-hidden>
              <span>{t('landing.demo.l1')}</span>
              <span className="act">{t('landing.demo.l2')}</span>
              <span>{t('landing.demo.l3')}</span>
            </div>
          </div>
        </section>

        <section id="stations" className="lp-section">
          <h2>{t('landing.stations.title')}</h2>
          <p className="lp-sub">{t('landing.stations.sub')}</p>
          {all.length === 0 ? (
            <p className="lp-empty">{t('landing.stations.none')}</p>
          ) : (
            <ul className="lp-grid lp-stations">
              {all.map((s) => {
                const n = now[s.slug];
                return (
                  <li key={s.slug}>
                    <a className={`lp-card lp-station${s.live ? '' : ' off'}`} href={hrefOf(s)}>
                      <span className={s.live ? 'lp-live' : 'lp-live off'}>{s.live ? t('landing.onAir') : t('landing.offAir')}</span>
                      <b>{s.title}</b>
                      <span className="lp-np">{s.live && n?.title ? `${n.title}${n.artist ? ` — ${n.artist}` : ''}` : s.live ? t('landing.stations.tune') : t('landing.stations.soon')}</span>
                      <span className="lp-go">{t('landing.listen')} →</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section id="features" className="lp-section">
          <h2>{t('landing.features.title')}</h2>
          <ul className="lp-grid lp-features">
            {FEATURES.map((f) => (
              <li key={f} className="lp-card">
                <span className="lp-ico">
                  <Icon name={f} />
                </span>
                <b>{t(`landing.f.${f}.t`)}</b>
                <p>{t(`landing.f.${f}.d`)}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="how" className="lp-section">
          <h2>{t('landing.how.title')}</h2>
          <ol className="lp-steps">
            {[1, 2, 3].map((n) => (
              <li key={n}>
                <span className="lp-num">{n}</span>
                <b>{t(`landing.how.${n}.t`)}</b>
                <p>{t(`landing.how.${n}.d`)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-section lp-split">
          <div className="lp-card lp-pane">
            <h3>{t('landing.adv.title')}</h3>
            <p>{t('landing.adv.desc')}</p>
            <a className="lp-btn lp-btn-primary" href="/partner">
              {t('landing.adv.cta')}
            </a>
          </div>
          <div className="lp-card lp-pane">
            <h3>{t('landing.op.title')}</h3>
            <p>{t('landing.op.desc')}</p>
            <a className="lp-btn lp-btn-ghost" href="/panel">
              {t('landing.op.cta')}
            </a>
          </div>
        </section>

        <section className="lp-final">
          <h2>{t('landing.final.title')}</h2>
          <a className="lp-btn lp-btn-primary lp-big" href={listenHref}>
            ▶ {t('landing.listen')}
          </a>
        </section>
      </main>

      <footer className="lp-foot">
        <span>🌧 radio_rainy</span>
        <span>{t('landing.foot')}</span>
        <nav aria-label="Footer">
          <a href="/listen">{t('landing.nav.player')}</a>
          <a href="/partner">{t('landing.nav.advertise')}</a>
          <a href="/panel">{t('landing.nav.operator')}</a>
        </nav>
      </footer>
    </div>
  );
}
