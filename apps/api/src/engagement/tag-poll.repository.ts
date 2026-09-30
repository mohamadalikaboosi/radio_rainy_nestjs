import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

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

interface Row {
  id: string;
  channel_id: string;
  options: string[];
  opens_at: Date;
  closes_at: Date;
  status: 'OPEN' | 'CLOSED';
  winner: string | null;
  play_until: Date | null;
  finished: boolean;
}

const toPoll = (r: Row): TagPoll => ({ id: r.id, channelId: r.channel_id, options: r.options, opensAt: r.opens_at, closesAt: r.closes_at, status: r.status, winner: r.winner, playUntil: r.play_until, finished: r.finished });

export class VoteLimitError extends Error {}

@Injectable()
export class TagPollRepository {
  constructor(private readonly db: DatabaseService) {}

  /** The poll that matters right now: an OPEN one, or a CLOSED one whose winner is still playing. */
  async current(channelId: string): Promise<TagPoll | null> {
    const r = await this.db.query<Row>(
      `SELECT * FROM tag_polls WHERE channel_id = $1 AND (status = 'OPEN' OR (status = 'CLOSED' AND winner IS NOT NULL AND NOT finished)) ORDER BY opens_at DESC LIMIT 1`,
      [channelId],
    );
    return r.rows[0] ? toPoll(r.rows[0]) : null;
  }

  async lastOpenedAt(channelId: string): Promise<Date | null> {
    const r = await this.db.query<{ at: Date | null }>('SELECT max(opens_at) AS at FROM tag_polls WHERE channel_id = $1', [channelId]);
    return r.rows[0]?.at ?? null;
  }

  async recent(channelId: string, limit = 20): Promise<(TagPoll & { tally: Record<string, number> })[]> {
    const polls = (await this.db.query<Row>('SELECT * FROM tag_polls WHERE channel_id = $1 ORDER BY opens_at DESC LIMIT $2', [channelId, limit])).rows.map(toPoll);
    const out: (TagPoll & { tally: Record<string, number> })[] = [];
    for (const p of polls) out.push({ ...p, tally: await this.tally(p.id) });
    return out;
  }

  async open(channelId: string, options: string[], opensAt: Date, closesAt: Date): Promise<TagPoll> {
    const r = await this.db.query<Row>('INSERT INTO tag_polls (channel_id, options, opens_at, closes_at) VALUES ($1,$2,$3,$4) RETURNING *', [channelId, options, opensAt, closesAt]);
    return toPoll(r.rows[0] as Row);
  }

  async close(id: string, winner: string | null, playUntil: Date | null): Promise<void> {
    await this.db.query(`UPDATE tag_polls SET status = 'CLOSED', winner = $2, play_until = $3, finished = ($2::text IS NULL) WHERE id = $1`, [id, winner, playUntil]);
  }

  async finish(id: string): Promise<void> {
    await this.db.query('UPDATE tag_polls SET finished = TRUE WHERE id = $1', [id]);
  }

  async tally(pollId: string): Promise<Record<string, number>> {
    const r = await this.db.query<{ hashtag: string; n: string }>('SELECT hashtag, count(*) AS n FROM tag_votes WHERE poll_id = $1 GROUP BY hashtag', [pollId]);
    return Object.fromEntries(r.rows.map((x) => [x.hashtag, Number(x.n)]));
  }

  async myVote(pollId: string, voterId: string): Promise<string | null> {
    const r = await this.db.query<{ hashtag: string }>('SELECT hashtag FROM tag_votes WHERE poll_id = $1 AND voter_id = $2', [pollId, voterId]);
    return r.rows[0]?.hashtag ?? null;
  }

  /** One vote per voter (changeable); at most `maxPerIp` distinct voters per IP and poll. */
  async vote(pollId: string, voterId: string, ipHash: string, hashtag: string, maxPerIp: number): Promise<void> {
    const existing = await this.myVote(pollId, voterId);
    if (existing === null) {
      const n = Number((await this.db.query<{ n: string }>('SELECT count(*) AS n FROM tag_votes WHERE poll_id = $1 AND ip_hash = $2', [pollId, ipHash])).rows[0]?.n ?? 0);
      if (n >= maxPerIp) throw new VoteLimitError('Too many votes from this network');
    }
    await this.db.query(
      `INSERT INTO tag_votes (poll_id, voter_id, ip_hash, hashtag) VALUES ($1,$2,$3,$4) ON CONFLICT (poll_id, voter_id) DO UPDATE SET hashtag = $4, voted_at = now()`,
      [pollId, voterId, ipHash, hashtag],
    );
  }

  /** Tags with at least `minTracks` playable tracks on this station (display value = normalized value). */
  async candidateTags(channelId: string, allowlist: readonly string[], minTracks: number): Promise<string[]> {
    const r = await this.db.query<{ tag: string }>(
      `SELECT h.normalized_value AS tag
         FROM hashtags h JOIN track_hashtags th ON th.hashtag_id = h.id JOIN tracks t ON t.id = th.track_id
        WHERE t.telegram_channel_id = $1 AND t.status = 'READY' AND t.enabled AND t.deleted_at IS NULL
          AND ($2::text[] = '{}' OR h.normalized_value = ANY($2::text[]))
        GROUP BY h.normalized_value HAVING count(*) >= $3`,
      [channelId, [...allowlist], minTracks],
    );
    return r.rows.map((x) => x.tag);
  }

  async bumpConfigVersion(channelId: string): Promise<void> {
    await this.db.query('UPDATE radio_configuration SET version = version + 1 WHERE channel_id = $1', [channelId]);
  }
}
