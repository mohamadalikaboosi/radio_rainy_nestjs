import { audioMsg, FakeTelegramGateway } from '../../../test/fake-telegram';
import { freshDb } from '../../../test/test-db';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { TrackRepository } from './ports/track.repository';
import { PgTrackRepository } from '../infrastructure/persistence/track.repository';
import { TelegramTrackDiscovery } from './track-discovery';

describe('TelegramTrackDiscovery', () => {
  let db: DatabaseService;
  let repo: TrackRepository;
  let gw: FakeTelegramGateway;
  let queued: string[];
  let discovery: TelegramTrackDiscovery;

  beforeEach(async () => {
    db = await freshDb();
    repo = new PgTrackRepository(db);
    gw = new FakeTelegramGateway();
    queued = [];
    discovery = new TelegramTrackDiscovery(gw, repo, { onLyricsNeedFetch: async (id) => void queued.push(id) });
    gw.add(audioMsg(1, 'Artist A - Song A\nAlbum: Alb\nLyrics: https://telegra.ph/a-01\n#Rain #night'));
    gw.add(audioMsg(2, 'Artist B - Song B\n#rock'));
  });
  afterEach(() => db.onModuleDestroy());

  const count = async (t: string) => Number((await db.query(`SELECT count(*) AS n FROM ${t}`)).rows[0]?.n);

  it('discovers tracks, metadata, hashtags and queues lyrics only when a URL exists', async () => {
    const r = await discovery.sync('1001');
    expect(r).toMatchObject({ scanned: 2, created: 2, updated: 0 });
    const t = await db.query(`SELECT title, artist, album, lyrics_url, lyrics_status FROM tracks WHERE telegram_message_id = 1`);
    expect(t.rows[0]).toEqual({ title: 'Song A', artist: 'Artist A', album: 'Alb', lyrics_url: 'https://telegra.ph/a-01', lyrics_status: 'LYRICS_PENDING' });
    expect((await db.query(`SELECT lyrics_status FROM tracks WHERE telegram_message_id = 2`)).rows[0]).toEqual({ lyrics_status: 'LYRICS_NONE' });
    expect(queued).toHaveLength(1);
    expect(await count('hashtags')).toBe(3);
    expect(await count('track_hashtags')).toBe(3);
  });

  it('is idempotent: repeated and full syncs create no duplicates and queue nothing new', async () => {
    await discovery.sync('1001');
    await discovery.sync('1001');
    const full = await discovery.sync('1001', { full: true });
    expect(full).toMatchObject({ scanned: 2, created: 0, unchanged: 2 });
    expect(await count('tracks')).toBe(2);
    expect(await count('track_hashtags')).toBe(3);
    expect(queued).toHaveLength(1);
  });

  it('incremental sync only scans new messages', async () => {
    await discovery.sync('1001');
    gw.add(audioMsg(3, 'C - Song C'));
    const r = await discovery.sync('1001');
    expect(r).toMatchObject({ scanned: 1, created: 1 });
  });

  it('concurrent syncs share one run', async () => {
    const [a, b] = await Promise.all([discovery.sync('1001'), discovery.sync('1001')]);
    expect(a).toBe(b);
    expect(await count('tracks')).toBe(2);
  });

  it('detects edits: hashtag changes and lyrics URL changes re-queue lyrics', async () => {
    await discovery.sync('1001');
    gw.add(audioMsg(1, 'Artist A - Song A\nLyrics: https://telegra.ph/a-02\n#rain #chill'));
    const r = await discovery.sync('1001', { full: true });
    expect(r.updated).toBe(1);
    expect(queued).toHaveLength(2);
    const tags = await db.query(`SELECT h.normalized_value FROM track_hashtags th JOIN hashtags h ON h.id=th.hashtag_id JOIN tracks t ON t.id=th.track_id WHERE t.telegram_message_id=1 ORDER BY 1`);
    expect(tags.rows.map((x) => x.normalized_value)).toEqual(['chill', 'rain']);
  });

  it('marks deleted messages UNAVAILABLE and restores them if they reappear', async () => {
    await discovery.sync('1001');
    gw.remove(2);
    const r = await discovery.sync('1001');
    expect(r.markedUnavailable).toBe(1);
    expect((await db.query(`SELECT status FROM tracks WHERE telegram_message_id = 2`)).rows[0]).toEqual({ status: 'UNAVAILABLE' });
    gw.add(audioMsg(2, 'Artist B - Song B\n#rock'));
    const r2 = await discovery.sync('1001', { full: true });
    expect(r2.restored).toBe(1);
    expect((await db.query(`SELECT status FROM tracks WHERE telegram_message_id = 2`)).rows[0]).toEqual({ status: 'READY' });
  });

  it('one bad message does not abort the sync', async () => {
    const bad = audioMsg(9, 'x');
    (bad.audio as { size: unknown }).size = 'not-a-number';
    gw.add(bad);
    const r = await discovery.sync('1001');
    expect(r.failed).toBe(1);
    expect(r.created).toBe(2);
  });
});
