import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service';

export interface EngagementSettings {
  adsEveryNTracks: number;
  tagVoteEnabled: boolean;
  tagVoteIntervalMinutes: number;
  tagVotePollMinutes: number;
  tagVotePlayMinutes: number;
  tagVoteOptions: number;
  tagVoteAllowlist: string[];
}

export const DEFAULT_ENGAGEMENT: EngagementSettings = {
  adsEveryNTracks: 0,
  tagVoteEnabled: false,
  tagVoteIntervalMinutes: 60,
  tagVotePollMinutes: 3,
  tagVotePlayMinutes: 20,
  tagVoteOptions: 3,
  tagVoteAllowlist: [],
};

export const engagementSchema = z.object({
  adsEveryNTracks: z.number().int().min(0).max(100),
  tagVoteEnabled: z.boolean(),
  tagVoteIntervalMinutes: z.number().int().min(1).max(1440),
  tagVotePollMinutes: z.number().int().min(1).max(60),
  tagVotePlayMinutes: z.number().int().min(1).max(240),
  tagVoteOptions: z.number().int().min(2).max(6),
  tagVoteAllowlist: z.array(z.string().trim().min(1).max(64)).max(100),
});

interface Row {
  ads_every_n_tracks: number;
  tag_vote_enabled: boolean;
  tag_vote_interval_minutes: number;
  tag_vote_poll_minutes: number;
  tag_vote_play_minutes: number;
  tag_vote_options: number;
  tag_vote_allowlist: string[];
}

const normalizeTag = (t: string): string => t.replace(/^#/, '').trim().toLowerCase();

@Injectable()
export class EngagementSettingsRepository {
  constructor(private readonly db: DatabaseService) {}

  async get(channelId: string): Promise<EngagementSettings> {
    const r = (await this.db.query<Row>('SELECT * FROM channel_engagement WHERE channel_id = $1', [channelId])).rows[0];
    if (!r) return { ...DEFAULT_ENGAGEMENT };
    return {
      adsEveryNTracks: r.ads_every_n_tracks,
      tagVoteEnabled: r.tag_vote_enabled,
      tagVoteIntervalMinutes: r.tag_vote_interval_minutes,
      tagVotePollMinutes: r.tag_vote_poll_minutes,
      tagVotePlayMinutes: r.tag_vote_play_minutes,
      tagVoteOptions: r.tag_vote_options,
      tagVoteAllowlist: r.tag_vote_allowlist,
    };
  }

  async save(channelId: string, s: EngagementSettings): Promise<EngagementSettings> {
    const allow = [...new Set(s.tagVoteAllowlist.map(normalizeTag).filter((t) => t.length > 0))];
    await this.db.query(
      `INSERT INTO channel_engagement (channel_id, ads_every_n_tracks, tag_vote_enabled, tag_vote_interval_minutes, tag_vote_poll_minutes, tag_vote_play_minutes, tag_vote_options, tag_vote_allowlist)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (channel_id) DO UPDATE SET ads_every_n_tracks=$2, tag_vote_enabled=$3, tag_vote_interval_minutes=$4, tag_vote_poll_minutes=$5,
         tag_vote_play_minutes=$6, tag_vote_options=$7, tag_vote_allowlist=$8, updated_at=now()`,
      [channelId, s.adsEveryNTracks, s.tagVoteEnabled, s.tagVoteIntervalMinutes, s.tagVotePollMinutes, s.tagVotePlayMinutes, s.tagVoteOptions, allow],
    );
    return this.get(channelId);
  }
}
