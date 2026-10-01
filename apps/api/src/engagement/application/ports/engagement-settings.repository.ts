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
