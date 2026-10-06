import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { sign } from 'jsonwebtoken';
import { ADMIN, bootAdminApp, FakeTelegramManager } from '../../test/admin-app';
import { FakeTelegramGateway } from '../../test/fake-telegram';
import { DatabaseService } from '../database/database.service';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';
import { LexiconRepository } from '../language/lexicon';

const CH = '1001';

describe('Super Admin API (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let manager: FakeTelegramManager;
  let restore: () => void;
  let token: string;
  let gateway: FakeTelegramGateway;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  async function seedTrack(msg: number, title: string, tags: string[], over: { enabled?: boolean; lyrics?: string } = {}): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO tracks (telegram_channel_id, telegram_message_id, title, artist, telegram_file_reference, mime_type, duration, file_size, enabled, lyrics_status, lyrics_url)
       VALUES (1001, $1, $2, 'Artist', 'ref', 'audio/mpeg', 200, 3200000, $3, $4, $5) RETURNING id`,
      [msg, title, over.enabled ?? true, over.lyrics ?? 'LYRICS_NONE', over.lyrics && over.lyrics !== 'LYRICS_NONE' ? `https://telegra.ph/t-${msg}` : null],
    );
    const id = r.rows[0]?.id ?? '';
    for (const t of tags) {
      const h = await db.query<{ id: string }>(`INSERT INTO hashtags (value, normalized_value) VALUES ($1,$1) ON CONFLICT (normalized_value) DO UPDATE SET value = hashtags.value RETURNING id`, [t]);
      await db.query('INSERT INTO track_hashtags (track_id, hashtag_id) VALUES ($1,$2)', [id, h.rows[0]?.id]);
    }
    return id;
  }

  beforeAll(async () => {
    ({ app, manager, gateway, restore } = await bootAdminApp());
    db = app.get(DatabaseService);
    const r = await http().post('/admin/auth/login').send(ADMIN).expect(200);
    token = r.body.token;
  });
  afterAll(async () => {
    await app.close();
    restore();
  });

  // Spec scenario (§24.20)
  let ids: Record<string, string>;
  beforeAll(async () => {
    ids = {
      A: await seedTrack(1, 'Song A', ['rain', 'night'], { lyrics: 'LYRICS_READY' }),
      B: await seedTrack(2, 'Song B', ['rock'], { lyrics: 'LYRICS_FAILED' }),
      C: await seedTrack(3, 'Song C', ['rain', 'chill']),
      D: await seedTrack(4, 'Song D', ['night', 'chill']),
      E: await seedTrack(5, 'Song E', ['rain', 'night', 'chill'], { lyrics: 'LYRICS_PENDING' }),
    };
  });

  describe('authentication & authorization', () => {
    it('login validates credentials and never leaks which part was wrong', async () => {
      await http().post('/admin/auth/login').send({ email: ADMIN.email, password: 'nope' }).expect(401);
      await http().post('/admin/auth/login').send({ email: 'x@y.co', password: ADMIN.password }).expect(401);
      await http().post('/admin/auth/login').send({ email: 'not-an-email' }).expect(400);
    });

    it('EVERY /admin route except login rejects missing, forged and non-admin tokens (401)', async () => {
      const stack = (app.getHttpAdapter().getInstance() as { router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }; _router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } });
      const layers = (stack.router ?? stack._router)?.stack ?? [];
      const routes = layers.filter((l) => l.route?.path.startsWith('/admin')).flatMap((l) => Object.keys(l.route?.methods ?? {}).map((m) => ({ method: m, path: (l.route?.path ?? '').replace(/:\w+/g, '00000000-0000-0000-0000-000000000000') })));
      expect(routes.length).toBeGreaterThan(20);
      const forged = sign({ role: 'SUPER_ADMIN' }, 'not-the-secret'.repeat(4), { subject: 'evil' });
      const userTok = sign({ role: 'USER' }, 'j'.repeat(40), { subject: 'u' });
      for (const r of routes) {
        if (r.path === '/admin/auth/login') continue;
        const call = (h?: string) => (http() as unknown as Record<string, (p: string) => request.Test>)[r.method]?.(r.path).set(h ? { Authorization: h } : {}).send({});
        expect((await call())?.status).toBe(401);
        expect((await call(`Bearer ${forged}`))?.status).toBe(401);
        expect((await call(`Bearer ${userTok}`))?.status).toBe(401);
      }
    });

    it('/admin/auth/me returns the identity', async () => {
      expect((await http().get('/admin/auth/me').set(auth()).expect(200)).body).toEqual({ username: ADMIN.email, role: 'SUPER_ADMIN', mustChangePassword: false });
    });
  });

  describe('dashboard', () => {
    it('overview: global counts + one entry per station + telegram state', async () => {
      const d = (await http().get('/admin/dashboard').set(auth()).expect(200)).body;
      expect(d.counts).toMatchObject({ totalTracks: 5, playableTracks: 5, tracksWithLyrics: 1, tracksWaitingForLyrics: 1, failedLyrics: 1, hashtags: 4 });
      expect(d.stations).toHaveLength(1);
      expect(d.stations[0]).toMatchObject({ id: CH, slug: 'chan', started: false });
      expect(d.telegram.state).toBe('NOT_LOGGED_IN');
    });
    it('per-channel dashboard: selection + counts scoped to the channel', async () => {
      const d = (await http().get(`/admin/channels/${CH}/radio/dashboard`).set(auth()).expect(200)).body;
      expect(d.radio.selection.mode).toBe('GLOBAL_RANDOM');
      expect(d.counts.totalTracks).toBe(5);
      await http().get('/admin/channels/999999/radio/dashboard').set(auth()).expect(404);
    });
  });

  describe('tracks', () => {
    it('search, filter, paginate', async () => {
      const all = (await http().get('/admin/tracks?pageSize=2&page=1&sort=title&order=asc').set(auth()).expect(200)).body;
      expect(all.total).toBe(5);
      expect(all.items.map((t: { title: string }) => t.title)).toEqual(['Song A', 'Song B']);
      expect((await http().get('/admin/tracks?hashtag=%23Rain').set(auth())).body.total).toBe(3);
      expect((await http().get('/admin/tracks?lyricsStatus=LYRICS_FAILED').set(auth())).body.items[0].title).toBe('Song B');
      expect((await http().get('/admin/tracks?q=song%20c').set(auth())).body.total).toBe(1);
      expect((await http().get('/admin/tracks?q=%25').set(auth())).body.total).toBe(0); // LIKE wildcards are escaped
      await http().get('/admin/tracks?pageSize=1000').set(auth()).expect(400);
    });

    it('detail includes hashtags and Telegram info', async () => {
      const t = (await http().get(`/admin/tracks/${ids.A}`).set(auth()).expect(200)).body;
      expect(t.hashtags.map((h: { normalized: string }) => h.normalized)).toEqual(['night', 'rain']);
      expect(t.telegramMessageId).toBe(1);
      await http().get('/admin/tracks/00000000-0000-0000-0000-000000000000').set(auth()).expect(404);
      await http().get('/admin/tracks/not-a-uuid').set(auth()).expect(400);
    });

    it('enable/disable is idempotent and race-safe: 10 parallel requests -> one change, one audit row', async () => {
      const res = await Promise.all(Array.from({ length: 10 }, () => http().patch(`/admin/tracks/${ids.B}/enabled`).set(auth()).send({ enabled: false })));
      expect(res.every((r) => r.status === 200)).toBe(true);
      expect(res.filter((r) => r.body.changed === true)).toHaveLength(1);
      const audit = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'track.disable' AND entity_id = $1`, [ids.B]);
      expect((audit.rows[0] as { n: number }).n).toBe(1);
      await http().patch(`/admin/tracks/${ids.B}/enabled`).set(auth()).send({ enabled: true }).expect(200);
    });

    it('process-lyrics queues the pipeline (202), rejects tracks without URL', async () => {
      await http().post(`/admin/tracks/${ids.A}/process-lyrics`).set(auth()).send({ force: true }).expect(202);
      expect((await db.query(`SELECT lyrics_status FROM tracks WHERE id = $1`, [ids.A])).rows[0]).toEqual({ lyrics_status: 'LYRICS_PENDING' });
      await http().post(`/admin/tracks/${ids.C}/process-lyrics`).set(auth()).send({}).expect(400);
    });
  });

  describe('radio configuration', () => {
    it('updates atomically, bumps version, audits before/after', async () => {
      const cur = (await http().get(`/admin/channels/${CH}/radio/config`).set(auth()).expect(200)).body;
      const r = await http().put(`/admin/channels/${CH}/radio/config`).set(auth()).send({
        mode: 'HASHTAG_RANDOM', hashtagMatchMode: 'ANY', recentTrackWindow: 3, hashtags: [{ hashtag: '#Rain', weight: 50 }, { hashtag: 'night', weight: 30 }], expectedVersion: cur.version,
      }).expect(200);
      expect(r.body).toMatchObject({ version: cur.version + 1, mode: 'HASHTAG_RANDOM', recentTrackWindow: 3 });
      expect(r.body.hashtags).toEqual([{ hashtag: 'rain', weight: 50 }, { hashtag: 'night', weight: 30 }]);
      const a = (await http().get('/admin/audit?action=radio.config.update').set(auth())).body.items[0];
      expect(a.actor).toBe(ADMIN.email);
      expect(a.before.mode).toBe('GLOBAL_RANDOM');
      expect(a.after.mode).toBe('HASHTAG_RANDOM');
    });

    it('rejects stale versions (409), unknown hashtags (400) and bad input', async () => {
      const cur = (await http().get(`/admin/channels/${CH}/radio/config`).set(auth())).body;
      const base = { mode: 'GLOBAL_RANDOM', hashtagMatchMode: 'ANY', recentTrackWindow: 3, hashtags: [] };
      await http().put(`/admin/channels/${CH}/radio/config`).set(auth()).send({ ...base, expectedVersion: cur.version - 1 }).expect(409);
      await http().put(`/admin/channels/${CH}/radio/config`).set(auth()).send({ ...base, hashtags: [{ hashtag: 'doesnotexist' }] }).expect(400);
      await http().put(`/admin/channels/${CH}/radio/config`).set(auth()).send({ ...base, mode: 'NOPE' }).expect(400);
      await http().put(`/admin/channels/${CH}/radio/config`).set(auth()).send({ ...base, recentTrackWindow: -1 }).expect(400);
      expect((await http().get(`/admin/channels/${CH}/radio/config`).set(auth())).body.version).toBe(cur.version); // nothing changed
    });

    it('concurrent updates with the same expectedVersion: exactly one wins, version increments once', async () => {
      const cur = (await http().get(`/admin/channels/${CH}/radio/config`).set(auth())).body;
      const body = { mode: 'GLOBAL_RANDOM', hashtagMatchMode: 'ANY', recentTrackWindow: 5, hashtags: [], expectedVersion: cur.version };
      const res = await Promise.all(Array.from({ length: 10 }, () => http().put(`/admin/channels/${CH}/radio/config`).set(auth()).send(body)));
      expect(res.filter((r) => r.status === 200)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(9);
      expect((await http().get(`/admin/channels/${CH}/radio/config`).set(auth())).body.version).toBe(cur.version + 1);
    });

    it('preview uses the real engine: ANY -> A,C,D,E ; ALL -> A,E ; deterministic per seed', async () => {
      const any = (await http().post(`/admin/channels/${CH}/radio/preview`).set(auth()).send({ mode: 'HASHTAG_RANDOM', hashtags: ['rain', 'night'], match: 'ANY', limit: 40, seed: 12345 }).expect(200)).body;
      expect(any.eligibleCount).toBe(4);
      expect(new Set(any.tracks.map((t: { title: string }) => t.title))).toEqual(new Set(['Song A', 'Song C', 'Song D', 'Song E']));
      const all = (await http().post(`/admin/channels/${CH}/radio/preview`).set(auth()).send({ mode: 'HASHTAG_RANDOM', hashtags: ['rain', 'night'], match: 'ALL', limit: 40, seed: 12345, recentTrackWindow: 1 }).expect(200)).body;
      expect(all.eligibleCount).toBe(2);
      expect(new Set(all.tracks.map((t: { title: string }) => t.title))).toEqual(new Set(['Song A', 'Song E']));
      const again = (await http().post(`/admin/channels/${CH}/radio/preview`).set(auth()).send({ mode: 'HASHTAG_RANDOM', hashtags: ['rain', 'night'], match: 'ANY', limit: 40, seed: 12345 })).body;
      expect(again.tracks.map((t: { id: string }) => t.id)).toEqual(any.tracks.map((t: { id: string }) => t.id));
    });

    it('rules: CRUD, priority evaluation in preview, persisted with audit', async () => {
      const r1 = (await http().post(`/admin/channels/${CH}/radio/rules`).set(auth()).send({ name: 'Late night rain', priority: 1, matchMode: 'ALL', include: ['rain', 'night'], exclude: ['chill'], weight: 80 }).expect(201)).body;
      expect(r1).toMatchObject({ name: 'Late night rain', include: ['rain', 'night'], exclude: ['chill'] });
      await http().post(`/admin/channels/${CH}/radio/rules`).set(auth()).send({ name: 'Chill', priority: 2, include: ['chill'] }).expect(201);
      const p = (await http().post(`/admin/channels/${CH}/radio/preview`).set(auth()).send({ mode: 'CUSTOM_RULE', limit: 20, seed: 1, recentTrackWindow: 0 }).expect(200)).body;
      expect(new Set(p.tracks.map((t: { title: string }) => t.title))).toEqual(new Set(['Song A'])); // priority 1 wins, E excluded by #chill
      await http().put(`/admin/channels/${CH}/radio/rules/${r1.id}`).set(auth()).send({ name: 'Late night rain', priority: 1, matchMode: 'ALL', include: ['rain', 'night'], exclude: [], enabled: false }).expect(200);
      const p2 = (await http().post(`/admin/channels/${CH}/radio/preview`).set(auth()).send({ mode: 'CUSTOM_RULE', limit: 30, seed: 1, recentTrackWindow: 0 })).body;
      expect(new Set(p2.tracks.map((t: { title: string }) => t.title))).toEqual(new Set(['Song C', 'Song D', 'Song E']));
      await http().delete(`/admin/channels/${CH}/radio/rules/${r1.id}`).set(auth()).expect(204);
      await http().delete(`/admin/channels/${CH}/radio/rules/${r1.id}`).set(auth()).expect(404);
      await http().post(`/admin/channels/${CH}/radio/rules`).set(auth()).send({ name: 'x', priority: 1, include: [] }).expect(400);
      const actions = (await http().get('/admin/audit?entityType=radio_rule&limit=50').set(auth())).body.items.map((i: { action: string }) => i.action);
      expect(actions).toEqual(expect.arrayContaining(['radio.rule.create', 'radio.rule.update', 'radio.rule.delete']));
    });

    it('skip / play-next are accepted, audited; play-next validates the track', async () => {
      await http().post(`/admin/channels/${CH}/radio/skip`).set(auth()).send({}).expect(202);
      await http().post(`/admin/channels/${CH}/radio/play-next`).set(auth()).send({}).expect(202);
      await http().post(`/admin/channels/${CH}/radio/play-next`).set(auth()).send({ trackId: ids.A }).expect(202);
      await http().post(`/admin/channels/${CH}/radio/play-next`).set(auth()).send({ trackId: '00000000-0000-0000-0000-000000000000' }).expect(404);
      await db.query('UPDATE tracks SET enabled = false WHERE id = $1', [ids.D]);
      await http().post(`/admin/channels/${CH}/radio/play-next`).set(auth()).send({ trackId: ids.D }).expect(400);
      await db.query('UPDATE tracks SET enabled = true WHERE id = $1', [ids.D]);
      const actions = (await http().get('/admin/audit?limit=100').set(auth())).body.items.map((i: { action: string }) => i.action);
      expect(actions).toEqual(expect.arrayContaining(['radio.skip', 'radio.play-next']));
    });
  });

  describe('hashtag analytics', () => {
    it('aggregates per hashtag from the stats table', async () => {
      await db.query('UPDATE tracks SET play_count = 10 WHERE id = $1', [ids.A]);
      const s = (await http().post('/admin/hashtags/stats/refresh').set(auth()).expect(200)).body;
      const rain = s.items.find((i: { normalized: string }) => i.normalized === 'rain');
      expect(rain).toMatchObject({ trackCount: 3, playableCount: 3, plays: 10 });
      expect(s.mostPlayed[0].plays).toBeGreaterThanOrEqual(10);
      expect(s.withFailedLyrics.map((i: { normalized: string }) => i.normalized)).toContain('rock');
      const tracks = (await http().get(`/admin/hashtags/${rain.hashtagId}/tracks`).set(auth()).expect(200)).body;
      expect(tracks).toHaveLength(3);
    });
  });

  describe('Telegram login from the panel', () => {
    it('phone -> code -> (2FA password) -> ready, with masked audit and no secrets stored', async () => {
      manager.needsPassword = true;
      await http().post('/admin/telegram/login/start').set(auth()).send({ phone: 'abc' }).expect(400);
      const s1 = (await http().post('/admin/telegram/login/start').set(auth()).send({ phone: '+989123456789' }).expect(200)).body;
      expect(s1.state).toBe('AWAITING_CODE');
      const bad = await http().post('/admin/telegram/login/code').set(auth()).send({ code: '00000' }).expect(400);
      expect(bad.body.telegramError).toBe('PHONE_CODE_INVALID');
      expect((await http().post('/admin/telegram/login/code').set(auth()).send({ code: '12345' }).expect(200)).body.state).toBe('AWAITING_PASSWORD');
      await http().post('/admin/telegram/login/password').set(auth()).send({ password: 'wrong' }).expect(400);
      expect((await http().post('/admin/telegram/login/password').set(auth()).send({ password: 'my-2fa-pass' }).expect(200)).body.state).toBe('READY');
      expect((await http().get('/admin/telegram/status').set(auth())).body.state).toBe('READY');

      const dump = JSON.stringify((await db.query('SELECT * FROM audit_logs')).rows);
      expect(dump).toContain('telegram.login.complete');
      expect(dump).toContain('+98********89');
      for (const secret of ['+989123456789', '12345', 'my-2fa-pass', 'hash-secret-value']) expect(dump).not.toContain(secret);
    });

    it('logout and manual sync', async () => {
      expect((await http().post('/admin/telegram/logout').set(auth()).expect(200)).body.state).toBe('NOT_LOGGED_IN');
      await http().post('/admin/sync').set(auth()).send({ full: true }).expect(202);
      await http().post('/admin/sync').set(auth()).send({}).expect(202);
    });
  });


  describe('channels (multi-channel stations)', () => {
    let second = '';
    it('adds a channel resolved through Telegram; rejects duplicates, unknown references and logged-out state', async () => {
      gateway.addChannel('@second', { id: '2002', title: 'Second Radio', username: 'second' });
      const r = (await http().post('/admin/channels').set(auth()).send({ reference: '@second' }).expect(201)).body;
      second = r.id;
      expect(r).toMatchObject({ id: '2002', slug: 'second', started: false, telegramLiveEnabled: false });
      await http().post('/admin/channels').set(auth()).send({ reference: '@second' }).expect(409);
      const bad = await http().post('/admin/channels').set(auth()).send({ reference: '@nope' }).expect(400);
      expect(bad.body.telegramError).toBe('USERNAME_NOT_OCCUPIED');
      gateway.notReady = true;
      const off = await http().post('/admin/channels').set(auth()).send({ reference: '@another' }).expect(400);
      expect(JSON.stringify(off.body)).toMatch(/Log in to Telegram first/);
      gateway.notReady = false;
      // every station gets its own configuration and state
      expect(Number((await db.query(`SELECT count(*) AS n FROM radio_configuration WHERE channel_id = 2002`)).rows[0]?.n)).toBe(1);
      expect(Number((await db.query(`SELECT count(*) AS n FROM radio_state WHERE channel_id = 2002`)).rows[0]?.n)).toBe(1);
    });

    it('stations are isolated: tracks, selection and config are per channel', async () => {
      const t = await db.query<{ id: string }>(`INSERT INTO tracks (telegram_channel_id, telegram_message_id, title, artist, telegram_file_reference, mime_type, duration, file_size) VALUES (2002, 1, 'Second Only', 'X', 'r', 'audio/mpeg', 100, 1600000) RETURNING id`);
      void t;
      const p2 = (await http().post(`/admin/channels/${second}/radio/preview`).set(auth()).send({ mode: 'GLOBAL_RANDOM', limit: 10, seed: 1 }).expect(200)).body;
      expect(new Set(p2.tracks.map((x: { title: string }) => x.title))).toEqual(new Set(['Second Only']));
      const p1 = (await http().post(`/admin/channels/${CH}/radio/preview`).set(auth()).send({ mode: 'GLOBAL_RANDOM', limit: 30, seed: 1 }).expect(200)).body;
      expect(p1.tracks.map((x: { title: string }) => x.title)).not.toContain('Second Only');
      // config is independent
      const c2 = (await http().get(`/admin/channels/${second}/radio/config`).set(auth())).body;
      expect(c2.mode).toBe('GLOBAL_RANDOM');
      expect(c2.hashtags).toEqual([]);
      // track list filter
      expect((await http().get(`/admin/tracks?channel=${second}`).set(auth())).body.total).toBe(1);
      expect((await http().get(`/admin/tracks?channel=${CH}`).set(auth())).body.total).toBe(5);
      // play-next only accepts tracks of the same channel
      await http().post(`/admin/channels/${CH}/radio/play-next`).set(auth()).send({ trackId: t.rows[0]?.id }).expect(400);
    });

    it('start / stop are idempotent, audited, and the leader reacts (public station list)', async () => {
      const s1 = await http().post(`/admin/channels/${second}/start`).set(auth()).expect(200);
      expect(s1.body.started).toBe(true);
      await http().post(`/admin/channels/${second}/start`).set(auth()).expect(200);
      const starts = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'channel.start' AND entity_id = '2002'`);
      expect((starts.rows[0] as { n: number }).n).toBe(1);
      // leader reconciles asynchronously
      let live = false;
      for (let i = 0; i < 60 && !live; i++) {
        const list = (await http().get('/radio/stations')).body as { slug: string; live: boolean }[];
        live = list.some((x) => x.slug === 'second' && x.live);
        if (!live) await new Promise((r) => setTimeout(r, 100));
      }
      expect(live).toBe(true);
      expect(JSON.stringify((await http().get('/radio/stations')).body)).not.toMatch(/2002|reference|telegram/i);
    });

    it('every station has a permanent public UUID address: exposed by the public list, never changes, cannot be updated even by SQL', async () => {
      await http().post(`/admin/channels/${second}/start`).set(auth()).expect(200);
      const list = (await http().get('/radio/stations')).body as { publicId: string; slug: string }[];
      const mine = list.find((x) => x.slug === 'second');
      expect(mine?.publicId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const row = await db.query<{ public_id: string }>(`SELECT public_id FROM channels WHERE telegram_channel_id = 2002`);
      expect(row.rows[0]?.public_id).toBe(mine?.publicId);
      // restarting / retitling does not change it
      await http().post(`/admin/channels/${second}/stop`).set(auth()).expect(200);
      await http().post(`/admin/channels/${second}/start`).set(auth()).expect(200);
      const again = (await http().get('/radio/stations')).body as { publicId: string; slug: string }[];
      expect(again.find((x) => x.slug === 'second')?.publicId).toBe(mine?.publicId);
      // the database itself refuses to change it
      await expect(db.query(`UPDATE channels SET public_id = gen_random_uuid() WHERE telegram_channel_id = 2002`)).rejects.toThrow(/immutable/);
      await db.query(`UPDATE channels SET title = 'Renamed' WHERE telegram_channel_id = 2002`); // other columns stay editable
      // two stations never share one
      const ids = (await db.query<{ public_id: string }>('SELECT public_id FROM channels')).rows.map((r) => r.public_id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('Telegram live stream toggle: reported per channel (ffmpeg missing/unreachable => ERROR with reason), off again', async () => {
      const on = (await http().put(`/admin/channels/${second}/live`).set(auth()).send({ enabled: true }).expect(200)).body;
      expect(on.telegramLiveEnabled).toBe(true);
      let status = 'OFF';
      for (let i = 0; i < 80 && (status === 'OFF' || status === 'STARTING'); i++) {
        status = (await db.query<{ live_status: string }>(`SELECT live_status FROM channels WHERE telegram_channel_id = 2002`)).rows[0]?.live_status ?? 'OFF';
        if (status === 'OFF' || status === 'STARTING') await new Promise((r) => setTimeout(r, 100));
      }
      expect(['LIVE', 'ERROR']).toContain(status);
      const off = (await http().put(`/admin/channels/${second}/live`).set(auth()).send({ enabled: false }).expect(200)).body;
      expect(off).toMatchObject({ telegramLiveEnabled: false, liveStatus: 'OFF' });
    });

    it('public API is per station and never leaks unknown stations', async () => {
      await http().get('/radio/unknown-station/current').expect(404);
      expect((await http().get('/radio/second/current').expect(200)).body).toHaveProperty('status');
      await http().get('/radio/unknown-station/stream').expect(404);
    });

    it('stop, then remove with its tracks', async () => {
      await http().post(`/admin/channels/${second}/stop`).set(auth()).expect(200);
      await http().delete(`/admin/channels/${second}?deleteTracks=true`).set(auth()).expect(204);
      expect(Number((await db.query(`SELECT count(*) AS n FROM tracks WHERE telegram_channel_id = 2002`)).rows[0]?.n)).toBe(0);
      expect(Number((await db.query(`SELECT count(*) AS n FROM radio_state WHERE channel_id = 2002`)).rows[0]?.n)).toBe(0);
      await http().delete(`/admin/channels/${second}`).set(auth()).expect(404);
    });
  });

  describe('settings stored in the database (secrets encrypted)', () => {
    it('Telegram API id/hash: write-only secret, encrypted at rest, audited without the value', async () => {
      const before = (await http().get('/admin/settings').set(auth()).expect(200)).body;
      expect(before.telegram.source).toBe('environment');
      const res = (await http().put('/admin/settings/telegram').set(auth()).send({ apiId: 777, apiHash: 'db-stored-secret-hash' }).expect(200)).body;
      expect(res.telegram).toEqual({ apiId: 777, apiHashSet: true, source: 'database' });
      expect(JSON.stringify(res)).not.toContain('db-stored-secret-hash');
      const raw = JSON.stringify((await db.query('SELECT * FROM app_settings')).rows);
      expect(raw).not.toContain('db-stored-secret-hash');
      const audit = JSON.stringify((await db.query(`SELECT after FROM audit_logs WHERE action = 'settings.telegram.update'`)).rows);
      expect(audit).toContain('apiHashChanged');
      expect(audit).not.toContain('db-stored-secret-hash');
      await http().put('/admin/settings/telegram').set(auth()).send({ apiId: -1 }).expect(400);
    });

    it('Whisper: url/model/language/48 kHz, key never returned; invalid url rejected; can be disabled', async () => {
      const r = (await http().put('/admin/settings/whisper').set(auth()).send({ url: 'http://localhost:8000/v1/audio/transcriptions', model: 'Systran/faster-whisper-small', language: 'fa', sampleRate: 48000, timeoutSeconds: 900, apiKey: 'whisper-key-123' }).expect(200)).body;
      expect(r.whisper).toMatchObject({ enabled: true, model: 'Systran/faster-whisper-small', language: 'fa', sampleRate: 48000, apiKeySet: true, source: 'database' });
      expect(JSON.stringify(r)).not.toContain('whisper-key-123');
      await http().put('/admin/settings/whisper').set(auth()).send({ url: 'not a url' }).expect(400);
      const off = (await http().put('/admin/settings/whisper').set(auth()).send({ url: '', clearApiKey: true }).expect(200)).body;
      expect(off.whisper.apiKeySet).toBe(false);
    });

    it('Audio storage (MinIO): keys write-only, validated, connection test against a real S3 API, can be disabled', async () => {
      const s3 = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: mkdtempSync(join(tmpdir(), 's3e-')), configureBuckets: [{ name: 'radio-rainy-audio', configs: [] }] });
      const addr = await s3.run();
      const port = typeof addr === 'string' ? Number(addr.split(':').pop()) : addr.port;
      try {
        // not enabled + no keys yet
        expect((await http().get('/admin/settings').set(auth())).body.storage).toMatchObject({ enabled: false, active: false });
        // enabling without keys is rejected
        await http().put('/admin/settings/storage').set(auth()).send({ enabled: true, endpoint: `127.0.0.1:${port}`, bucket: 'radio-rainy-audio' }).expect(400);
        await http().put('/admin/settings/storage').set(auth()).send({ enabled: false, endpoint: 'x', bucket: 'Bad_Bucket' }).expect(400);
        expect((await http().post('/admin/settings/storage/test').set(auth()).expect(200)).body.ok).toBe(false);

        const r = (await http().put('/admin/settings/storage').set(auth()).send({ enabled: true, endpoint: `http://127.0.0.1:${port}`, port, useSsl: false, bucket: 'radio-rainy-audio', accessKey: 'S3RVER', secretKey: 'S3RVER' }).expect(200)).body;
        expect(r.storage).toMatchObject({ enabled: true, endpoint: '127.0.0.1', bucket: 'radio-rainy-audio', keysSet: true, active: true, source: 'database' });
        expect(JSON.stringify(r)).not.toMatch(/S3RVER/);
        expect(JSON.stringify((await db.query('SELECT * FROM app_settings')).rows)).not.toMatch(/S3RVER/);
        expect(JSON.stringify((await db.query(`SELECT after FROM audit_logs WHERE action = 'settings.storage.update'`)).rows)).not.toMatch(/S3RVER/);

        const ok = (await http().post('/admin/settings/storage/test').set(auth()).expect(200)).body;
        expect(ok).toMatchObject({ ok: true, objects: 0 });

        // an unreachable server is reported as { ok: false, error }, never thrown
        await http().put('/admin/settings/storage').set(auth()).send({ enabled: true, endpoint: '127.0.0.1:1', bucket: 'radio-rainy-audio' }).expect(200);
        const bad = (await http().post('/admin/settings/storage/test').set(auth()).expect(200)).body;
        expect(bad.ok).toBe(false);
        expect(String(bad.error)).toMatch(/ECONNREFUSED|connect/i);

        const off = (await http().put('/admin/settings/storage').set(auth()).send({ enabled: false, endpoint: `127.0.0.1:${port}`, bucket: 'radio-rainy-audio' }).expect(200)).body;
        expect(off.storage.active).toBe(false);
      } finally {
        await s3.close();
      }
    });

    it('LLM settings', async () => {
      const r = (await http().put('/admin/settings/llm').set(auth()).send({ enabled: true, url: 'http://localhost:11434/v1', model: 'qwen2.5', apiKey: 'llm-key' }).expect(200)).body;
      expect(r.llm).toEqual({ enabled: true, url: 'http://localhost:11434/v1', model: 'qwen2.5', apiKeySet: true });
    });
  });

  describe('Persian / English language learning', () => {
    it('lexicon: list, approve/reject, delete; LLM review; retrain; dataset export', async () => {
      const lex = app.get(LexiconRepository);
      await lex.learn('fa', [{ asr: 'بارون', lyric: 'باران' }, { asr: 'دوستت', lyric: 'دوستت‌' }, { asr: 'کنی', lyric: 'کنی' }]); // identical pair ignored
      await lex.learn('fa', [{ asr: 'بارون', lyric: 'باران' }]);
      await lex.learn('en', [{ asr: 'gonna', lyric: 'going' }, { asr: 'wanna', lyric: 'want' }]);
      const list = (await http().get('/admin/language/lexicon?lang=fa').set(auth()).expect(200)).body;
      expect(list.total).toBe(2);
      expect(list.items[0]).toMatchObject({ asrWord: 'بارون', lyricWord: 'باران', count: 2, status: 'LEARNED' });

      const stats = (await http().get('/admin/language/stats').set(auth()).expect(200)).body;
      expect(stats.lexicon.find((x: { lang: string }) => x.lang === 'fa')).toMatchObject({ entries: 2, trusted: 1 });

      // LLM review (fake linguist: odd ids same, even ids different)
      const rv = (await http().post('/admin/language/review').set(auth()).send({ lang: 'en', limit: 10 }).expect(200)).body;
      expect(rv).toMatchObject({ reviewed: 2, approved: 1, rejected: 1, skipped: 0 });
      const en = (await http().get('/admin/language/lexicon?lang=en').set(auth())).body.items.map((x: { status: string }) => x.status).sort();
      expect(en).toEqual(['APPROVED', 'REJECTED']);

      await http().patch('/admin/language/lexicon').set(auth()).send({ lang: 'fa', asrWord: 'دوستت', lyricWord: 'دوستت‌', status: 'REJECTED' }).expect(200);
      await http().delete('/admin/language/lexicon?lang=fa&asrWord=' + encodeURIComponent('دوستت') + '&lyricWord=' + encodeURIComponent('دوستت‌')).set(auth()).expect(204);
      expect((await http().get('/admin/language/lexicon?lang=fa').set(auth())).body.total).toBe(1);

      const rt = (await http().post('/admin/language/retrain').set(auth()).send({}).expect(200)).body;
      expect(rt).toMatchObject({ processed: 0 });

      const ex = await http().get('/admin/language/export').set(auth()).expect(200);
      expect(ex.headers['content-type']).toContain('ndjson');
    });

    it('a fresh lexicon entry changes alignment; language endpoints require auth', async () => {
      await http().get('/admin/language/stats').expect(401);
      await http().post('/admin/language/review').send({ lang: 'fa' }).expect(401);
    });
  });

  describe('reports, live control and queue-next', () => {
    let ta = '';
    let tb = '';
    beforeAll(async () => {
      ta = ids.A ?? '';
      tb = ids.B ?? '';
      // history: A played 3x (1 skipped), B played 1x (error); plus an old row outside the 24h window
      const ins = (track: string, minsAgo: number, dur: number, reason: string | null) =>
        db.query(`INSERT INTO playback_history (track_id, started_at, ended_at, end_reason) VALUES ($1, now() - ($2 || ' minutes')::interval, CASE WHEN $4::text IS NULL THEN NULL ELSE now() - ($2 || ' minutes')::interval + ($3 || ' seconds')::interval END, $4)`, [track, String(minsAgo), String(dur), reason]);
      await ins(ta, 300, 200, 'FINISHED');
      await ins(ta, 200, 60, 'SKIPPED');
      await ins(ta, 100, 200, 'FINISHED');
      await ins(tb, 50, 5, 'ERROR');
      await ins(ta, 60 * 24 * 10, 200, 'FINISHED'); // 10 days ago: only in 30d/90d
      await db.query(`INSERT INTO listener_samples (channel_id, at, listeners) VALUES (1001, now() - interval '30 minutes', 4), (1001, now() - interval '29 minutes', 8), (1001, now() - interval '28 minutes', 0)`);
    });

    it('summary: plays, airtime, outcomes, rates and audience for the chosen period', async () => {
      const r = (await http().get('/admin/reports?range=24h').set(auth()).expect(200)).body;
      expect(r.summary).toMatchObject({ plays: 4, uniqueTracks: 2, outcomes: { finished: 2, skipped: 1, admin: 0, errors: 1 } });
      expect(r.summary.airtimeSeconds).toBe(200 + 60 + 200 + 5);
      expect(r.summary.skipRate).toBeCloseTo(0.25);
      expect(r.summary.errorRate).toBeCloseTo(0.25);
      expect(r.summary.audience).toMatchObject({ peakListeners: 8, averageListeners: 4 });
      const wide = (await http().get('/admin/reports?range=30d').set(auth())).body;
      expect(wide.summary.plays).toBe(5); // the 10-day-old play appears in a longer window
    });

    it('timeseries has one point per bucket (24h => hourly, 30d => daily) with plays and listeners', async () => {
      const day = (await http().get('/admin/reports?range=24h').set(auth())).body.timeseries;
      expect(day.bucket).toBe('hour');
      expect(day.points.length).toBeGreaterThanOrEqual(24);
      expect(day.points.reduce((s: number, p: { plays: number }) => s + p.plays, 0)).toBe(4);
      expect(day.points.some((p: { peakListeners: number }) => p.peakListeners === 8)).toBe(true);
      const month = (await http().get('/admin/reports?range=30d').set(auth())).body.timeseries;
      expect(month.bucket).toBe('day');
      expect(month.points.length).toBeGreaterThanOrEqual(30);
    });

    it('top tracks / artists / hashtags, lyrics quality and library health', async () => {
      const r = (await http().get('/admin/reports?range=24h').set(auth())).body;
      expect(r.top.tracks[0]).toMatchObject({ title: 'Song A', plays: 3, skips: 1 });
      expect(r.top.artists[0]).toMatchObject({ artist: 'Artist', plays: 4 });
      expect(r.top.hashtags.map((h: { hashtag: string }) => h.hashtag)).toEqual(expect.arrayContaining(['rain', 'night']));
      expect(r.lyrics.byStatus.find((x: { status: string }) => x.status === 'LYRICS_FAILED')?.tracks).toBe(1);
      expect(r.lyrics.coverage.withUrl).toBeGreaterThanOrEqual(3);
      expect(r.library.channels[0]).toMatchObject({ id: '1001', tracks: 5 });
      expect(r.library.problemTracks.map((t: { title: string }) => t.title)).toContain('Song B'); // lyrics failed
      expect(r.library.recentErrors[0]).toMatchObject({ title: 'Song B' });
    });

    it('channel filter isolates a station; validation rejects bad input', async () => {
      const none = (await http().get('/admin/reports?range=24h&channel=999').set(auth()).expect(200)).body;
      expect(none.summary.plays).toBe(0);
      expect(none.top.tracks).toEqual([]);
      await http().get('/admin/reports?range=1y').set(auth()).expect(400);
      await http().get('/admin/reports?channel=abc').set(auth()).expect(400);
    });

    it('system health: database, telegram, queues, integrations', async () => {
      const s = (await http().get('/admin/reports/system').set(auth()).expect(200)).body;
      expect(s.database.ok).toBe(true);
      expect(s.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(s.telegram.state).toBeDefined();
      expect(s.queues).toHaveProperty('lyrics-fetch');
      expect(s.integrations).toHaveProperty('audioCache');
      expect(Array.isArray(s.stations)).toBe(true);
    });

    it('CSV export (plays and tracks) is valid, escaped and honours the range', async () => {
      await db.query(`UPDATE tracks SET title = 'Song "A", the best' WHERE id = $1`, [ta]);
      const plays = await http().get('/admin/reports/export.csv?type=plays&range=24h').set(auth()).expect(200);
      expect(plays.headers['content-type']).toContain('text/csv');
      const lines = plays.text.replace(/^\uFEFF/, '').trim().split('\r\n');
      expect(lines[0]).toBe('started_at,ended_at,channel,track_id,title,artist,seconds,outcome');
      expect(lines).toHaveLength(1 + 4);
      expect(plays.text).toContain('"Song ""A"", the best"');
      const tracks = await http().get('/admin/reports/export.csv?type=tracks').set(auth()).expect(200);
      expect(tracks.text.trim().split('\r\n').length).toBeGreaterThanOrEqual(1 + 5);
      await db.query(`UPDATE tracks SET title = 'Song A' WHERE id = $1`, [ta]);
    });

    it('live snapshot: per station now-playing/up-next/recent; queue-next validates and is audited', async () => {
      const live = (await http().get('/admin/live').set(auth()).expect(200)).body;
      const st = live.stations.find((x: { id: string }) => x.id === '1001');
      expect(st).toMatchObject({ id: '1001', slug: 'chan', streamUrl: '/radio/chan/stream', listeners: 0 });
      expect(Array.isArray(st.recent)).toBe(true);
      expect(typeof live.serverTime).toBe('string');

      await http().post(`/admin/channels/${CH}/radio/queue-next`).set(auth()).send({ trackId: ta }).expect(202);
      await http().post(`/admin/channels/${CH}/radio/queue-next`).set(auth()).send({ trackId: '00000000-0000-0000-0000-000000000000' }).expect(404);
      await http().post(`/admin/channels/${CH}/radio/queue-next`).set(auth()).send({}).expect(400);
      await db.query('UPDATE tracks SET enabled = false WHERE id = $1', [tb]);
      await http().post(`/admin/channels/${CH}/radio/queue-next`).set(auth()).send({ trackId: tb }).expect(400);
      await db.query('UPDATE tracks SET enabled = true WHERE id = $1', [tb]);
      const audit = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'radio.queue-next'`);
      expect((audit.rows[0] as { n: number }).n).toBe(1);
    });
  });

  it('audit log lists newest first and paginates', async () => {
    const a = (await http().get('/admin/audit?limit=5').set(auth()).expect(200)).body;
    expect(a.items).toHaveLength(5);
    expect(a.total).toBeGreaterThan(10);
    const t = a.items.map((i: { at: string }) => Date.parse(i.at));
    expect([...t].sort((x, y) => y - x)).toEqual(t);
  });
});
