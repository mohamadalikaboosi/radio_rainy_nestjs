import { ParsedCaption } from '../../domain/caption-parser';
import { TelegramAudioMessage } from './telegram.types';
import { LyricsStatus, Track } from '../../domain/track.types';

export type UpsertOutcome = 'created' | 'updated' | 'unchanged' | 'restored';

export interface UpsertResult {
  trackId: string;
  outcome: UpsertOutcome;
  /** true for new tracks with a URL, and when the URL changed: lyrics need (re)fetching. */
  lyricsNeedsFetch: boolean;
}

export abstract class TrackRepository {
  /** Idempotent: the (channel, message) unique key guarantees a single row however often sync runs. */
  abstract upsertFromTelegram(msg: TelegramAudioMessage, parsed: ParsedCaption): Promise<UpsertResult>;
  abstract listActiveMessageIds(channelId: string): Promise<{ id: string; messageId: number }[]>;
  abstract markUnavailable(channelId: string, messageIds: readonly number[]): Promise<number>;
  abstract getSyncState(channelId: string): Promise<{ lastMessageId: number }>;
  abstract saveSyncState(channelId: string, lastMessageId: number, full: boolean): Promise<void>;
  abstract findById(id: string): Promise<Track | null>;
  /** Telegram identity needed to download audio and to key transcript caches. */
  abstract getFileIdentity(trackId: string): Promise<{ messageId: number; channelId: string; fileReference: string; fileSize: number | null } | null>;
  abstract setLyricsStatus(trackId: string, status: LyricsStatus, error?: string | null): Promise<void>;
  /** Playback bookkeeping: reset failures on success, mark FAILED after `maxFailures` consecutive errors. */
  abstract recordPlaybackResult(trackId: string, ok: boolean, maxFailures?: number): Promise<void>;
  abstract setLyricsLanguage(trackId: string, lang: string): Promise<void>;
  abstract getLyricsLanguage(trackId: string): Promise<'fa' | 'en' | 'mixed' | 'unknown' | null>;
  /** What identifies the stored audio of a message: document id + size come from the file reference. */
  abstract getAudioIdentity(channelId: string, messageId: number): Promise<{ fileReference: string; fileSize: number | null } | null>;
  /** Hashtags of a track (admin detail view). */
  abstract hashtagsOf(trackId: string): Promise<{ value: string; normalized: string }[]>;
  /** Admin-only columns that are not part of the public Track. */
  abstract adminExtra(trackId: string): Promise<{ captionRaw: string | null; lyricsError: string | null; deletedAt: Date | null; consecutiveFailures: number } | null>;
  /** Idempotent and race-safe: one conditional UPDATE decides whether anything changed (true = it changed). */
  abstract setEnabled(trackId: string, enabled: boolean): Promise<boolean>;
  /** The track vanished from Telegram: mark it unavailable (soft delete). */
  abstract markDeleted(trackId: string): Promise<void>;
  /** Titles/artists for a set of tracks (previews). */
  abstract titlesOf(trackIds: readonly string[]): Promise<{ id: string; title: string; artist: string | null }[]>;
}
