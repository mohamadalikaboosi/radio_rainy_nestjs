export interface TagPoll {
  id: string;
  channelId: string;
  options: string[];
  opensAt: Date;
  closesAt: Date;
  status: 'OPEN' | 'CLOSED';
  winner: string | null;
  playUntil: Date | null;
  finished: boolean;
}

export abstract class TagPollRepository {
  /** The poll that matters right now: an OPEN one, or a CLOSED one whose winner is still playing. */
  abstract current(channelId: string): Promise<TagPoll | null>;
  abstract lastOpenedAt(channelId: string): Promise<Date | null>;
  abstract recent(channelId: string, limit?: number): Promise<(TagPoll & { tally: Record<string, number> })[]>;
  abstract open(channelId: string, options: string[], opensAt: Date, closesAt: Date): Promise<TagPoll>;
  abstract close(id: string, winner: string | null, playUntil: Date | null): Promise<void>;
  abstract finish(id: string): Promise<void>;
  abstract tally(pollId: string): Promise<Record<string, number>>;
  abstract myVote(pollId: string, voterId: string): Promise<string | null>;
  /** One vote per voter (changeable); at most `maxPerIp` distinct voters per IP and poll. */
  abstract vote(pollId: string, voterId: string, ipHash: string, hashtag: string, maxPerIp: number): Promise<void>;
  /** Tags with at least `minTracks` playable tracks on this station (display value = normalized value). */
  abstract candidateTags(channelId: string, allowlist: readonly string[], minTracks: number): Promise<string[]>;
  abstract bumpConfigVersion(channelId: string): Promise<void>;
}

export class VoteLimitError extends Error {}
