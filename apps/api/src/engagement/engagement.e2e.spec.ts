import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN, bootAdminApp } from '../../test/admin-app';
import { DatabaseService } from '../database/database.service';

const CH = '1001';
/** 10 s of 128 kbps MPEG1-L3 frames (only the first header matters to the inspector). */
const mp3 = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(16000 * 10 - 4)]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('ads, sponsors, tag vote and manual live target (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let restore: () => void;
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, restore } = await bootAdminApp());
    db = app.get(DatabaseService);
    token = (await http().post('/admin/auth/login').send(ADMIN).expect(200)).body.token;
  });
  afterAll(async () => {
    await app.close();
    restore();
  });

  describe('auth', () => {
    it('every new admin endpoint requires a token', async () => {
      for (const [m, url] of [['get', '/admin/ads'], ['post', '/admin/ads'], ['get', '/admin/sponsors'], ['get', `/admin/channels/${CH}/engagement`], ['put', `/admin/channels/${CH}/live-target`]] as const) {
        await http()[m](url).expect(401);
      }
    });
  });

  describe('ads', () => {
    let adId: string;

    it('creates an ad, uploads MP3 audio (duration detected) and artwork, and lists it without blobs', async () => {
      const created = await http().post('/admin/ads').set(auth()).send({ name: 'Coffee shop', linkUrl: 'https://coffee.example/?a=1', ctaLabel: 'Order' }).expect(201);
      adId = created.body.id;
      expect(created.body).toMatchObject({ name: 'Coffee shop', weight: 1, enabled: true, hasAudio: false, hasImage: false, channelId: null });

      const audio = await http().put(`/admin/ads/${adId}/audio`).set(auth()).set('Content-Type', 'audio/mpeg').send(mp3()).expect(200);
      expect(audio.body).toMatchObject({ hasAudio: true, audioMime: 'audio/mpeg', durationSeconds: 10 });
      await http().put(`/admin/ads/${adId}/image`).set(auth()).set('Content-Type', 'image/png').send(PNG).expect(200);

      const list = await http().get('/admin/ads').set(auth()).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ id: adId, hasAudio: true, hasImage: true });
      expect(JSON.stringify(list.body)).not.toContain('"audio":');
    });

    it('validates input: bad link scheme, weight, non-audio/invalid MP3, unsafe image types, oversize', async () => {
      await http().post('/admin/ads').set(auth()).send({ name: 'x', linkUrl: 'javascript:alert(1)' }).expect(400);
      await http().post('/admin/ads').set(auth()).send({ name: 'x', weight: 0 }).expect(400);
      await http().post('/admin/ads').set(auth()).send({ name: '' }).expect(400);
      await http().put(`/admin/ads/${adId}/audio`).set(auth()).set('Content-Type', 'text/plain').send('hello').expect(400);
      await http().put(`/admin/ads/${adId}/audio`).set(auth()).set('Content-Type', 'audio/mpeg').send(Buffer.from('definitely not an mp3')).expect(400);
      await http().put(`/admin/ads/${adId}/image`).set(auth()).set('Content-Type', 'image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg"/>').expect(400);
      await http().put(`/admin/ads/${adId}/audio`).set(auth()).set('Content-Type', 'audio/mpeg').send(Buffer.alloc(11 * 1024 * 1024, 1)).expect(413);
      await http().put('/admin/ads/00000000-0000-4000-8000-000000000000/image').set(auth()).set('Content-Type', 'image/png').send(PNG).expect(404);
    });

    it('serves the artwork safely and counts clicks through a redirect that only targets the admin-saved link', async () => {
      const img = await http().get(`/radio/ads/${adId}/image`).expect(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.headers['x-content-type-options']).toBe('nosniff');
      expect(img.headers['content-security-policy']).toBe("default-src 'none'");
      const go = await http().get(`/radio/go/ad/${adId}`).redirects(0).expect(302);
      expect(go.headers.location).toBe('https://coffee.example/?a=1');
      expect((await http().get('/admin/ads').set(auth())).body[0].clicks).toBe(1);
      const noLink = (await http().post('/admin/ads').set(auth()).send({ name: 'no link' })).body.id as string;
      await http().get(`/radio/go/ad/${noLink}`).redirects(0).expect(404);
      await http().delete(`/admin/ads/${noLink}`).set(auth()).expect(204);
    });

    it('the public "current" view reports the ad on air (and no lyrics) while it plays', async () => {
      await db.query(`UPDATE radio_state SET ad_id = $1, ad_started_at = now() WHERE channel_id = $2`, [adId, CH]);
      const cur = await http().get('/radio/chan/current').expect(200);
      expect(cur.body).toMatchObject({ status: 'AD', ad: { id: adId, name: 'Coffee shop', duration: 10, ctaLabel: 'Order', linkUrl: `/radio/go/ad/${adId}`, imageUrl: `/radio/ads/${adId}/image` } });
      expect(cur.body.trackId).toBeUndefined();
      expect((await http().get('/radio/chan/current/lyrics').expect(200)).body).toEqual({ status: 'NONE' });
      await db.query('UPDATE radio_state SET ad_id = NULL, ad_started_at = NULL');
    });

    it('updates, disables, audits and deletes', async () => {
      const upd = await http().patch(`/admin/ads/${adId}`).set(auth()).send({ weight: 5, enabled: false, channelId: CH }).expect(200);
      expect(upd.body).toMatchObject({ weight: 5, enabled: false, channelId: CH });
      expect((await http().get('/admin/ads').query({ channelId: '2002' }).set(auth())).body).toHaveLength(0);
      const audit = await db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE entity_type = 'ad' ORDER BY at`);
      expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['ad.create', 'ad.audio', 'ad.image', 'ad.update']));
      await http().delete(`/admin/ads/${adId}`).set(auth()).expect(204);
      await http().delete(`/admin/ads/${adId}`).set(auth()).expect(404);
    });
  });

  describe('sponsors', () => {
    it('shows only enabled sponsors inside their date window, with a tracked link button', async () => {
      const day = 86_400_000;
      const mk = (over: object) => http().post('/admin/sponsors').set(auth()).send({ name: 'S', url: 'https://s.example', ...over }).expect(201);
      const live = (await mk({ name: 'Live', tagline: 'Best coffee', ctaLabel: 'Buy now' })).body.id as string;
      await mk({ name: 'Off', enabled: false });
      await mk({ name: 'Future', startsAt: new Date(Date.now() + day).toISOString() });
      await mk({ name: 'Expired', endsAt: new Date(Date.now() - day).toISOString() });
      await http().post('/admin/sponsors').set(auth()).send({ name: 'Bad', url: 'ftp://x' }).expect(400);
      await http().put(`/admin/sponsors/${live}/logo`).set(auth()).set('Content-Type', 'image/png').send(PNG).expect(200);

      const pub = await http().get('/radio/chan/sponsors').expect(200);
      expect(pub.body).toEqual([{ id: live, name: 'Live', tagline: 'Best coffee', ctaLabel: 'Buy now', weight: 1, logoUrl: `/radio/sponsors/${live}/logo`, url: `/radio/go/sponsor/${live}` }]);
      expect(JSON.stringify(pub.body)).not.toContain('s.example'); // the real target is only reachable through the tracked redirect
      await http().get(`/radio/sponsors/${live}/logo`).expect(200);
      const go = await http().get(`/radio/go/sponsor/${live}`).redirects(0).expect(302);
      expect(go.headers.location).toBe('https://s.example');
      const row = (await http().get('/admin/sponsors').set(auth())).body.find((s: { id: string }) => s.id === live);
      expect(row).toMatchObject({ clicks: 1 });
      await http().get('/radio/nope/sponsors').expect(404);
    });
  });

  describe('engagement settings and the tag vote', () => {
    async function seed(): Promise<void> {
      let n = 100;
      for (const tag of ['rock', 'jazz']) {
        for (let i = 0; i < 2; i++) {
          const t = await db.query<{ id: string }>(`INSERT INTO tracks (telegram_channel_id, telegram_message_id, title, artist, telegram_file_reference, mime_type, duration, file_size) VALUES (1001, $1, 'S', 'A', 'r', 'audio/mpeg', 100, 1600000) RETURNING id`, [n++]);
          const h = await db.query<{ id: string }>(`INSERT INTO hashtags (value, normalized_value) VALUES ($1,$1) ON CONFLICT (normalized_value) DO UPDATE SET value = hashtags.value RETURNING id`, [tag]);
          await db.query('INSERT INTO track_hashtags (track_id, hashtag_id) VALUES ($1,$2)', [t.rows[0]?.id, h.rows[0]?.id]);
        }
      }
    }

    it('has safe defaults and validates the settings', async () => {
      expect((await http().get(`/admin/channels/${CH}/engagement`).set(auth()).expect(200)).body).toMatchObject({ adsEveryNTracks: 0, tagVoteEnabled: false });
      const ok = { adsEveryNTracks: 3, tagVoteEnabled: true, tagVoteIntervalMinutes: 30, tagVotePollMinutes: 2, tagVotePlayMinutes: 15, tagVoteOptions: 3, tagVoteAllowlist: ['#Rock', 'jazz', 'rock'] };
      const saved = await http().put(`/admin/channels/${CH}/engagement`).set(auth()).send(ok).expect(200);
      expect(saved.body).toMatchObject({ adsEveryNTracks: 3, tagVoteAllowlist: ['rock', 'jazz'] });
      await http().put(`/admin/channels/${CH}/engagement`).set(auth()).send({ ...ok, tagVoteOptions: 1 }).expect(400);
      await http().put(`/admin/channels/${CH}/engagement`).set(auth()).send({ ...ok, adsEveryNTracks: -1 }).expect(400);
      await http().put(`/admin/channels/2002/engagement`).set(auth()).send(ok).expect(404);
    });

    it('an admin starts a vote; listeners see it, vote once (changeable) and the tally is public', async () => {
      await http().post(`/admin/channels/${CH}/tag-votes/start`).set(auth()).expect(400); // no tags yet
      await seed();
      const started = await http().post(`/admin/channels/${CH}/tag-votes/start`).set(auth()).expect(200);
      expect(started.body.status).toBe('OPEN');

      const view = await http().get('/radio/chan/vote').query({ voterId: 'listener-0001' }).expect(200);
      expect(view.body.poll.options.map((o: { hashtag: string }) => o.hashtag).sort()).toEqual(['jazz', 'rock']);
      await http().post('/radio/chan/vote').send({ voterId: 'listener-0001', hashtag: 'jazz' }).expect(200);
      const after = await http().post('/radio/chan/vote').send({ voterId: 'listener-0001', hashtag: 'rock' }).expect(200);
      expect(after.body.myVote).toBe('rock');
      expect(after.body.poll.totalVotes).toBe(1);
      await http().post('/radio/chan/vote').send({ voterId: 'listener-0002', hashtag: 'metal' }).expect(400);
      await http().post('/radio/chan/vote').send({ voterId: 'short', hashtag: 'rock' }).expect(400);
      await http().post('/radio/nope/vote').send({ voterId: 'listener-0001', hashtag: 'rock' }).expect(404);

      const hist = await http().get(`/admin/channels/${CH}/tag-votes`).set(auth()).expect(200);
      expect(hist.body.current.status).toBe('OPEN');
      expect(hist.body.history[0].tally).toEqual({ rock: 1 });
    });
  });

  describe('manual live target (link + stream key)', () => {
    const live = () => http().get('/admin/channels').set(auth()).then((r) => r.body.find((c: { id: string }) => c.id === CH));

    it('saves a link and key, never returns the key, and can be cleared', async () => {
      const r = await http().put(`/admin/channels/${CH}/live-target`).set(auth()).send({ url: 'rtmps://dc4-1.rtmp.t.me/s/', key: '1946981618:SECRET-key_1' }).expect(200);
      expect(r.body).toMatchObject({ liveRtmpUrl: 'rtmps://dc4-1.rtmp.t.me/s/', liveRtmpKeySet: true });
      expect(JSON.stringify(r.body)).not.toContain('SECRET');
      expect(JSON.stringify(await live())).not.toContain('SECRET');
      expect((await db.query('SELECT live_rtmp_key_enc FROM channels WHERE telegram_channel_id = 1001')).rows[0]).not.toMatchObject({ live_rtmp_key_enc: expect.stringContaining('SECRET') });
      const audit = JSON.stringify((await db.query(`SELECT before, after FROM audit_logs WHERE action LIKE 'channel.live.target%'`)).rows);
      expect(audit).not.toContain('SECRET');
      expect((await db.query('SELECT live_target_rev FROM channels WHERE telegram_channel_id = 1001')).rows[0]).toEqual({ live_target_rev: 1 });

      await http().delete(`/admin/channels/${CH}/live-target`).set(auth()).expect(200);
      expect(await live()).toMatchObject({ liveRtmpUrl: null, liveRtmpKeySet: false, liveTargetRev: 2 });
    });

    it('accepts one pasted link that ends with the key, and rejects non-rtmp links', async () => {
      const r = await http().put(`/admin/channels/${CH}/live-target`).set(auth()).send({ url: 'rtmps://dc4-1.rtmp.t.me/s/111:abc' }).expect(200);
      expect(r.body).toMatchObject({ liveRtmpUrl: 'rtmps://dc4-1.rtmp.t.me/s/', liveRtmpKeySet: true });
      await http().put(`/admin/channels/${CH}/live-target`).set(auth()).send({ url: 'https://example.com/s/', key: 'k' }).expect(400);
      await http().put(`/admin/channels/${CH}/live-target`).set(auth()).send({ url: 'rtmps://host/s/' }).expect(400);
      await http().put('/admin/channels/9999/live-target').set(auth()).send({ url: 'rtmps://host/s/', key: 'k' }).expect(404);
    });
  });
});
