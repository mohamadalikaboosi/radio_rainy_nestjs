import '@fontsource/instrument-serif/400.css';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/vazirmatn/arabic-400.css';
import '@fontsource/vazirmatn/arabic-600.css';
import '@fontsource/vazirmatn/arabic-700.css';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VoteView } from '../api';
import { mmss } from '../format';
import { LanguageSwitcher, useT } from '../i18n';
import './player.css';
import { loadQuality, loadSetting, pickSponsor, saveQuality, saveSetting, secondsSince, secondsUntil, voteShares } from './helpers';
import type { QualityPref, SponsorView } from './helpers';
import { LyricsCard } from './LyricsCard';
import type { AdOnAir } from './useRadio';
import { useRadio } from './useRadio';
import { wsUrl } from './useRealtime';
import { useInstallPrompt, useMediaSession, usePlayerAudio } from './usePlayerAudio';
import type { LiveMessage } from './useRealtime';
import { Visualizer } from './Visualizer';

const LYRICS_KEY = 'rr_lyrics';

/** A ticking "now" so countdowns / progress move smoothly between the polls and pushes. */
function useNow(ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** `template` with `{name}` replaced by a React node (for a value styled differently inside a translated sentence). */
function withNode(text: string, marker: string, node: ReactNode): ReactNode {
  const [before, after] = text.split(marker);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

/** The display title is huge (up to 120px): long ones step down so they stay within two or three lines. */
const titleSize = (title: string | undefined): string => ((title?.length ?? 0) > 34 ? ' xlong' : (title?.length ?? 0) > 16 ? ' long' : '');

/** Display-only on live radio: where the station's timeline is in the track. */
function Progress({ value, max }: { value: number; max: number | null | undefined }) {
  const pct = max && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="pl-progress">
      <div className="pl-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={max ?? 0} aria-valuenow={Math.round(value)}>
        <div className="pl-progress-fill" style={{ width: `${pct}%` }} />
        <div className="pl-progress-knob" style={{ insetInlineStart: `${pct}%` }} />
      </div>
      <div className="pl-times">
        <span>{mmss(value)}</span>
        <span>{mmss(max)}</span>
      </div>
    </div>
  );
}

/** The record: spins while sound plays and stops in place when it doesn't; the label carries the station (or the ad's artwork). */
function Vinyl({ spinning, label, sub, image }: { spinning: boolean; label: string; sub: string; image?: string | null }) {
  return (
    <div className="pl-vinyl-wrap" aria-hidden>
      <div className={`pl-vinyl-glow${spinning ? ' on' : ''}`} />
      <div className={`pl-vinyl${spinning ? '' : ' paused'}`}>
        <div className="pl-vinyl-sheen" />
        <div className="pl-vinyl-label">
          {image ? (
            <img src={image} alt="" />
          ) : (
            <>
              <span className="pl-vinyl-name">{label}</span>
              <span className="pl-vinyl-sub">{sub}</span>
              <span className="pl-vinyl-hole" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Rain() {
  const drops = useMemo(
    () =>
      Array.from({ length: 40 }, () => ({
        left: `${(Math.random() * 100).toFixed(1)}%`,
        height: `${40 + Math.floor(Math.random() * 80)}px`,
        animationDuration: `${(1.2 + Math.random() * 1.8).toFixed(2)}s`,
        animationDelay: `${(-Math.random() * 3).toFixed(2)}s`,
      })),
    [],
  );
  return (
    <div className="pl-rain" aria-hidden>
      {drops.map((d, i) => (
        <span key={i} style={d} />
      ))}
    </div>
  );
}

function PlayButton({ playing, buffering, disabled, onClick, compact = false }: { playing: boolean; buffering: boolean; disabled: boolean; onClick: () => void; compact?: boolean }) {
  const t = useT();
  const label = playing ? t('player.pause') : t('player.listenLive');
  return (
    <button className={`pl-play${buffering && playing ? ' busy' : ''}${compact ? ' compact' : ''}`} onClick={onClick} aria-pressed={playing} disabled={disabled} aria-label={label}>
      <span className="pl-play-disc" aria-hidden>
        {playing ? (
          <span className="pl-pause-bars">
            <i />
            <i />
          </span>
        ) : (
          <span className="pl-play-tri" />
        )}
      </span>
      {!compact && <span>{label}</span>}
    </button>
  );
}

export function VoteCard({ vote, now, fetchedAt, onVote }: { vote: VoteView; now: number; fetchedAt: number; onVote: (tag: string) => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (vote.status === 'PLAYING' && vote.winner && vote.playUntil) {
    const left = secondsUntil(vote.playUntil, vote.serverTime, fetchedAt, now);
    return (
      <div className="pl-card pl-vote" data-testid="vote-playing">
        <span className="pl-eyebrow">{t('vote.chosen')}</span>
        <h2 className="pl-card-title">{t('vote.nowPlaying', { tag: `#${vote.winner}` })}</h2>
        <p className="pl-hint">{t('vote.timeLeft', { time: mmss(left) })}</p>
      </div>
    );
  }
  if (vote.status !== 'OPEN' || !vote.poll) return null;
  const left = secondsUntil(vote.poll.closesAt, vote.serverTime, fetchedAt, now);
  const shares = voteShares(vote.poll.options.map((o) => o.votes));
  const total = vote.poll.options.reduce((a, o) => a + o.votes, 0);
  const votesLabel = (n: number): string => (n === 1 ? t('vote.oneVote') : t('vote.votes', { n }));
  return (
    <div className="pl-card pl-vote" data-testid="vote-open">
      <div className="pl-card-head">
        <h2 className="pl-card-title">{t('vote.title')}</h2>
        <span className="pl-mono">{withNode(t('vote.closesIn', { time: '\u0001' }), '\u0001', <b className="pl-acc">{mmss(left)}</b>)}</span>
      </div>
      <div className="pl-vote-options">
        {vote.poll.options.map((o, i) => (
          <button
            key={o.hashtag}
            className={`pl-vote-option${vote.myVote === o.hashtag ? ' mine' : ''}`}
            disabled={busy}
            aria-pressed={vote.myVote === o.hashtag}
            onClick={() => {
              setBusy(true);
              void onVote(o.hashtag).finally(() => setBusy(false));
            }}
          >
            <span className="pl-vote-bar" style={{ width: `${shares[i] ?? 0}%` }} />
            <bdi className="pl-vote-tag">#{o.hashtag}</bdi>
            <span className="pl-vote-count">{total > 0 ? t('vote.result', { pct: shares[i] ?? 0, votes: votesLabel(o.votes) }) : votesLabel(0)}</span>
          </button>
        ))}
      </div>
      <p className="pl-hint">{vote.myVote ? t('vote.counted') : t('vote.tapToVote')}</p>
    </div>
  );
}

export function SponsorCard({ sponsor }: { sponsor: SponsorView }) {
  const t = useT();
  return (
    <aside className="pl-card pl-sponsor" data-testid="sponsor">
      <span className="pl-eyebrow muted">{t('player.sponsor')}</span>
      <div className="pl-sponsor-row">
        {sponsor.logoUrl ? <img src={sponsor.logoUrl} alt="" className="pl-sponsor-logo" loading="lazy" /> : <span className="pl-sponsor-logo empty" aria-hidden />}
        <div className="pl-sponsor-text">
          <b>{sponsor.name}</b>
          {sponsor.tagline && <span>{sponsor.tagline}</span>}
        </div>
      </div>
      <a className="pl-visit" href={sponsor.url} target="_blank" rel="noopener noreferrer sponsored">
        <span>{sponsor.ctaLabel}</span>
        <span className="pl-arrow" aria-hidden>
          →
        </span>
      </a>
    </aside>
  );
}

function AdNow({ ad, elapsed }: { ad: AdOnAir; elapsed: number }) {
  const t = useT();
  return (
    <>
      <div className="pl-heading">
        <span className="pl-eyebrow">{t('player.sponsoredAudio')}</span>
        <h1 className={`pl-title${titleSize(ad.name)}`}>{ad.name}</h1>
      </div>
      {ad.duration ? <Progress value={elapsed} max={ad.duration} /> : null}
      {ad.linkUrl && (
        <a className="pl-visit" href={ad.linkUrl} target="_blank" rel="noopener noreferrer sponsored">
          <span>{ad.ctaLabel || t('player.learnMore')}</span>
          <span className="pl-arrow" aria-hidden>
            →
          </span>
        </a>
      )}
    </>
  );
}

/**
 * Public listener page (design "Rainy Song"): header, the record + what is on air, the visualizer, live synced lyrics, the tag vote and a
 * sponsor. `lockedSlug`: the page of ONE station (/s/:slug, /<uuid>): no station picker, no other station reachable.
 */
export function Player({ lockedSlug }: { lockedSlug?: string } = {}) {
  const t = useT();
  const r = useRadio(lockedSlug);
  const station = r.stations?.find((s) => s.slug === r.slug);
  const unknownStation = !!lockedSlug && !!r.stations && !station;
  const transport = r.realtime.transport ?? station?.transport ?? 'HTTP';
  const lowAvailable = station?.lowQuality ?? false;
  const [qualityPref, setQualityPref] = useState<QualityPref>(loadQuality);
  const { audio, playing, buffering, reconnecting, analyser, error, toggle, stop, play, active: activeTransport, quality, volume, setVolume } = usePlayerAudio(r.base ? `${r.base}/stream` : null, {
    transport,
    audioSocketUrl: r.slug ? wsUrl(`/radio/${r.slug}/audio`) : null,
    quality: qualityPref,
    lowAvailable,
  });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [showLyrics, setShowLyrics] = useState(() => loadSetting(LYRICS_KEY, '1') === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const install = useInstallPrompt();
  const now = useNow();
  const c = r.current;
  const onAir = c?.status === 'PLAYING';
  const ad = c?.status === 'AD' ? c.ad : undefined;
  const sounding = playing && !buffering;

  useMediaSession(onAir && c ? { title: c.title ?? '', artist: c.artist ?? '', album: c.album ?? '' } : null, playing, play, stop);

  // sponsors rotate (weighted, never the same one twice in a row)
  const [sponsorId, setSponsorId] = useState<string | null>(null);
  useEffect(() => {
    if (r.sponsors.length === 0) return setSponsorId(null);
    setSponsorId((cur) => (cur && r.sponsors.some((s) => s.id === cur) ? cur : (pickSponsor(r.sponsors)?.id ?? null)));
    const rot = setInterval(() => setSponsorId((cur) => pickSponsor(r.sponsors, Math.random, cur ?? undefined)?.id ?? null), 20_000);
    return () => clearInterval(rot);
  }, [r.sponsors]);
  const sponsor = r.sponsors.find((s) => s.id === sponsorId) ?? null;

  const serverTime = c?.serverTime ?? new Date(now).toISOString();
  const fetchedAt = r.fetchedAt.current;
  const startedAt = c?.startedAt;
  const duration = c?.duration;
  // the browser follows the station's timeline from the server clock: no per-line polling
  const positionAt = useCallback(
    (): number => (onAir && startedAt ? Math.min(duration ?? Infinity, secondsSince(startedAt, serverTime, fetchedAt, Date.now())) : 0),
    [onAir, startedAt, duration, serverTime, fetchedAt],
  );
  const position = positionAt();
  const adElapsed = ad?.startedAt ? secondsSince(ad.startedAt, serverTime, fetchedAt, now) : 0;

  // mobile: a mini player pinned to the bottom once the hero has scrolled away
  const hero = useRef<HTMLElement>(null);
  const [heroVisible, setHeroVisible] = useState(true);
  useEffect(() => {
    const el = hero.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setHeroVisible(e?.isIntersecting ?? true), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // the mobile "⋯" menu closes on a tap outside the header or Escape
  const head = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (!head.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const visibleMessages = r.realtime.messages.filter((m) => !dismissed.has(m.id));
  const switchStation = useCallback(
    (slug: string): void => {
      stop();
      r.pick(slug);
    },
    [stop, r],
  );
  const toggleLyrics = (): void =>
    setShowLyrics((v) => {
      saveSetting(LYRICS_KEY, v ? '0' : '1');
      return !v;
    });

  const brand = station?.title ?? t('player.title');
  const air = reconnecting ? 'reconnecting' : onAir || ad ? 'on' : 'off';
  const qualityLabel = quality === 'low' ? t('player.lowBadge') : qualityPref === 'auto' ? t('player.qualityAutoLabel') : t('player.qualityHighLabel');

  return (
    <div className="pl" data-playing={sounding}>
      <Rain />
      <div className="pl-page">
        <header ref={head} className="pl-head">
          <div className="pl-brand">
            <span className="pl-logo" aria-hidden />
            <span className="pl-brand-name">{brand}</span>
            <span className={`pl-onair ${air}`}>
              <i aria-hidden />
              {air === 'reconnecting' ? t('player.reconnecting') : air === 'on' ? t('player.onAir') : t('player.offAir')}
            </span>
          </div>
          <button className="pl-more" aria-label={t('player.menu')} aria-expanded={menuOpen} aria-controls="pl-menu" onClick={() => setMenuOpen((o) => !o)}>
            ⋯
          </button>
          <div id="pl-menu" className="pl-menu" data-open={menuOpen}>
            {install.canInstall && (
              <button className="pl-link" onClick={install.install}>
                {t('player.install')}
              </button>
            )}
            <a className="pl-link" href="/partner">
              {t('player.advertise')}
            </a>
            {lowAvailable && (
              <span className="pl-select">
                <select
                  value={qualityPref}
                  aria-label={t('player.quality')}
                  onChange={(e) => {
                    const q = e.target.value as QualityPref;
                    setQualityPref(q);
                    saveQuality(q);
                  }}
                >
                  <option value="auto">{t('player.qualityAuto')}</option>
                  <option value="high">{t('player.qualityHigh')}</option>
                  <option value="low">{t('player.qualityLow')}</option>
                </select>
              </span>
            )}
            <span className="pl-select">
              <LanguageSwitcher />
            </span>
            {!lockedSlug && r.stations && r.stations.length > 1 && (
              <span className="pl-select">
                <select value={r.slug ?? ''} onChange={(e) => switchStation(e.target.value)} aria-label={t('player.station')}>
                  {r.stations.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.title}
                      {s.live ? '' : ` (${t('player.offline')})`}
                    </option>
                  ))}
                </select>
              </span>
            )}
          </div>
        </header>

        {visibleMessages.length > 0 && (
          <div className="pl-messages" role="region" aria-label={t('player.announcements')}>
            {visibleMessages.map((m: LiveMessage) => (
              <div key={m.id} className={`pl-message${m.level === 'WARN' ? ' warn' : ''}`} role="status">
                <span>{m.text}</span>
                <button className="pl-x" aria-label={t('player.dismiss')} onClick={() => setDismissed((d) => new Set(d).add(m.id))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {r.stations && r.stations.length === 0 && !lockedSlug && <p className="pl-note">{t('player.noStation')}</p>}
        {unknownStation && (
          <p className="pl-note" role="alert">
            {t('player.stationNotFound')}
          </p>
        )}

        <main ref={hero} className="pl-hero" data-testid={ad ? 'ad-card' : undefined}>
          <Vinyl spinning={sounding} label={brand} sub={t('player.vinylSide')} image={ad?.imageUrl} />
          <div className="pl-now">
            {ad ? (
              <AdNow ad={ad} elapsed={adElapsed} />
            ) : onAir && c ? (
              <>
                <div className="pl-heading">
                  <span className="pl-eyebrow">{t('player.nowPlaying')}</span>
                  <h1 className={`pl-title${titleSize(c.title)}`}>{c.title}</h1>
                  <div className="pl-byline">
                    {c.artist && <span className="pl-artist">{c.artist}</span>}
                    {c.album && <span className="pl-source">{c.album}</span>}
                  </div>
                </div>
                <Progress value={position} max={c.duration} />
              </>
            ) : c === undefined || c === null ? (
              <div className="pl-heading pl-skeleton" aria-label={t('player.loading')}>
                <span className="pl-eyebrow">{t('player.nowPlaying')}</span>
                <span className="pl-skel title" />
                <span className="pl-skel line" />
              </div>
            ) : (
              <div className="pl-heading">
                <span className="pl-eyebrow">{t('player.offAir')}</span>
                <p className="pl-waiting">{t('player.waiting')}</p>
              </div>
            )}

            <div className="pl-controls">
              <PlayButton playing={playing} buffering={buffering} disabled={!r.base} onClick={toggle} />
              <button className={`pl-lyr-btn${showLyrics ? ' on' : ''}`} aria-pressed={showLyrics} onClick={toggleLyrics}>
                <span className="pl-quote" aria-hidden>
                  “
                </span>
                {t('player.lyrics')}
              </button>
              <label className="pl-vol">
                <span className="pl-vol-label" aria-hidden>
                  {t('player.vol')}
                </span>
                <input type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label={t('player.volume')} style={{ '--v': `${volume}%` } as CSSProperties} />
              </label>
            </div>
            {error && (
              <p className="pl-error" role="alert">
                {t('player.streamError')}
              </p>
            )}

            <div className="pl-stats" data-testid="live-meta">
              {r.realtime.listeners !== null && (
                <span>
                  <i className="pl-dot" aria-hidden />
                  {t('player.listening', { n: r.realtime.listeners })}
                </span>
              )}
              {r.realtime.clients !== null && r.realtime.clients > 0 && (
                <span>
                  <i className="pl-dot ring" aria-hidden />
                  {t('player.online', { n: r.realtime.clients })}
                </span>
              )}
              {lowAvailable && (
                <span className="pl-upper" title={quality === 'low' ? t('player.lowHint') : undefined}>
                  {qualityLabel}
                </span>
              )}
              {playing && <span title={t('player.transportHint')}>{activeTransport === 'WEBSOCKET' ? t('player.viaSocket') : t('player.viaHttp')}</span>}
            </div>
          </div>
        </main>

        <Visualizer analyser={analyser} playing={sounding} />

        {showLyrics && !ad && <LyricsCard lyrics={r.lyrics} title={onAir ? c?.title : undefined} artist={c?.artist} duration={c?.duration} position={position} positionAt={positionAt} onAir={onAir} playing={sounding} />}

        {((r.vote && r.vote.status !== 'NONE') || sponsor) && (
          <section className="pl-grid">
            {r.vote && <VoteCard vote={r.vote} now={now} fetchedAt={fetchedAt} onVote={r.cast} />}
            {sponsor && <SponsorCard sponsor={sponsor} />}
          </section>
        )}
      </div>

      {!heroVisible && (onAir || ad) && (
        <div className="pl-mini">
          <div className="pl-mini-text">
            <b>{ad ? ad.name : c?.title}</b>
            <span>{ad ? t('player.sponsoredAudio') : c?.artist}</span>
          </div>
          <PlayButton playing={playing} buffering={buffering} disabled={!r.base} onClick={toggle} compact />
        </div>
      )}
      <audio ref={audio} preload="none" />
    </div>
  );
}
