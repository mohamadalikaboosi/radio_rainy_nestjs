import { z } from 'zod';

export const trackQuerySchema = z.object({
  channel: z.string().regex(/^\d{1,20}$/).optional(),
  q: z.string().trim().max(200).optional(),
  artist: z.string().trim().max(200).optional(),
  album: z.string().trim().max(200).optional(),
  hashtag: z.string().trim().max(100).optional(),
  lyricsStatus: z.enum(['LYRICS_NONE', 'LYRICS_PENDING', 'LYRICS_PROCESSING', 'LYRICS_READY', 'LYRICS_FAILED']).optional(),
  enabled: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  playback: z.enum(['PLAYABLE', 'DISABLED', 'FAILED', 'UNAVAILABLE']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['createdAt', 'title', 'artist', 'lastPlayedAt', 'playCount']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type TrackQuery = z.infer<typeof trackQuerySchema>;

export interface TrackListItem {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  hashtags: string[];
  lyricsStatus: string;
  enabled: boolean;
  status: string;
  playCount: number;
  lastPlayedAt: Date | null;
  channelId: string;
  telegramMessageId: number;
  telegramPostUrl: string | null;
  lyricsUrl: string | null;
}

export abstract class TrackQueryRepository {
  abstract search(f: TrackQuery): Promise<{ total: number; page: number; pageSize: number; items: TrackListItem[] }>;
}
