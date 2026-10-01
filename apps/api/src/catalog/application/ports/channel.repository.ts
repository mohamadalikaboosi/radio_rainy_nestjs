export type LiveStatus = 'OFF' | 'STARTING' | 'LIVE' | 'ERROR';

/** One Telegram channel = one radio station. `id` is the Telegram channel id (string) used everywhere as the station key. */
export interface ChannelRow {
  id: string;
  reference: string;
  title: string;
  username: string | null;
  slug: string;
  started: boolean;
  telegramLiveEnabled: boolean;
  liveStatus: LiveStatus;
  liveError: string | null;
  /** Manual Telegram live target (URL visible, key never exposed). null = automatic (MTProto). */
  liveRtmpUrl: string | null;
  liveRtmpKeySet: boolean;
  liveTargetRev: number;
  /** Customer account that owns this station (null = run by the operator). */
  ownerAccountId: string | null;
  createdAt: Date;
}

export abstract class ChannelRepository {
  abstract list(): Promise<ChannelRow[]>;
  abstract get(id: string): Promise<ChannelRow | null>;
  abstract bySlug(slug: string): Promise<ChannelRow | null>;
  /** Public "default" station for the legacy /radio/... URLs: the first started one, else the first one. */
  abstract defaultChannel(): Promise<ChannelRow | null>;
  abstract referenceOf(id: string): Promise<string | null>;
  abstract slugExists(slug: string): Promise<boolean>;
  /** Creates the station together with its radio configuration and state rows. */
  abstract insert(input: { id: string; reference: string; title: string; username?: string; slug: string; recentTrackWindow: number }): Promise<ChannelRow>;
  abstract remove(id: string, deleteTracks: boolean): Promise<boolean>;
  abstract setStarted(id: string, started: boolean): Promise<boolean>;
  abstract setLiveEnabled(id: string, enabled: boolean): Promise<boolean>;
  /** `keyEnc` is already encrypted. Both null clears the manual target. Bumps the revision so a running stream reconnects. */
  abstract setLiveTarget(id: string, url: string | null, keyEnc: string | null): Promise<boolean>;
  abstract getLiveTarget(id: string): Promise<{ url: string; keyEnc: string } | null>;
  abstract setOwner(id: string, accountId: string | null): Promise<boolean>;
  abstract ownedBy(accountId: string): Promise<ChannelRow[]>;
  abstract setLiveStatus(id: string, status: LiveStatus, error?: string | null): Promise<void>;
}
