export interface HashtagStatRow {
  hashtagId: string;
  value: string;
  normalized: string;
  trackCount: number;
  playableCount: number;
  failedLyricsCount: number;
  plays: number;
  lastPlayedAt: Date | null;
  createdAt: Date;
}

/** Analytics come from a pre-aggregated table refreshed periodically, never computed per dashboard request. */
export abstract class StatsService {
  abstract start(everyMs?: number): void;
  abstract stop(): void;
  abstract refresh(): Promise<void>;
  abstract hashtags(): Promise<{ items: HashtagStatRow[]; refreshedAt: Date | null }>;
  abstract analytics(): Promise<{
    items: HashtagStatRow[]; refreshedAt: Date | null; mostPlayed: HashtagStatRow[]; noPlayableTracks: HashtagStatRow[]; withFailedLyrics: HashtagStatRow[]; recentlyAdded: HashtagStatRow[];
  }>;
  abstract tracksOf(hashtagId: string): Promise<{ id: string; title: string; artist: string | null; enabled: boolean; status: string }[]>;
}
