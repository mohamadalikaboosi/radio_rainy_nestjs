import { z } from 'zod';

/**
 * Operator switches. `billingEnabled` is OFF by default: everything is free and nothing is ever charged, limited or blocked for money.
 * Turn it on later (panel -> Platform) and the prices / credit checks below start to apply, with no code change.
 */
export interface PlatformSettings {
  billingEnabled: boolean;
  selfSignupEnabled: boolean;
  /** true: a campaign needs the operator's approval before it plays. */
  campaignApprovalRequired: boolean;
  /** Smallest currency unit (e.g. toman/rial/cent). Only used while billingEnabled. */
  pricePerPlayCents: number;
  pricePerClickCents: number;
  currency: string;
  /** 0 = unlimited. */
  maxCampaignsPerAccount: number;
}

export abstract class PlatformSettingsRepository {
  /** Cached for a few seconds: the ad engine asks on every ad. */
  abstract get(): Promise<PlatformSettings>;
  abstract save(s: PlatformSettings): Promise<PlatformSettings>;
}

export const platformSchema = z.object({
  billingEnabled: z.boolean(),
  selfSignupEnabled: z.boolean(),
  campaignApprovalRequired: z.boolean(),
  pricePerPlayCents: z.number().int().min(0).max(1_000_000_000),
  pricePerClickCents: z.number().int().min(0).max(1_000_000_000),
  currency: z.string().trim().min(1).max(8),
  maxCampaignsPerAccount: z.number().int().min(0).max(10_000),
});
