export type TrackStatus = 'READY' | 'FAILED' | 'UNAVAILABLE';
export type LyricsStatus = 'LYRICS_NONE' | 'LYRICS_PENDING' | 'LYRICS_PROCESSING' | 'LYRICS_READY' | 'LYRICS_FAILED';

export interface Track {
  id: string;
  telegramChannelId: string;
  telegramMessageId: number;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  mimeType: string | null;
  fileSize: number | null;
  telegramPostUrl: string | null;
  lyricsUrl: string | null;
  status: TrackStatus;
  lyricsStatus: LyricsStatus;
  enabled: boolean;
  playCount: number;
  lastPlayedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrackRow {
  id: string;
  telegram_channel_id: string;
  telegram_message_id: number;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  mime_type: string | null;
  file_size: string | null;
  telegram_post_url: string | null;
  lyrics_url: string | null;
  status: TrackStatus;
  lyrics_status: LyricsStatus;
  enabled: boolean;
  play_count: number;
  last_played_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const TRACK_COLUMNS = `id, telegram_channel_id, telegram_message_id, title, artist, album, duration, mime_type, file_size,
  telegram_post_url, lyrics_url, status, lyrics_status, enabled, play_count, last_played_at, created_at, updated_at`;

export function mapTrack(r: TrackRow): Track {
  return {
    id: r.id,
    telegramChannelId: r.telegram_channel_id,
    telegramMessageId: r.telegram_message_id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    duration: r.duration,
    mimeType: r.mime_type,
    fileSize: r.file_size === null ? null : Number(r.file_size),
    telegramPostUrl: r.telegram_post_url,
    lyricsUrl: r.lyrics_url,
    status: r.status,
    lyricsStatus: r.lyrics_status,
    enabled: r.enabled,
    playCount: r.play_count,
    lastPlayedAt: r.last_played_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
