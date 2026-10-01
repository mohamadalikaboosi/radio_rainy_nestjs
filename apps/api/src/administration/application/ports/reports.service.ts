import { z } from 'zod';

export type ReportQuery = z.infer<typeof reportQuerySchema>;

export interface ReportSummary {
  plays: number;
  uniqueTracks: number;
  airtimeSeconds: number;
  outcomes: { finished: number; skipped: number; admin: number; errors: number };
  skipRate: number;
  errorRate: number;
  audience: { averageListeners: number; peakListeners: number; listenerMinutes: number };
}

/** All admin analytics. Plain SQL over indexed tables; every figure is scoped by period and (optionally) one channel. */
export abstract class ReportsService {
  abstract summary(q: ReportQuery): Promise<ReportSummary>;
  abstract timeseries(q: ReportQuery): Promise<{ bucket: 'hour' | 'day'; points: { t: string; plays: number; errors: number; averageListeners: number; peakListeners: number }[] }>;
  abstract top(q: ReportQuery): Promise<{
    tracks: { id: string; title: string; artist: string | null; plays: number; skips: number }[];
    artists: { artist: string; plays: number }[];
    hashtags: { hashtag: string; plays: number }[];
  }>;
  abstract lyrics(q: Pick<ReportQuery, 'channel'>): Promise<{
    byStatus: { status: string; tracks: number }[];
    byLanguage: { language: string; tracks: number }[];
    failureReasons: { reason: string; tracks: number }[];
    quality: { average: number | null; distribution: { bucket: string; tracks: number }[] };
    coverage: { withUrl: number; synced: number };
  }>;
  abstract library(q: Pick<ReportQuery, 'channel'>): Promise<{
    channels: { id: string; title: string; tracks: number; playable: number; disabled: number; failed: number; unavailable: number; totalSeconds: number; neverPlayed: number; plays: number }[];
    problemTracks: { id: string; title: string; artist: string | null; channelId: string; status: string; consecutiveFailures: number; lyricsStatus: string; lyricsError: string | null }[];
    recentErrors: { at: string; trackId: string; title: string; artist: string | null }[];
  }>;
  /** Everything in one call for the Reports page. */
  abstract all(q: ReportQuery): Promise<unknown>;
  /** CSV rows (async generator so large exports never sit in memory). */
  abstract exportCsv(type: 'plays' | 'tracks', q: ReportQuery): AsyncGenerator<string>;
}

export const reportQuerySchema = z.object({
  range: z.enum(['24h', '7d', '30d', '90d']).default('7d'),
  channel: z.string().regex(/^\d{1,20}$/).optional(),
});
