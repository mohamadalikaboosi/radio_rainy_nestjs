import { RadioStatus } from '../../domain/radio.types';

export interface RadioStateRow {
  status: RadioStatus;
  statusReason: string | null;
  currentTrackId: string | null;
  currentHistoryId: string | null;
  startedAt: Date | null;
  nextTrackId: string | null;
  rotationCursor: number;
  configurationVersion: number;
  transitionSeq: number;
  adId: string | null;
  adStartedAt: Date | null;
}

/** Per-station playback state. Every method is scoped by the Telegram channel id. */
export abstract class RadioStateRepository {
  abstract get(channelId: string): Promise<RadioStateRow>;
  /** Marks a new track as playing and bumps transition_seq (the optimistic token for skip / play-next). */
  abstract beginTrack(channelId: string, trackId: string, historyId: string, startedAt: Date): Promise<number>;
  abstract setStatus(channelId: string, status: RadioStatus, reason: string | null): Promise<void>;
  /** An ad is on air (the public API reports it instead of the track). */
  abstract setAd(channelId: string, adId: string | null, startedAt: Date | null): Promise<void>;
  abstract setNext(channelId: string, trackId: string | null): Promise<void>;
  abstract setRotationCursor(channelId: string, cursor: number): Promise<void>;
}
