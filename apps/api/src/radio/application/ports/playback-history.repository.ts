export type EndReason = 'FINISHED' | 'SKIPPED' | 'ERROR' | 'ADMIN' | 'SHUTDOWN';

export abstract class PlaybackHistoryRepository {
  abstract start(trackId: string, startedAt: Date): Promise<string>;
  abstract end(historyId: string, reason: EndReason): Promise<void>;
  /** Most recent first. */
  abstract recentTrackIds(channelId: string, limit: number): Promise<string[]>;
  /** Closes rows left open by a crashed process. */
  abstract closeDangling(): Promise<number>;
  abstract list(channelId: string, limit: number): Promise<{ id: string; trackId: string; title: string; artist: string | null; startedAt: Date; endedAt: Date | null; endReason: string | null }[]>;
}
