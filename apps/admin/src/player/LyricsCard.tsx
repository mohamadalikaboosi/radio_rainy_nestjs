import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { useT } from '../i18n';
import { activeRowIndex, karaokeFill, lyricRows } from './helpers';
import type { Lyrics } from './useRadio';

interface Props {
  lyrics: Lyrics | null | undefined;
  title?: string;
  artist?: string | null;
  duration?: number | null;
  /** Seconds into the track on the server's timeline (re-rendered a few times a second). */
  position: number;
  /** The same, read at any moment: drives the karaoke sweep on animation frames. */
  positionAt: () => number;
  onAir: boolean;
  playing: boolean;
}

/**
 * Live synced lyrics: fixed-height rows, the active one centred with an accent sweep across it while it is sung, the others fading with
 * distance. Plain (unsynchronized) text, a "syncing" skeleton or an empty state when there are no timed lines. Live radio: no seeking.
 */
export function LyricsCard({ lyrics, title, artist, duration, position, positionAt, onAir, playing }: Props) {
  const t = useT();
  const rows = useMemo(() => lyricRows(lyrics?.lines ?? [], duration), [lyrics?.lines, duration]);
  const active = onAir ? activeRowIndex(rows, position) : -1;
  const activeEl = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const row = rows[active];
    const el = activeEl.current;
    if (!row || !el) return;
    let raf = 0;
    const tick = (): void => {
      el.style.setProperty('--fill', `${(karaokeFill(row, positionAt()) * 100).toFixed(2)}%`);
      if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [rows, active, positionAt]);

  const status = rows.length > 0 ? (playing ? t('player.lyricsLive') : t('player.lyricsPaused')) : lyrics?.status === 'PLAIN' ? t('player.lyricsPlain') : lyrics?.status === 'PENDING' || lyrics?.status === 'PROCESSING' ? t('player.lyricsSyncing') : null;

  let body;
  if (rows.length > 0) {
    body = (
      <div className="pl-ly-view">
        <ol className="pl-ly-list" style={{ '--ai': Math.max(0, active) } as CSSProperties} aria-label={t('player.lyrics')}>
          {rows.map((row, i) => {
            const d = active < 0 ? i + 1 : i - active;
            const style: CSSProperties = d === 0 ? {} : { opacity: Math.max(0.12, 0.5 - Math.abs(d) * 0.12), transform: 'scale(.94)', filter: Math.abs(d) > 2 ? 'blur(1px)' : undefined };
            return (
              <li key={i} className="pl-ly-row" style={style}>
                <span ref={d === 0 ? activeEl : undefined} className={`pl-ly-line${d === 0 ? ' active' : ''}${row.gap ? ' gap' : ''}`} title={row.gap ? t('player.instrumental') : undefined}>
                  {row.gap ? '• • •' : row.text}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  } else if (lyrics?.status === 'PLAIN' && lyrics.plain?.length) {
    body = (
      <ul className="pl-ly-plain" aria-label={t('player.lyrics')}>
        {lyrics.plain.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    );
  } else if (lyrics === undefined || lyrics?.status === 'PENDING' || lyrics?.status === 'PROCESSING') {
    body = (
      <div className="pl-ly-skeleton" aria-hidden>
        <span />
        <span />
        <span />
      </div>
    );
  } else {
    body = <p className="pl-ly-empty">{t('player.noLyrics')}</p>;
  }

  return (
    <section className="pl-lyrics" data-testid="lyrics-card">
      <div className="pl-ly-head">
        <div className="pl-ly-titles">
          <h2 className="pl-card-title">{t('player.lyrics')}</h2>
          {title && <span className="pl-ly-track">{artist ? `${title} — ${artist}` : title}</span>}
        </div>
        {status && (
          <span className={`pl-ly-status${playing && rows.length > 0 ? ' live' : ''}`}>
            <i aria-hidden />
            {status}
          </span>
        )}
      </div>
      {body}
    </section>
  );
}
