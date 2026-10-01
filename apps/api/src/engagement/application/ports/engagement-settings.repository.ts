import { z } from 'zod';

export interface EngagementSettings {
  adsEveryNTracks: number;
  tagVoteEnabled: boolean;
  tagVoteIntervalMinutes: number;
  tagVotePollMinutes: number;
  tagVotePlayMinutes: number;
  tagVoteOptions: number;
  tagVoteAllowlist: string[];
  /** How the public player receives the audio. The HTTP stream URL keeps working either way. */
  audioTransport: 'HTTP' | 'WEBSOCKET';
}

export abstract class EngagementSettingsRepository {
  abstract get(channelId: string): Promise<EngagementSettings>;
  /** channel id -> transport, for every station that has saved settings (others use HTTP). */
  abstract transports(): Promise<Map<string, 'HTTP' | 'WEBSOCKET'>>;
  abstract save(channelId: string, s: EngagementSettings): Promise<EngagementSettings>;
}

export const engagementSchema = z.object({
  adsEveryNTracks: z.number().int().min(0).max(100),
  tagVoteEnabled: z.boolean(),
  tagVoteIntervalMinutes: z.number().int().min(1).max(1440),
  tagVotePollMinutes: z.number().int().min(1).max(60),
  tagVotePlayMinutes: z.number().int().min(1).max(240),
  tagVoteOptions: z.number().int().min(2).max(6),
  tagVoteAllowlist: z.array(z.string().trim().min(1).max(64)).max(100),
  audioTransport: z.enum(['HTTP', 'WEBSOCKET']).default('HTTP'),
});
