import { ReportsService, ReportQuery, ReportSummary } from '../application/ports/reports.service';

import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../shared/infrastructure/database/database.service';

import { SAMPLE_EVERY_SECONDS } from '../../radio/application/listener-sampler';


const RANGES: Record<ReportQuery['range'], { interval: string; bucket: 'hour' | 'day' }> = {
  '24h': { interval: '24 hours', bucket: 'hour' },
  '7d': { interval: '7 days', bucket: 'hour' },
  '30d': { interval: '30 days', bucket: 'day' },
  '90d': { interval: '90 days', bucket: 'day' },
};

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvLine = (cells: readonly unknown[]): string => `${cells.map(csvCell).join(',')}\r\n`;

/** All admin analytics. Plain SQL over indexed tables; every figure is scoped by period and (optionally) one channel. */
@Injectable()
export class PgReportsService implements ReportsService {
  constructor(private readonly db: DatabaseService) {}

  private ch(q: ReportQuery): string | null {
    return q.channel ?? null;
  }

  async summary(q: ReportQuery): Promise<ReportSummary> {
    const { interval } = RANGES[q.range];
    const plays = (
      await this.db.query<{ plays: number; unique_tracks: number; airtime: number; finished: number; skipped: number; admin: number; errors: number }>(
        `SELECT count(*)::int AS plays, count(DISTINCT p.track_id)::int AS unique_tracks,
                COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(p.ended_at, now()) - p.started_at))), 0)::float8 AS airtime,
                count(*) FILTER (WHERE p.end_reason = 'FINISHED')::int AS finished,
                count(*) FILTER (WHERE p.end_reason = 'SKIPPED')::int AS skipped,
                count(*) FILTER (WHERE p.end_reason = 'ADMIN')::int AS admin,
                count(*) FILTER (WHERE p.end_reason = 'ERROR')::int AS errors
           FROM playback_history p JOIN tracks t ON t.id = p.track_id
          WHERE p.started_at >= now() - $2::interval AND ($1::bigint IS NULL OR t.telegram_channel_id = $1)`,
        [this.ch(q), interval],
      )
    ).rows[0];
    const aud = (
      await this.db.query<{ avg: number; peak: number; total: number }>(
        `SELECT COALESCE(avg(total), 0)::float8 AS avg, COALESCE(max(total), 0)::int AS peak, COALESCE(sum(total), 0)::float8 AS total
           FROM (SELECT at, sum(listeners) AS total FROM listener_samples WHERE at >= now() - $2::interval AND ($1::bigint IS NULL OR channel_id = $1) GROUP BY at) x`,
        [this.ch(q), interval],
      )
    ).rows[0];
    const n = plays?.plays ?? 0;
    return {
      plays: n,
      uniqueTracks: plays?.unique_tracks ?? 0,
      airtimeSeconds: Math.round(plays?.airtime ?? 0),
      outcomes: { finished: plays?.finished ?? 0, skipped: plays?.skipped ?? 0, admin: plays?.admin ?? 0, errors: plays?.errors ?? 0 },
      skipRate: n ? (plays?.skipped ?? 0) / n : 0,
      errorRate: n ? (plays?.errors ?? 0) / n : 0,
      audience: { averageListeners: Math.round((aud?.avg ?? 0) * 10) / 10, peakListeners: aud?.peak ?? 0, listenerMinutes: Math.round(((aud?.total ?? 0) * SAMPLE_EVERY_SECONDS) / 60) },
    };
  }

  async timeseries(q: ReportQuery): Promise<{ bucket: 'hour' | 'day'; points: { t: string; plays: number; errors: number; averageListeners: number; peakListeners: number }[] }> {
    const { interval, bucket } = RANGES[q.range];
    const r = await this.db.query<{ t: Date; plays: number; errors: number; avg_l: number; peak: number }>(
      `WITH b AS (SELECT generate_series(date_trunc($3, now() - $2::interval), date_trunc($3, now()), ('1 ' || $3)::interval) AS t)
       SELECT b.t, COALESCE(pl.plays, 0)::int AS plays, COALESCE(pl.errors, 0)::int AS errors,
              COALESCE(ls.avg_l, 0)::float8 AS avg_l, COALESCE(ls.peak, 0)::int AS peak
         FROM b
         LEFT JOIN (SELECT date_trunc($3, p.started_at) AS t, count(*) AS plays, count(*) FILTER (WHERE p.end_reason = 'ERROR') AS errors
                      FROM playback_history p JOIN tracks tr ON tr.id = p.track_id
                     WHERE p.started_at >= now() - $2::interval AND ($1::bigint IS NULL OR tr.telegram_channel_id = $1) GROUP BY 1) pl ON pl.t = b.t
         LEFT JOIN (SELECT date_trunc($3, at) AS t, avg(total) AS avg_l, max(total) AS peak
                      FROM (SELECT at, sum(listeners) AS total FROM listener_samples WHERE at >= now() - $2::interval AND ($1::bigint IS NULL OR channel_id = $1) GROUP BY at) x GROUP BY 1) ls ON ls.t = b.t
        ORDER BY b.t`,
      [this.ch(q), interval, bucket],
    );
    return { bucket, points: r.rows.map((x) => ({ t: x.t.toISOString(), plays: x.plays, errors: x.errors, averageListeners: Math.round(x.avg_l * 10) / 10, peakListeners: x.peak })) };
  }

  async top(q: ReportQuery): Promise<{
    tracks: { id: string; title: string; artist: string | null; plays: number; skips: number }[];
    artists: { artist: string; plays: number }[];
    hashtags: { hashtag: string; plays: number }[];
  }> {
    const { interval } = RANGES[q.range];
    const params = [this.ch(q), interval];
    const where = 'p.started_at >= now() - $2::interval AND ($1::bigint IS NULL OR t.telegram_channel_id = $1)';
    const [tracks, artists, hashtags] = await Promise.all([
      this.db.query<{ id: string; title: string; artist: string | null; plays: number; skips: number }>(
        `SELECT t.id, t.title, t.artist, count(*)::int AS plays, count(*) FILTER (WHERE p.end_reason = 'SKIPPED')::int AS skips
           FROM playback_history p JOIN tracks t ON t.id = p.track_id WHERE ${where} GROUP BY t.id ORDER BY plays DESC, t.title LIMIT 10`, params),
      this.db.query<{ artist: string; plays: number }>(
        `SELECT COALESCE(t.artist, 'Unknown') AS artist, count(*)::int AS plays FROM playback_history p JOIN tracks t ON t.id = p.track_id WHERE ${where} GROUP BY 1 ORDER BY plays DESC, 1 LIMIT 10`, params),
      this.db.query<{ hashtag: string; plays: number }>(
        `SELECT h.value AS hashtag, count(*)::int AS plays FROM playback_history p JOIN tracks t ON t.id = p.track_id
           JOIN track_hashtags th ON th.track_id = t.id JOIN hashtags h ON h.id = th.hashtag_id WHERE ${where} GROUP BY h.value ORDER BY plays DESC, 1 LIMIT 10`, params),
    ]);
    return { tracks: tracks.rows, artists: artists.rows, hashtags: hashtags.rows };
  }

  async lyrics(q: Pick<ReportQuery, 'channel'>): Promise<{
    byStatus: { status: string; tracks: number }[];
    byLanguage: { language: string; tracks: number }[];
    failureReasons: { reason: string; tracks: number }[];
    quality: { average: number | null; distribution: { bucket: string; tracks: number }[] };
    coverage: { withUrl: number; synced: number };
  }> {
    const ch = q.channel ?? null;
    const f = '($1::bigint IS NULL OR t.telegram_channel_id = $1)';
    const [status, lang, reasons, quality, cov] = await Promise.all([
      this.db.query<{ status: string; n: number }>(`SELECT t.lyrics_status AS status, count(*)::int AS n FROM tracks t WHERE ${f} AND t.deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`, [ch]),
      this.db.query<{ language: string; n: number }>(`SELECT COALESCE(t.lyrics_language, 'undetected') AS language, count(*)::int AS n FROM tracks t WHERE ${f} AND t.deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`, [ch]),
      this.db.query<{ reason: string; n: number }>(`SELECT t.lyrics_error AS reason, count(*)::int AS n FROM tracks t WHERE ${f} AND t.lyrics_error IS NOT NULL AND t.lyrics_status IN ('LYRICS_FAILED', 'LYRICS_NONE') GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [ch]),
      this.db.query<{ bucket: string | null; n: number; avg: number | null }>(
        `SELECT CASE WHEN q < 0.5 THEN '<50%' WHEN q < 0.7 THEN '50-70%' WHEN q < 0.9 THEN '70-90%' ELSE '90-100%' END AS bucket, count(*)::int AS n, avg(q)::float8 AS avg
           FROM (SELECT DISTINCT ON (s.track_id) s.quality AS q FROM synced_lyrics s JOIN tracks t ON t.id = s.track_id WHERE ${f} ORDER BY s.track_id, s.version DESC) x GROUP BY 1`, [ch]),
      this.db.query<{ with_url: number; synced: number }>(
        `SELECT count(*) FILTER (WHERE t.lyrics_url IS NOT NULL)::int AS with_url, count(*) FILTER (WHERE t.lyrics_status = 'LYRICS_READY')::int AS synced FROM tracks t WHERE ${f} AND t.deleted_at IS NULL`, [ch]),
    ]);
    const order = ['<50%', '50-70%', '70-90%', '90-100%'];
    const byBucket = new Map(quality.rows.map((r) => [r.bucket, r.n]));
    const total = quality.rows.reduce((s, r) => s + r.n, 0);
    const weighted = quality.rows.reduce((s, r) => s + r.n * (r.avg ?? 0), 0);
    return {
      byStatus: status.rows.map((r) => ({ status: r.status, tracks: r.n })),
      byLanguage: lang.rows.map((r) => ({ language: r.language, tracks: r.n })),
      failureReasons: reasons.rows.map((r) => ({ reason: r.reason, tracks: r.n })),
      quality: { average: total ? Math.round((weighted / total) * 1000) / 1000 : null, distribution: order.map((b) => ({ bucket: b, tracks: byBucket.get(b) ?? 0 })) },
      coverage: { withUrl: cov.rows[0]?.with_url ?? 0, synced: cov.rows[0]?.synced ?? 0 },
    };
  }

  async library(q: Pick<ReportQuery, 'channel'>): Promise<{
    channels: { id: string; title: string; tracks: number; playable: number; disabled: number; failed: number; unavailable: number; totalSeconds: number; neverPlayed: number; plays: number }[];
    problemTracks: { id: string; title: string; artist: string | null; channelId: string; status: string; consecutiveFailures: number; lyricsStatus: string; lyricsError: string | null }[];
    recentErrors: { at: string; trackId: string; title: string; artist: string | null }[];
  }> {
    const ch = q.channel ?? null;
    const [channels, problems, errors] = await Promise.all([
      this.db.query<{ id: string; title: string; tracks: number; playable: number; disabled: number; failed: number; unavailable: number; total_seconds: number; never_played: number; plays: number }>(
        `SELECT c.telegram_channel_id::text AS id, c.title, count(t.id)::int AS tracks,
                count(t.id) FILTER (WHERE t.status = 'READY' AND t.enabled AND t.deleted_at IS NULL)::int AS playable,
                count(t.id) FILTER (WHERE NOT t.enabled)::int AS disabled,
                count(t.id) FILTER (WHERE t.status = 'FAILED')::int AS failed,
                count(t.id) FILTER (WHERE t.status = 'UNAVAILABLE')::int AS unavailable,
                COALESCE(sum(t.duration), 0)::float8 AS total_seconds,
                count(t.id) FILTER (WHERE t.play_count = 0)::int AS never_played, COALESCE(sum(t.play_count), 0)::int AS plays
           FROM channels c LEFT JOIN tracks t ON t.telegram_channel_id = c.telegram_channel_id
          WHERE ($1::bigint IS NULL OR c.telegram_channel_id = $1) GROUP BY c.telegram_channel_id, c.title, c.created_at ORDER BY c.created_at`, [ch]),
      this.db.query<{ id: string; title: string; artist: string | null; channel: string; status: string; consecutive_failures: number; lyrics_status: string; lyrics_error: string | null }>(
        `SELECT t.id, t.title, t.artist, t.telegram_channel_id::text AS channel, t.status, t.consecutive_failures, t.lyrics_status, t.lyrics_error
           FROM tracks t WHERE ($1::bigint IS NULL OR t.telegram_channel_id = $1) AND (t.status IN ('FAILED', 'UNAVAILABLE') OR t.consecutive_failures > 0 OR t.lyrics_status = 'LYRICS_FAILED')
          ORDER BY (t.status = 'FAILED') DESC, t.consecutive_failures DESC, t.updated_at DESC LIMIT 30`, [ch]),
      this.db.query<{ at: Date; id: string; title: string; artist: string | null }>(
        `SELECT p.started_at AS at, t.id, t.title, t.artist FROM playback_history p JOIN tracks t ON t.id = p.track_id
          WHERE p.end_reason = 'ERROR' AND ($1::bigint IS NULL OR t.telegram_channel_id = $1) ORDER BY p.started_at DESC LIMIT 20`, [ch]),
    ]);
    return {
      channels: channels.rows.map((r) => ({ id: r.id, title: r.title, tracks: r.tracks, playable: r.playable, disabled: r.disabled, failed: r.failed, unavailable: r.unavailable, totalSeconds: Math.round(r.total_seconds), neverPlayed: r.never_played, plays: r.plays })),
      problemTracks: problems.rows.map((r) => ({ id: r.id, title: r.title, artist: r.artist, channelId: r.channel, status: r.status, consecutiveFailures: r.consecutive_failures, lyricsStatus: r.lyrics_status, lyricsError: r.lyrics_error })),
      recentErrors: errors.rows.map((r) => ({ at: r.at.toISOString(), trackId: r.id, title: r.title, artist: r.artist })),
    };
  }

  /** Everything in one call for the Reports page. */
  async all(q: ReportQuery): Promise<unknown> {
    const [summary, timeseries, top, lyrics, library] = await Promise.all([this.summary(q), this.timeseries(q), this.top(q), this.lyrics(q), this.library(q)]);
    return { range: q.range, channel: q.channel ?? null, generatedAt: new Date().toISOString(), summary, timeseries, top, lyrics, library };
  }

  /** CSV rows (async generator so large exports never sit in memory). */
  async *exportCsv(type: 'plays' | 'tracks', q: ReportQuery): AsyncGenerator<string> {
    if (type === 'plays') {
      yield csvLine(['started_at', 'ended_at', 'channel', 'track_id', 'title', 'artist', 'seconds', 'outcome']);
      const { interval } = RANGES[q.range];
      let offset = 0;
      for (;;) {
        const r = await this.db.query<{ started_at: Date; ended_at: Date | null; channel: string; id: string; title: string; artist: string | null; seconds: number | null; end_reason: string | null }>(
          `SELECT p.started_at, p.ended_at, c.title AS channel, t.id, t.title, t.artist, EXTRACT(EPOCH FROM (p.ended_at - p.started_at))::float8 AS seconds, p.end_reason
             FROM playback_history p JOIN tracks t ON t.id = p.track_id LEFT JOIN channels c ON c.telegram_channel_id = t.telegram_channel_id
            WHERE p.started_at >= now() - $2::interval AND ($1::bigint IS NULL OR t.telegram_channel_id = $1) ORDER BY p.started_at DESC LIMIT 1000 OFFSET $3`,
          [this.ch(q), interval, offset],
        );
        for (const x of r.rows) yield csvLine([x.started_at, x.ended_at, x.channel, x.id, x.title, x.artist, x.seconds === null ? '' : Math.round(x.seconds), x.end_reason ?? 'playing']);
        if (r.rows.length < 1000 || offset >= 200_000) return;
        offset += 1000;
      }
    }
    yield csvLine(['track_id', 'channel', 'title', 'artist', 'album', 'duration_s', 'status', 'enabled', 'lyrics_status', 'lyrics_language', 'plays', 'last_played_at', 'hashtags']);
    let last = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const r = await this.db.query<{ id: string; channel: string | null; title: string; artist: string | null; album: string | null; duration: number | null; status: string; enabled: boolean; lyrics_status: string; lyrics_language: string | null; play_count: number; last_played_at: Date | null; tags: string[] }>(
        `SELECT t.id, c.title AS channel, t.title, t.artist, t.album, t.duration, t.status, t.enabled, t.lyrics_status, t.lyrics_language, t.play_count, t.last_played_at,
                COALESCE((SELECT array_agg(h.value ORDER BY h.value) FROM track_hashtags th JOIN hashtags h ON h.id = th.hashtag_id WHERE th.track_id = t.id), '{}') AS tags
           FROM tracks t LEFT JOIN channels c ON c.telegram_channel_id = t.telegram_channel_id
          WHERE t.id > $2 AND ($1::bigint IS NULL OR t.telegram_channel_id = $1) ORDER BY t.id LIMIT 1000`,
        [this.ch(q), last],
      );
      for (const x of r.rows) yield csvLine([x.id, x.channel, x.title, x.artist, x.album, x.duration, x.status, x.enabled, x.lyrics_status, x.lyrics_language, x.play_count, x.last_played_at, x.tags.join(' ')]);
      if (r.rows.length < 1000) return;
      last = r.rows[r.rows.length - 1]?.id ?? last;
    }
  }
}
