import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VoteView } from '../api';
import { mmss } from '../format';
import { LanguageSwitcher, useT } from '../i18n';
import { Equalizer } from './Equalizer';
import './player.css';
import { activeLineIndex, hueOf, pickSponsor, secondsSince, secondsUntil } from './helpers';
import type { SponsorView } from './helpers';
import type { AdOnAir, Current } from './useRadio';
import { useRadio } from './useRadio';
import { wsUrl } from './useRealtime';
import { useInstallPrompt, useMediaSession, usePlayerAudio } from './usePlayerAudio';
import type { LiveMessage } from './useRealtime';

/** A ticking "now" so countdowns / progress move smoothly between the 1 s polls. */
function useNow(ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Progress({ value, max }: { value: number; max: number | null | undefined }) {
  const pct = max && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="pl-progress" role="progressbar" aria-valuemin={0} aria-valuemax={max ?? 0} aria-valuenow={Math.round(value)}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function AdCard({ ad, now, serverTime, fetchedAt }: { ad: AdOnAir; now: number; serverTime: string; fetchedAt: number }) {
  const t = useT();
  const elapsed = ad.startedAt ? secondsSince(ad.startedAt, serverTime, fetchedAt, now) : 0;
  return (
    <div className="pl-ad" data-testid="ad-card">
      <span className="pl-tag">{t('player.sponsoredAudio')}</span>
      {ad.imageUrl && <img className="pl-ad-img" src={ad.imageUrl} alt="" loading="lazy" />}
      <div className="pl-ad-name">{ad.name}</div>
      {ad.duration ? <Progress value={elapsed} max={ad.duration} /> : null}
      {ad.linkUrl && (
        <a className="pl-cta" href={ad.linkUrl} target="_blank" rel="noopener noreferrer sponsored">
          {ad.ctaLabel || t('player.learnMore')}
        </a>
      )}
    </div>
  );
}

export function VoteCard({ vote, now, fetchedAt, onVote }: { vote: VoteView; now: number; fetchedAt: number; onVote: (tag: string) => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (vote.status === 'PLAYING' && vote.winner && vote.playUntil) {
    const left = secondsUntil(vote.playUntil, vote.serverTime, fetchedAt, now);
    return (
      <div className="pl-card pl-vote pl-vote-playing" data-testid="vote-playing">
        <span className="pl-tag">{t('vote.chosen')}</span>
        <div className="pl-vote-title">{t('vote.nowPlaying', { tag: `#${vote.winner}` })}</div>
        <div className="pl-muted">{t('vote.timeLeft', { time: mmss(left) })}</div>
      </div>
    );
  }
  if (vote.status !== 'OPEN' || !vote.poll) return null;
  const left = secondsUntil(vote.poll.closesAt, vote.serverTime, fetchedAt, now);
  const total = Math.max(1, vote.poll.totalVotes);
  return (
    <div className="pl-card pl-vote" data-testid="vote-open">
      <div className="pl-vote-head">
        <span className="pl-tag">{t('vote.title')}</span>
        <span className="pl-muted">{t('vote.closesIn', { time: mmss(left) })}</span>
      </div>
      <div className="pl-vote-options">
        {vote.poll.options.map((o) => (
          <button
            key={o.hashtag}
            className={`pl-vote-option ${vote.myVote === o.hashtag ? 'mine' : ''}`}
            disabled={busy}
            aria-pressed={vote.myVote === o.hashtag}
            onClick={() => {
              setBusy(true);
              void onVote(o.hashtag).finally(() => setBusy(false));
            }}
          >
            <span className="pl-vote-bar" style={{ width: `${(o.votes / total) * 100}%` }} />
            <span className="pl-vote-label">#{o.hashtag}</span>
            <span className="pl-vote-count">{t('vote.votes', { n: o.votes })}</span>
          </button>
        ))}
      </div>
      <div className="pl-muted">{vote.myVote ? t('vote.yourVote', { tag: `#${vote.myVote}` }) : t('vote.tapToVote')}</div>
    </div>
  );
}

export function SponsorCard({ sponsor }: { sponsor: SponsorView }) {
  const t = useT();
  return (
    <aside className="pl-card pl-sponsor" data-testid="sponsor">
      <span className="pl-tag">{t('player.sponsor')}</span>
      <div className="pl-sponsor-row">
        {sponsor.logoUrl && <img src={sponsor.logoUrl} alt="" className="pl-sponsor-logo" loading="lazy" />}
        <div className="pl-sponsor-text">
          <b>{sponsor.name}</b>
          {sponsor.tagline && <span className="pl-muted">{sponsor.tagline}</span>}
        </div>
        <a className="pl-cta" href={sponsor.url} target="_blank" rel="noopener noreferrer sponsored">
          {sponsor.ctaLabel}
        </a>
      </div>
    </aside>
  );
}

function Lyrics({ c, lyrics, activeIndex, analyser, playing }: { c: Current | null; lyrics: ReturnType<typeof useRadio>['lyrics']; activeIndex: number; analyser: AnalyserNode | null; playing: boolean }) {
  const t = useT();
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [activeIndex]);
  const lines = lyrics?.lines;
  if (lines && lines.length > 0) {
    return (
      <ul className="pl-lyrics" aria-label={t('player.lyrics')}>
        {lines.map((l, i) => (
          <li key={i} ref={activeIndex === i ? activeRef : undefined} className={activeIndex === i ? 'active' : ''}>
            {l.text}
          </li>
        ))}
      </ul>
    );
  }
  // No synchronized lyrics (none, still processing, Whisper off/failed): show the music instead of an empty box.
  return (
    <div className="pl-eq-wrap" data-testid="equalizer">
      <Equalizer analyser={analyser} playing={playing && c?.status === 'PLAYING'} />
      {lyrics?.status === 'PLAIN' && lyrics.plain && (
        <ul className="pl-lyrics pl-lyrics-plain" aria-label={t('player.lyrics')}>
          {lyrics.plain.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Public listener page: one big play button, the radio's live state, lyrics or an equalizer, the vote and sponsors. */
export function Player() {
  const t = useT();
  const r = useRadio();
  const transport = r.realtime.transport ?? r.stations?.find((s) => s.slug === r.slug)?.transport ?? 'HTTP';
  const { audio, playing, analyser, error, toggle, stop, play, active: activeTransport } = usePlayerAudio(r.base ? `${r.base}/stream` : null, { transport, audioSocketUrl: r.slug ? wsUrl(`/radio/${r.slug}/audio`) : null });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const install = useInstallPrompt();
  const now = useNow();
  const c = r.current;
  const onAir = c?.status === 'PLAYING';
  const isAd = c?.status === 'AD' && c.ad;
  const hue = useMemo(() => hueOf(c?.trackId ?? c?.title ?? 'radio'), [c?.trackId, c?.title]);

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
  const position = onAir && c?.startedAt ? Math.min(c.duration ?? Infinity, secondsSince(c.startedAt, serverTime, fetchedAt, now)) : 0;
  const lines = r.lyrics?.lines;
  // the browser finds the active line from the server clock: no per-line polling
  const activeIndex = lines && lines.length > 0 && onAir ? activeLineIndex(lines, position) : (r.active?.index ?? -1);
  const visibleMessages = r.realtime.messages.filter((m) => !dismissed.has(m.id));
  const switchStation = useCallback((slug: string): void => {
    stop();
    r.pick(slug);
  }, [stop, r]);

  return (
    <div className="pl" style={{ ['--pl-hue' as string]: hue }} data-playing={playing}>
      <div className="pl-bg" aria-hidden />
      <header className="pl-top">
        <div className="pl-brand">🌧 {t('player.title')}</div>
        <div className="pl-top-actions">
          {install.canInstall && (
            <button className="pl-chip" onClick={install.install}>
              ⬇ {t('player.install')}
            </button>
          )}
          <a className="pl-chip" href="/partner">
            {t('player.advertise')}
          </a>
          <LanguageSwitcher className="pl-chip pl-select" />
          {r.stations && r.stations.length > 1 && (
            <select className="pl-chip pl-select" value={r.slug ?? ''} onChange={(e) => switchStation(e.target.value)} aria-label={t('player.station')}>
              {r.stations.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.title}
                  {s.live ? '' : ` (${t('player.offline')})`}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {visibleMessages.length > 0 && (
        <div className="pl-messages" role="region" aria-label={t('player.announcements')}>
          {visibleMessages.map((m: LiveMessage) => (
            <div key={m.id} className={`pl-message ${m.level === 'WARN' ? 'warn' : ''}`} role="status">
              <span>{m.text}</span>
              <button className="pl-x" aria-label={t('player.dismiss')} onClick={() => setDismissed((d) => new Set(d).add(m.id))}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <main className="pl-main">
        <section className="pl-stage">
          {r.stations && r.stations.length === 0 && <p className="pl-muted">{t('player.noStation')}</p>}
          {isAd && c?.ad ? (
            <AdCard ad={c.ad} now={now} serverTime={serverTime} fetchedAt={fetchedAt} />
          ) : (
            <div className="pl-now">
              <div className={`pl-art ${playing ? 'spin' : ''}`} aria-hidden>
                <span>♪</span>
              </div>
              {onAir && c ? (
                <>
                  <h1 className="pl-title">{c.title}</h1>
                  <div className="pl-artist">{c.artist}</div>
                  <Progress value={position} max={c.duration} />
                  <div className="pl-times">
                    <span>{mmss(position)}</span>
                    <span>{mmss(c.duration)}</span>
                  </div>
                </>
              ) : (
                <p className="pl-muted">{c ? t('player.waiting') : t('player.loading')}</p>
              )}
            </div>
          )}

          <button className="pl-play" onClick={toggle} aria-pressed={playing} disabled={!r.base} aria-label={playing ? t('player.pause') : t('player.listenLive')}>
            <span aria-hidden>{playing ? '❚❚' : '▶'}</span>
            <span>{playing ? t('player.pause') : t('player.listenLive')}</span>
          </button>
          {error && <p className="pl-error" role="alert">{t('player.streamError')}</p>}
          <div className="pl-meta" data-testid="live-meta">
            {r.realtime.listeners !== null && <span className="pl-chip-mini">👥 {t('player.listening', { n: r.realtime.listeners })}</span>}
            {r.realtime.clients !== null && r.realtime.clients > 0 && <span className="pl-chip-mini">🟢 {t('player.online', { n: r.realtime.clients })}</span>}
            {playing && <span className="pl-chip-mini" title={t('player.transportHint')}>{activeTransport === 'WEBSOCKET' ? t('player.viaSocket') : t('player.viaHttp')}</span>}
          </div>
          <audio ref={audio} preload="none" />
        </section>

        <section className="pl-side">
          {!isAd && <Lyrics c={c} lyrics={r.lyrics} activeIndex={activeIndex} analyser={analyser} playing={playing} />}
          {isAd && (
            <div className="pl-eq-wrap">
              <Equalizer analyser={analyser} playing={playing} />
            </div>
          )}
          {r.vote && <VoteCard vote={r.vote} now={now} fetchedAt={fetchedAt} onVote={r.cast} />}
          {sponsor && <SponsorCard sponsor={sponsor} />}
        </section>
      </main>
    </div>
  );
}
