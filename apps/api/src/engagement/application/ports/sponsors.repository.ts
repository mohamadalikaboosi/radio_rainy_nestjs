export interface Sponsor {
  id: string;
  channelId: string | null;
  name: string;
  tagline: string | null;
  url: string;
  ctaLabel: string;
  hasLogo: boolean;
  weight: number;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  impressions: number;
  clicks: number;
}

export interface SponsorInput {
  channelId: string | null;
  name: string;
  tagline: string | null;
  url: string;
  ctaLabel: string;
  weight: number;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export abstract class SponsorsRepository {
  abstract list(channelId?: string): Promise<Sponsor[]>;
  abstract get(id: string): Promise<Sponsor | null>;
  abstract create(i: SponsorInput): Promise<Sponsor>;
  abstract update(id: string, patch: Partial<SponsorInput>): Promise<Sponsor | null>;
  abstract remove(id: string): Promise<boolean>;
  abstract setLogo(id: string, data: Buffer | null, mime: string | null): Promise<boolean>;
  abstract logo(id: string): Promise<{ data: Buffer; mime: string } | null>;
  /** Sponsors to show right now on a station. */
  abstract active(channelId: string, now?: Date): Promise<Sponsor[]>;
  abstract recordImpressions(ids: string[]): Promise<void>;
  abstract click(id: string): Promise<string | null>;
}
