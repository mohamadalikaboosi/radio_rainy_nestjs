import { AlignedLine } from '../../domain/lyrics-aligner';
import { Transcript } from '../../domain/transcription.types';

export interface StoredLyrics {
  trackId: string;
  sourceUrl: string;
  rawText: string | null;
  status: 'PENDING' | 'FETCHED' | 'FAILED';
  error: string | null;
  fetchedAt: Date | null;
  expiresAt: Date | null;
}

export interface StoredSyncedLyrics {
  id: string;
  trackId: string;
  version: number;
  lines: AlignedLine[];
  quality: number;
  algorithmVersion: string;
  createdAt: Date;
}

export interface StoredTranscript extends Transcript {
  id: string;
}

export abstract class LyricsRepository {
  abstract getLyrics(trackId: string): Promise<StoredLyrics | null>;
  /** Same Telegraph page reused by other tracks: avoids fetching it again while the cache is fresh. */
  abstract findFreshRawByUrl(url: string): Promise<string | null>;
  abstract saveFetched(trackId: string, url: string, rawText: string, ttlSeconds: number): Promise<void>;
  abstract saveFetchFailure(trackId: string, url: string, error: string): Promise<void>;
  abstract getTranscript(trackId: string, audioHash: string, provider: string, model: string): Promise<StoredTranscript | null>;
  abstract getTranscriptById(id: string): Promise<StoredTranscript | null>;
  abstract saveTranscript(trackId: string, audioHash: string, t: Transcript): Promise<string>;
  abstract getLatestSynced(trackId: string): Promise<StoredSyncedLyrics | null>;
  /** Idempotent: identical lines as the latest version create no new version. */
  abstract saveSynced(trackId: string, lines: AlignedLine[], quality: number, algorithmVersion: string, transcriptId: string | null): Promise<StoredSyncedLyrics>;
}
