import type { CampaignStatus } from '../../../accounts/domain/campaign-status';

/** What the ad engine needs to know about money; while billing is off nothing is ever charged or blocked. */
export interface BillingRule {
  enabled: boolean;
  pricePerPlayCents: number;
  pricePerClickCents: number;
}

export interface AdSummary {
  id: string;
  channelId: string | null;
  accountId: string | null;
  status: CampaignStatus;
  reviewNote: string | null;
  startsAt: string | null;
  endsAt: string | null;
  maxPlays: number | null;
  name: string;
  weight: number;
  enabled: boolean;
  linkUrl: string | null;
  ctaLabel: string | null;
  hasAudio: boolean;
  audioMime: string | null;
  audioSize: number | null;
  durationSeconds: number | null;
  hasImage: boolean;
  plays: number;
  clicks: number;
  lastPlayedAt: string | null;
  createdAt: string;
}

export interface AdInput {
  channelId: string | null;
  name: string;
  weight: number;
  enabled: boolean;
  linkUrl: string | null;
  ctaLabel: string | null;
}

export interface AdAudio {
  id: string;
  name: string;
  data: Buffer;
  mime: string;
  bytesPerSec: number | null;
  linkUrl: string | null;
  ctaLabel: string | null;
  hasImage: boolean;
  durationSeconds: number | null;
}

/** Never selects the audio/image blobs except where a method says so. */
export abstract class AdsRepository {
  abstract list(channelId?: string): Promise<AdSummary[]>;
  abstract get(id: string): Promise<AdSummary | null>;
  abstract create(input: AdInput): Promise<AdSummary>;
  abstract update(id: string, input: Partial<AdInput>): Promise<AdSummary | null>;
  abstract remove(id: string): Promise<boolean>;
  abstract setAudio(id: string, data: Buffer, mime: string, bytesPerSec: number | null, durationSeconds: number | null): Promise<boolean>;
  abstract setImage(id: string, data: Buffer | null, mime: string | null): Promise<boolean>;
  abstract image(id: string): Promise<{ data: Buffer; mime: string } | null>;
  /**
  * Ads that may go on air on this station right now: enabled, with audio, APPROVED, inside their dates and play cap, owner active and
  * (only when billing is on) with enough credit for one more play. Admin-created ads have no owner and are never money-gated.
  */
  abstract playableIds(channelId: string, billing?: BillingRule): Promise<{ id: string; weight: number }[]>;
  abstract audio(id: string): Promise<AdAudio | null>;
  /** Counts the play and, when billing is on and the ad belongs to an account, charges it (one transaction). */
  abstract recordPlay(id: string, billing?: BillingRule): Promise<void>;
  /** Public view data for the ad on air (no blobs). */
  abstract onAir(id: string): Promise<{ id: string; name: string; linkUrl: string | null; ctaLabel: string | null; hasImage: boolean; durationSeconds: number | null } | null>;
  /** Counts a click (charging the owner when billing is on) and returns the target: only ever an http(s) URL chosen by the advertiser/admin. */
  abstract click(id: string, billing?: BillingRule): Promise<string | null>;
  // ---- campaigns (ads owned by an account) ----
  abstract listByAccount(accountId: string): Promise<AdSummary[]>;
  abstract countByAccount(accountId: string): Promise<number>;
  abstract listForReview(status?: CampaignStatus): Promise<(AdSummary & { accountName: string })[]>;
  abstract createCampaign(accountId: string, input: { name: string; channelId: string | null; linkUrl: string | null; ctaLabel: string | null; startsAt: string | null; endsAt: string | null; maxPlays: number | null }): Promise<AdSummary>;
  abstract updateCampaign(id: string, patch: { name?: string; channelId?: string | null; linkUrl?: string | null; ctaLabel?: string | null; startsAt?: string | null; endsAt?: string | null; maxPlays?: number | null }): Promise<AdSummary | null>;
  abstract setStatus(id: string, status: CampaignStatus, note: string | null): Promise<AdSummary | null>;
}
