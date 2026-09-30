import { freshDb } from '../../test/test-db';
import { DatabaseService } from '../database/database.service';
import { RadioCommand } from '../radio/radio-bus';
import { RadioConfigRepository } from '../radio/radio-config.repository';
import { RadioScheduler } from '../radio/radio-scheduler';
import { RadioStateRepository } from '../radio/radio-state.repository';
import { PlaybackHistoryRepository } from '../playback/playback-history.repository';
import { seededRng } from '../radio/rng';
import { EngagementSettingsRepository } from './engagement-settings.repository';
import { TagPollRepository } from './tag-poll.repository';
import { pickWinner, TagVoteService } from './tag-vote.service';

const MIN = 60_000;

describe('pickWinner', () => {
  it('picks the most voted option, null without votes, and breaks ties among the leaders only', () => {
    const rng = seededRng(3);
    expect(pickWinner(['a', 'b', 'c'], { a: 1, b: 4, c: 2 }, rng)).toBe('b');
    expect(pickWinner(['a', 'b'], {}, rng)).toBeNull();
    const seen = new Set<string | null>();
    for (let i = 0; i < 40; i++) seen.add(pickWinner(['a', 'b', 'c'], { a: 2, b: 2, c: 1 }, seededRng(i)));
    expect([...seen].sort()).toEqual(['a', 'b']);
  });
});

describe('TagVoteService', () => {
  let db: DatabaseService;
  let now: number;
  let published: RadioCommand[];
  let svc: TagVoteService;
  let settings: EngagementSettingsRepository;
  const CH = '1001';

  async function seedTrack(msg: number, tags: string[]): Promise<void> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO tracks (telegram_channel_id, telegram_message_id, title, artist, telegram_file_reference, mime_type, duration, file_size)
       VALUES (1001, $1, $2, 'A', 'r', 'audio/mpeg', 100, 1600000) RETURNING id`,
      [msg, `Song ${msg}`],
    );
    for (const t of tags) {
      const h = await db.query<{ id: string }>(`INSERT INTO hashtags (value, normalized_value) VALUES ($1,$1) ON CONFLICT (normalized_value) DO UPDATE SET value = hashtags.value RETURNING id`, [t]);
      await db.query('INSERT INTO track_hashtags (track_id, hashtag_id) VALUES ($1,$2)', [r.rows[0]?.id, h.rows[0]?.id]);
    }
  }

  beforeEach(async () => {
    db = await freshDb();
    now = Date.parse('2026-01-01T10:00:00Z');
    published = [];
    settings = new EngagementSettingsRepository(db);
    svc = new TagVoteService(settings, new TagPollRepository(db), { publish: async (c) => void published.push(c) }, seededRng(7), () => now);
    for (let i = 1; i <= 3; i++) await seedTrack(i, ['rock']);
    for (let i = 4; i <= 6; i++) await seedTrack(i, ['jazz']);
    await seedTrack(7, ['lonely']); // only one track: never offered
    await settings.save(CH, { adsEveryNTracks: 0, tagVoteEnabled: true, tagVoteIntervalMinutes: 10, tagVotePollMinutes: 3, tagVotePlayMinutes: 5, tagVoteOptions: 3, tagVoteAllowlist: [], audioTransport: 'HTTP' as const });
  });
  afterEach(() => db.onModuleDestroy());

  it('runs the whole cycle: open -> vote -> winner plays for the configured time -> back to normal -> next poll after the interval', async () => {
    await svc.tick(CH);
    const open = await svc.view(CH);
    expect(open.status).toBe('OPEN');
    expect(open.poll?.options.map((o) => o.hashtag).sort()).toEqual(['jazz', 'rock']); // 'lonely' has < 2 tracks
    await svc.tick(CH); // ticking again does not open a second poll
    expect((await db.query('SELECT 1 FROM tag_polls')).rowCount).toBe(1);

    await svc.vote(CH, 'voter-aaaaaaaa', '1.1.1.1', 'jazz');
    await svc.vote(CH, 'voter-bbbbbbbb', '1.1.1.2', '#Jazz');
    await svc.vote(CH, 'voter-cccccccc', '1.1.1.3', 'rock');
    await svc.vote(CH, 'voter-cccccccc', '1.1.1.3', 'jazz'); // a voter may change their mind, but counts once
    expect((await svc.view(CH, 'voter-cccccccc')).myVote).toBe('jazz');
    expect((await svc.view(CH)).poll?.totalVotes).toBe(3);

    now += 2 * MIN;
    await svc.tick(CH);
    expect((await svc.view(CH)).status).toBe('OPEN'); // still inside the voting window
    expect(await svc.activeTag(CH)).toBeNull();

    now += 1 * MIN + 1;
    await svc.tick(CH);
    const playing = await svc.view(CH);
    expect(playing).toMatchObject({ status: 'PLAYING', winner: 'jazz' });
    expect(await svc.activeTag(CH)).toBe('jazz');
    expect(published).toEqual([{ type: 'config-changed', channelId: CH }]);

    now += 5 * MIN + 1;
    expect(await svc.activeTag(CH)).toBeNull(); // the override expires by itself even before the next tick
    await svc.tick(CH);
    expect((await svc.view(CH)).status).toBe('NONE');
    expect(published).toHaveLength(2); // the leader is told to re-plan once more

    now = Date.parse('2026-01-01T10:09:00Z');
    await svc.tick(CH);
    expect((await svc.view(CH)).status).toBe('NONE'); // interval (10 min since the poll opened) not over yet
    now = Date.parse('2026-01-01T10:10:01Z');
    await svc.tick(CH);
    expect((await svc.view(CH)).status).toBe('OPEN');
  });

  it('a poll nobody voted in ends without changing the music', async () => {
    await svc.tick(CH);
    now += 3 * MIN + 1;
    await svc.tick(CH);
    expect((await svc.view(CH)).status).toBe('NONE');
    expect(await svc.activeTag(CH)).toBeNull();
    expect(published).toHaveLength(0);
  });

  it('rejects unknown options, closed polls, malformed voter ids and too many voters from one IP', async () => {
    await svc.tick(CH);
    await expect(svc.vote(CH, 'voter-aaaaaaaa', '9.9.9.9', 'metal')).rejects.toThrow('unknown option');
    await expect(svc.vote(CH, 'x', '9.9.9.9', 'rock')).rejects.toThrow('invalid voter id');
    for (let i = 0; i < 20; i++) await svc.vote(CH, `voter-${String(i).padStart(8, '0')}`, '9.9.9.9', 'rock');
    await expect(svc.vote(CH, 'voter-zzzzzzzz', '9.9.9.9', 'rock')).rejects.toThrow('Too many votes');
    await svc.vote(CH, 'voter-00000001', '9.9.9.9', 'jazz'); // an existing voter can still change their vote
    now += 4 * MIN;
    await expect(svc.vote(CH, 'voter-aaaaaaaa', '8.8.8.8', 'rock')).rejects.toThrow('no open vote');
  });

  it('does nothing when disabled, only offers allow-listed tags, and needs two candidate tags', async () => {
    await settings.save(CH, { ...(await settings.get(CH)), tagVoteEnabled: false });
    await svc.tick(CH);
    expect((await svc.view(CH)).status).toBe('NONE');
    await settings.save(CH, { ...(await settings.get(CH)), tagVoteEnabled: true, tagVoteAllowlist: ['#Rock'] });
    await svc.tick(CH);
    expect((await svc.view(CH)).status).toBe('NONE'); // one allowed tag is not a vote
    expect(await svc.startNow(CH)).toBeNull();
    await settings.save(CH, { ...(await settings.get(CH)), tagVoteAllowlist: ['rock', 'jazz', 'lonely'] });
    const poll = await svc.startNow(CH);
    expect(poll?.options.sort()).toEqual(['jazz', 'rock']);
  });

  it('the scheduler plays only the winning tag while it is active, then returns to the configured mode', async () => {
    const scheduler = new RadioScheduler(new RadioConfigRepository(db), new PlaybackHistoryRepository(db), new RadioStateRepository(db), undefined, seededRng(1), svc);
    await svc.tick(CH);
    for (let i = 0; i < 4; i++) await svc.vote(CH, `voter-${String(i).padStart(8, '0')}`, `2.2.2.${i}`, 'rock');
    now += 3 * MIN + 1;
    await svc.tick(CH);
    const rock = new Set((await db.query<{ id: string }>(`SELECT t.id FROM tracks t JOIN track_hashtags th ON th.track_id = t.id JOIN hashtags h ON h.id = th.hashtag_id WHERE h.normalized_value = 'rock'`)).rows.map((r) => r.id));
    for (let i = 0; i < 12; i++) expect(rock.has((await scheduler.selectNext(CH)).trackId ?? '')).toBe(true);
    now += 5 * MIN + 1;
    const ids = new Set<string | null>();
    for (let i = 0; i < 40; i++) ids.add((await scheduler.selectNext(CH)).trackId);
    expect([...ids].some((id) => id !== null && !rock.has(id))).toBe(true); // global random again
  });

  it('bumps the configuration version so the engine drops its pre-selected track', async () => {
    const before = (await new RadioStateRepository(db).get(CH)).configurationVersion;
    await svc.tick(CH);
    await svc.vote(CH, 'voter-aaaaaaaa', '1.1.1.1', 'rock');
    now += 3 * MIN + 1;
    await svc.tick(CH);
    expect((await new RadioStateRepository(db).get(CH)).configurationVersion).toBeGreaterThan(before);
  });
});
