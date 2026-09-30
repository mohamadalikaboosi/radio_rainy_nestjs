import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { sign } from 'jsonwebtoken';
import { ADMIN, bootAdminApp, FakeTelegramManager } from '../../test/admin-app';
import { DatabaseService } from '../database/database.service';

describe('Super Admin API (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let manager: FakeTelegramManager;
  let restore: () => void;
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  async function seedTrack(msg: number, title: string, tags: string[], over: { enabled?: boolean; lyrics?: string } = {}): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO tracks (telegram_channel_id, telegram_message_id, title, artist, telegram_file_reference, mime_type, duration, file_size, enabled, lyrics_status, lyrics_url)
       VALUES (1, $1, $2, 'Artist', 'ref', 'audio/mpeg', 200, 3200000, $3, $4, $5) RETURNING id`,
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
    ({ app, manager, restore } = await bootAdminApp());
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
      expect((await http().get('/admin/auth/me').set(auth()).expect(200)).body).toEqual({ email: ADMIN.email, role: 'SUPER_ADMIN' });
    });
  });

  describe('dashboard', () => {
    it('shows counts, selection and telegram state', async () => {
      const d = (await http().get('/admin/dashboard').set(auth()).expect(200)).body;
      expect(d.counts).toMatchObject({ totalTracks: 5, playableTracks: 5, tracksWithLyrics: 1, tracksWaitingForLyrics: 1, failedLyrics: 1, hashtags: 4 });
      expect(d.radio.selection.mode).toBe('GLOBAL_RANDOM');
      expect(d.telegram.state).toBe('NOT_LOGGED_IN');
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
      const cur = (await http().get('/admin/radio/config').set(auth()).expect(200)).body;
      const r = await http().put('/admin/radio/config').set(auth()).send({
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
      const cur = (await http().get('/admin/radio/config').set(auth())).body;
      const base = { mode: 'GLOBAL_RANDOM', hashtagMatchMode: 'ANY', recentTrackWindow: 3, hashtags: [] };
      await http().put('/admin/radio/config').set(auth()).send({ ...base, expectedVersion: cur.version - 1 }).expect(409);
      await http().put('/admin/radio/config').set(auth()).send({ ...base, hashtags: [{ hashtag: 'doesnotexist' }] }).expect(400);
      await http().put('/admin/radio/config').set(auth()).send({ ...base, mode: 'NOPE' }).expect(400);
      await http().put('/admin/radio/config').set(auth()).send({ ...base, recentTrackWindow: -1 }).expect(400);
      expect((await http().get('/admin/radio/config').set(auth())).body.version).toBe(cur.version); // nothing changed
    });

    it('concurrent updates with the same expectedVersion: exactly one wins, version increments once', async () => {
      const cur = (await http().get('/admin/radio/config').set(auth())).body;
      const body = { mode: 'GLOBAL_RANDOM', hashtagMatchMode: 'ANY', recentTrackWindow: 5, hashtags: [], expectedVersion: cur.version };
      const res = await Promise.all(Array.from({ length: 10 }, () => http().put('/admin/radio/config').set(auth()).send(body)));
      expect(res.filter((r) => r.status === 200)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(9);
      expect((await http().get('/admin/radio/config').set(auth())).body.version).toBe(cur.version + 1);
    });

    it('preview uses the real engine: ANY -> A,C,D,E ; ALL -> A,E ; deterministic per seed', async () => {
      const any = (await http().post('/admin/radio/preview').set(auth()).send({ mode: 'HASHTAG_RANDOM', hashtags: ['rain', 'night'], match: 'ANY', limit: 40, seed: 12345 }).expect(200)).body;
      expect(any.eligibleCount).toBe(4);
      expect(new Set(any.tracks.map((t: { title: string }) => t.title))).toEqual(new Set(['Song A', 'Song C', 'Song D', 'Song E']));
      const all = (await http().post('/admin/radio/preview').set(auth()).send({ mode: 'HASHTAG_RANDOM', hashtags: ['rain', 'night'], match: 'ALL', limit: 40, seed: 12345, recentTrackWindow: 1 }).expect(200)).body;
      expect(all.eligibleCount).toBe(2);
      expect(new Set(all.tracks.map((t: { title: string }) => t.title))).toEqual(new Set(['Song A', 'Song E']));
      const again = (await http().post('/admin/radio/preview').set(auth()).send({ mode: 'HASHTAG_RANDOM', hashtags: ['rain', 'night'], match: 'ANY', limit: 40, seed: 12345 })).body;
      expect(again.tracks.map((t: { id: string }) => t.id)).toEqual(any.tracks.map((t: { id: string }) => t.id));
    });

    it('rules: CRUD, priority evaluation in preview, persisted with audit', async () => {
      const r1 = (await http().post('/admin/radio/rules').set(auth()).send({ name: 'Late night rain', priority: 1, matchMode: 'ALL', include: ['rain', 'night'], exclude: ['chill'], weight: 80 }).expect(201)).body;
      expect(r1).toMatchObject({ name: 'Late night rain', include: ['rain', 'night'], exclude: ['chill'] });
      await http().post('/admin/radio/rules').set(auth()).send({ name: 'Chill', priority: 2, include: ['chill'] }).expect(201);
      const p = (await http().post('/admin/radio/preview').set(auth()).send({ mode: 'CUSTOM_RULE', limit: 20, seed: 1, recentTrackWindow: 0 }).expect(200)).body;
      expect(new Set(p.tracks.map((t: { title: string }) => t.title))).toEqual(new Set(['Song A'])); // priority 1 wins, E excluded by #chill
      await http().put(`/admin/radio/rules/${r1.id}`).set(auth()).send({ name: 'Late night rain', priority: 1, matchMode: 'ALL', include: ['rain', 'night'], exclude: [], enabled: false }).expect(200);
      const p2 = (await http().post('/admin/radio/preview').set(auth()).send({ mode: 'CUSTOM_RULE', limit: 30, seed: 1, recentTrackWindow: 0 })).body;
      expect(new Set(p2.tracks.map((t: { title: string }) => t.title))).toEqual(new Set(['Song C', 'Song D', 'Song E']));
      await http().delete(`/admin/radio/rules/${r1.id}`).set(auth()).expect(204);
      await http().delete(`/admin/radio/rules/${r1.id}`).set(auth()).expect(404);
      await http().post('/admin/radio/rules').set(auth()).send({ name: 'x', priority: 1, include: [] }).expect(400);
      const actions = (await http().get('/admin/audit?entityType=radio_rule&limit=50').set(auth())).body.items.map((i: { action: string }) => i.action);
      expect(actions).toEqual(expect.arrayContaining(['radio.rule.create', 'radio.rule.update', 'radio.rule.delete']));
    });

    it('skip / play-next are accepted, audited; play-next validates the track', async () => {
      await http().post('/admin/radio/skip').set(auth()).send({}).expect(202);
      await http().post('/admin/radio/play-next').set(auth()).send({}).expect(202);
      await http().post('/admin/radio/play-next').set(auth()).send({ trackId: ids.A }).expect(202);
      await http().post('/admin/radio/play-next').set(auth()).send({ trackId: '00000000-0000-0000-0000-000000000000' }).expect(404);
      await db.query('UPDATE tracks SET enabled = false WHERE id = $1', [ids.D]);
      await http().post('/admin/radio/play-next').set(auth()).send({ trackId: ids.D }).expect(400);
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

  it('audit log lists newest first and paginates', async () => {
    const a = (await http().get('/admin/audit?limit=5').set(auth()).expect(200)).body;
    expect(a.items).toHaveLength(5);
    expect(a.total).toBeGreaterThan(10);
    const t = a.items.map((i: { at: string }) => Date.parse(i.at));
    expect([...t].sort((x, y) => y - x)).toEqual(t);
  });
});
