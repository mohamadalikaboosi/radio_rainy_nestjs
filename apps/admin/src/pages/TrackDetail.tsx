import { useParams } from 'react-router-dom';
import { LyricsStatus, api } from '../api';
import { LYRICS_LABEL, mmss } from '../format';
import { useAsync } from '../hooks';
import { ActionButton, Badge, Card, ErrorBox } from '../ui';

interface Detail {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  enabled: boolean;
  status: string;
  lyricsStatus: LyricsStatus;
  lyricsError: string | null;
  lyricsUrl: string | null;
  telegramMessageId: number;
  telegramChannelId: string;
  telegramPostUrl: string | null;
  captionRaw: string | null;
  playCount: number;
  hashtags: { value: string; normalized: string }[];
  lyrics: { sourceUrl: string; status: string; error: string | null; rawText: string | null } | null;
  syncedLyrics: { version: number; quality: number; algorithmVersion: string; lines: { start: number; end: number; text: string; confidence: number }[] } | null;
}

export function TrackDetail() {
  const { id = '' } = useParams();
  const { data: t, error, reload } = useAsync(() => api<Detail>(`/admin/tracks/${id}`), [id]);
  if (!t) return <ErrorBox error={error} />;
  const act = (path: string, body: unknown = {}, method: 'POST' | 'PATCH' = 'POST') => async (): Promise<void> => {
    await api(path, { method, body });
    reload();
  };

  return (
    <div className="stack">
      <Card title={`${t.artist ? `${t.artist} – ` : ''}${t.title}`} actions={<Badge tone={t.status === 'READY' ? 'good' : 'bad'}>{t.status}</Badge>}>
        <div className="kv">
          <span>Album</span><b>{t.album ?? '—'}</b>
          <span>Duration</span><b>{mmss(t.duration)}</b>
          <span>Plays</span><b>{t.playCount}</b>
          <span>Telegram message</span><b>#{t.telegramMessageId}{t.telegramPostUrl && <> · <a href={t.telegramPostUrl} target="_blank" rel="noreferrer">open post ↗</a></>}</b>
          <span>Lyrics URL</span><b>{t.lyricsUrl ? <a href={t.lyricsUrl} target="_blank" rel="noreferrer">{t.lyricsUrl}</a> : '—'}</b>
          <span>Lyrics status</span><b>{LYRICS_LABEL[t.lyricsStatus]}{t.lyricsError ? ` (${t.lyricsError})` : ''}</b>
          <span>Hashtags</span><b>{t.hashtags.map((h) => `#${h.value}`).join(' ') || '—'}</b>
        </div>
        <div className="row wrap">
          <ActionButton onAction={act(`/admin/tracks/${t.id}/enabled`, { enabled: !t.enabled }, 'PATCH')}>{t.enabled ? 'Disable in radio' : 'Enable in radio'}</ActionButton>
          <ActionButton onAction={act(`/admin/channels/${t.telegramChannelId}/radio/play-next`, { trackId: t.id })} disabled={!t.enabled || t.status !== 'READY'}>▶ Play next</ActionButton>
          {t.lyricsUrl && <ActionButton onAction={act(`/admin/tracks/${t.id}/process-lyrics`, { force: false })}>Process lyrics</ActionButton>}
          {t.lyricsUrl && <ActionButton onAction={act(`/admin/tracks/${t.id}/process-lyrics`, { force: true })} confirm="Re-fetch the Telegraph page and re-run transcription?">Reprocess (force)</ActionButton>}
          <ActionButton onAction={act(`/admin/tracks/${t.id}/refresh-metadata`)}>Refresh Telegram metadata</ActionButton>
        </div>
      </Card>

      {t.captionRaw && <Card title="Telegram caption"><pre className="pre">{t.captionRaw}</pre></Card>}

      <Card title="Synchronized lyrics" actions={t.syncedLyrics && <Badge tone="info">v{t.syncedLyrics.version} · quality {Math.round(t.syncedLyrics.quality * 100)}%</Badge>}>
        {t.syncedLyrics ? (
          <table>
            <thead><tr><th>Start</th><th>End</th><th>Text</th><th>Conf.</th></tr></thead>
            <tbody>
              {t.syncedLyrics.lines.map((l, i) => (
                <tr key={i} className={l.confidence < 0.4 ? 'row-dim' : ''}>
                  <td>{mmss(l.start)}.{String(Math.round((l.start % 1) * 10))}</td>
                  <td>{mmss(l.end)}.{String(Math.round((l.end % 1) * 10))}</td>
                  <td>{l.text}</td>
                  <td>{Math.round(l.confidence * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No synchronized lyrics yet.</p>}
      </Card>

      {t.lyrics?.rawText && <Card title="Raw lyrics (Telegraph)"><pre className="pre">{t.lyrics.rawText}</pre></Card>}
    </div>
  );
}
