import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RadioBus } from '../radio/radio-bus';
import { Rng, cryptoRng } from '../radio/rng';
import { EngagementSettingsRepository } from './engagement-settings.repository';
import { TagPoll, TagPollRepository } from './tag-poll.repository';

const MAX_VOTERS_PER_IP = 20;
const MIN_TRACKS_PER_TAG = 2;
const VOTER_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface VoteView {
  status: 'NONE' | 'OPEN' | 'PLAYING';
  poll?: { id: string; options: { hashtag: string; votes: number }[]; closesAt: string; totalVotes: number };
  winner?: string;
  playUntil?: string;
  myVote?: string | null;
  serverTime: string;
}

/** Pure: the winner of a tally (most votes; a tie is broken at random); null when nobody voted. */
export function pickWinner(options: readonly string[], tally: Readonly<Record<string, number>>, rng: Rng): string | null {
  let best = 0;
  let leaders: string[] = [];
  for (const o of options) {
    const n = tally[o] ?? 0;
    if (n > best) {
      best = n;
      leaders = [o];
    } else if (n === best && n > 0) leaders.push(o);
  }
  if (best === 0 || leaders.length === 0) return null;
  return leaders[Math.min(leaders.length - 1, Math.floor(rng() * leaders.length))] ?? null;
}

/**
 * The periodic "which tag shall we play?" vote:
 *   every `interval` minutes a poll opens with a few tags -> listeners vote for `poll` minutes ->
 *   the winning tag is played for `play` minutes (the selector switches to HASHTAG_RANDOM on it) -> back to normal.
 * `tick` is driven by the leader; everything else is plain reads/writes usable from any instance.
 */
@Injectable()
export class TagVoteService {
  private readonly logger = new Logger(TagVoteService.name);

  constructor(
    private readonly settings: EngagementSettingsRepository,
    private readonly polls: TagPollRepository,
    private readonly bus: Pick<RadioBus, 'publish'>,
    private readonly rng: Rng = cryptoRng,
    private readonly now: () => number = () => Date.now(),
    /** Tells the live sockets that the vote changed (optional). */
    private readonly events?: { publish(e: { type: 'vote'; channelId: string }): Promise<void> },
  ) {}

  /** The tag that currently overrides the selection (winner still within its play window), or null. */
  async activeTag(channelId: string): Promise<string | null> {
    const p = await this.polls.current(channelId);
    return p && p.status === 'CLOSED' && p.winner && p.playUntil && p.playUntil.getTime() > this.now() ? p.winner : null;
  }

  async tick(channelId: string): Promise<void> {
    const s = await this.settings.get(channelId);
    const now = this.now();
    const cur = await this.polls.current(channelId);

    if (cur?.status === 'OPEN') {
      if (cur.closesAt.getTime() <= now || !s.tagVoteEnabled) await this.closePoll(cur, s.tagVotePlayMinutes);
      return;
    }
    if (cur?.status === 'CLOSED') {
      if (cur.playUntil && cur.playUntil.getTime() <= now) {
        await this.polls.finish(cur.id);
        await this.changed(channelId);
        this.logger.log({ msg: 'tag vote: winner finished', channelId, tag: cur.winner });
        await this.voteChanged(channelId);
      }
      return;
    }
    if (!s.tagVoteEnabled) return;
    const last = await this.polls.lastOpenedAt(channelId);
    if (last && now - last.getTime() < s.tagVoteIntervalMinutes * 60_000) return;
    await this.openPoll(channelId, s.tagVoteOptions, s.tagVotePollMinutes, s.tagVoteAllowlist);
  }

  /** Admin "start a vote now" (ignores the interval). Returns null when there are not enough tags. */
  async startNow(channelId: string): Promise<TagPoll | null> {
    const cur = await this.polls.current(channelId);
    if (cur) return cur;
    const s = await this.settings.get(channelId);
    return this.openPoll(channelId, s.tagVoteOptions, s.tagVotePollMinutes, s.tagVoteAllowlist);
  }

  private async openPoll(channelId: string, count: number, pollMinutes: number, allowlist: readonly string[]): Promise<TagPoll | null> {
    const pool = await this.polls.candidateTags(channelId, allowlist, MIN_TRACKS_PER_TAG);
    if (pool.length < 2) return null;
    const options = shuffle(pool, this.rng).slice(0, Math.min(count, pool.length));
    const opensAt = new Date(this.now());
    const poll = await this.polls.open(channelId, options, opensAt, new Date(opensAt.getTime() + pollMinutes * 60_000));
    this.logger.log({ msg: 'tag vote opened', channelId, options });
    await this.voteChanged(channelId);
    return poll;
  }

  private async closePoll(poll: TagPoll, playMinutes: number): Promise<void> {
    const tally = await this.polls.tally(poll.id);
    const winner = pickWinner(poll.options, tally, this.rng);
    await this.polls.close(poll.id, winner, winner ? new Date(this.now() + playMinutes * 60_000) : null);
    this.logger.log({ msg: 'tag vote closed', channelId: poll.channelId, winner, tally });
    if (winner) await this.changed(poll.channelId);
    await this.voteChanged(poll.channelId);
  }

  private async voteChanged(channelId: string): Promise<void> {
    await this.events?.publish({ type: 'vote', channelId }).catch((e: unknown) => this.logger.warn({ msg: 'vote event publish failed', err: String(e) }));
  }

  private async changed(channelId: string): Promise<void> {
    await this.polls.bumpConfigVersion(channelId);
    await this.bus.publish({ type: 'config-changed', channelId }).catch((e: unknown) => this.logger.warn({ msg: 'config-changed publish failed', err: String(e) }));
  }

  // ---- public ----

  async view(channelId: string, voterId?: string): Promise<VoteView> {
    const serverTime = new Date(this.now()).toISOString();
    const p = await this.polls.current(channelId);
    if (!p) return { status: 'NONE', serverTime };
    if (p.status === 'OPEN') {
      const tally = await this.polls.tally(p.id);
      const options = p.options.map((hashtag) => ({ hashtag, votes: tally[hashtag] ?? 0 }));
      return {
        status: 'OPEN',
        poll: { id: p.id, options, closesAt: p.closesAt.toISOString(), totalVotes: options.reduce((a, o) => a + o.votes, 0) },
        myVote: voterId && VOTER_ID.test(voterId) ? await this.polls.myVote(p.id, voterId) : null,
        serverTime,
      };
    }
    if (p.winner && p.playUntil && p.playUntil.getTime() > this.now()) return { status: 'PLAYING', winner: p.winner, playUntil: p.playUntil.toISOString(), serverTime };
    return { status: 'NONE', serverTime };
  }

  async vote(channelId: string, voterId: string, ip: string, hashtag: string): Promise<VoteView> {
    if (!VOTER_ID.test(voterId)) throw new Error('invalid voter id');
    const p = await this.polls.current(channelId);
    if (!p || p.status !== 'OPEN' || p.closesAt.getTime() <= this.now()) throw new Error('no open vote');
    const tag = hashtag.replace(/^#/, '').toLowerCase();
    if (!p.options.includes(tag)) throw new Error('unknown option');
    const ipHash = createHash('sha256').update(`radio_rainy:${ip}`).digest('hex').slice(0, 16);
    await this.polls.vote(p.id, voterId, ipHash, tag, MAX_VOTERS_PER_IP);
    await this.voteChanged(channelId);
    return this.view(channelId, voterId);
  }
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}
