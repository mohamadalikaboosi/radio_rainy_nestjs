import { PlatformSettingsRepository, PlatformSettings } from '../application/ports/platform-settings.repository';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';

export const DEFAULT_PLATFORM: PlatformSettings = {
  billingEnabled: false,
  selfSignupEnabled: true,
  campaignApprovalRequired: true,
  pricePerPlayCents: 500,
  pricePerClickCents: 2000,
  currency: 'IRT',
  maxCampaignsPerAccount: 0,
};

export const platformSchema = z.object({
  billingEnabled: z.boolean(),
  selfSignupEnabled: z.boolean(),
  campaignApprovalRequired: z.boolean(),
  pricePerPlayCents: z.number().int().min(0).max(1_000_000_000),
  pricePerClickCents: z.number().int().min(0).max(1_000_000_000),
  currency: z.string().trim().min(1).max(8),
  maxCampaignsPerAccount: z.number().int().min(0).max(10_000),
});

const KEY = 'platform';
const TTL_MS = 5000;

@Injectable()
export class PgPlatformSettingsRepository implements PlatformSettingsRepository {
  private cache: { at: number; value: PlatformSettings } | null = null;

  constructor(private readonly db: DatabaseService, private readonly now: () => number = () => Date.now()) {}

  /** Cached for a few seconds: the ad engine asks on every ad. */
  async get(): Promise<PlatformSettings> {
    if (this.cache && this.now() - this.cache.at < TTL_MS) return this.cache.value;
    const r = await this.db.query<{ value: Partial<PlatformSettings> }>('SELECT value FROM platform_settings WHERE key = $1', [KEY]);
    const value = { ...DEFAULT_PLATFORM, ...(r.rows[0]?.value ?? {}) };
    this.cache = { at: this.now(), value };
    return value;
  }

  async save(s: PlatformSettings): Promise<PlatformSettings> {
    await this.db.query(`INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [KEY, JSON.stringify(s)]);
    this.cache = null;
    return this.get();
  }
}
