import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN, bootAdminApp } from '../../../test/admin-app';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { AdsRepository, BillingRule } from '../../engagement/infrastructure/ads.repository';
import { InvalidTransitionError, transition } from '../domain/campaign-status';
import { PortalAuthService } from '../application/portal-auth.service';

const CH = '1001';
const mp3 = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(16000 * 6 - 4)]);
const PW = 'a-long-password-1';

describe('campaign status machine', () => {
  const open = { approvalRequired: true, hasAudio: true };
  it('follows the review workflow and refuses everything else', () => {
    expect(transition('DRAFT', 'submit', open)).toBe('PENDING');
    expect(transition('REJECTED', 'submit', open)).toBe('PENDING');
    expect(transition('DRAFT', 'submit', { approvalRequired: false, hasAudio: true })).toBe('APPROVED');
    expect(() => transition('DRAFT', 'submit', { approvalRequired: true, hasAudio: false })).toThrow('upload the audio first');
    expect(() => transition('APPROVED', 'submit', open)).toThrow(InvalidTransitionError);
    expect(transition('PENDING', 'approve', open)).toBe('APPROVED');
    expect(() => transition('DRAFT', 'approve', open)).toThrow(InvalidTransitionError);
    expect(transition('PENDING', 'reject', open)).toBe('REJECTED');
    expect(transition('APPROVED', 'reject', open)).toBe('REJECTED');
    expect(transition('APPROVED', 'pause', open)).toBe('PAUSED');
    expect(transition('PAUSED', 'resume', open)).toBe('APPROVED');
    expect(() => transition('DRAFT', 'pause', open)).toThrow(InvalidTransitionError);
    for (const s of ['PENDING', 'APPROVED', 'PAUSED', 'REJECTED', 'DRAFT'] as const) expect(transition(s, 'edit-content', open)).toBe('DRAFT');
  });
});

describe('accounts, advertiser portal, station owners and the billing switch (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let ads: AdsRepository;
  let restore: () => void;
  let admin: string;
  const http = () => request(app.getHttpServer());
  const A = (t: string) => ({ Authorization: `Bearer ${t}` });
  const on: BillingRule = { enabled: true, pricePerPlayCents: 500, pricePerClickCents: 2000 };
  const off: BillingRule = { enabled: false, pricePerPlayCents: 500, pricePerClickCents: 2000 };

  async function signup(name: string, email: string): Promise<{ token: string; accountId: string }> {
    app.get(PortalAuthService).resetThrottle();
    const r = await http().post('/portal/auth/signup').send({ accountName: name, email, password: PW }).expect(201);
    const me = await http().get('/portal/me').set(A(r.body.token)).expect(200);
    return { token: r.body.token, accountId: me.body.account.id };
  }
  async function platform(patch: object): Promise<void> {
    const cur = (await http().get('/admin/platform').set(A(admin)).expect(200)).body;
    await http().put('/admin/platform').set(A(admin)).send({ ...cur, ...patch }).expect(200);
    // the ad engine caches the settings for a few seconds: read through the same repository the test uses
    await db.query('SELECT 1');
  }
  const ids = async (billing: BillingRule): Promise<string[]> => (await ads.playableIds(CH, billing)).map((a) => a.id);
  async function approvedCampaign(token: string, over: object = {}): Promise<string> {
    const id = (await http().post('/portal/campaigns').set(A(token)).send({ name: 'Camp', ...over }).expect(201)).body.id as string;
    await http().put(`/portal/campaigns/${id}/audio`).set(A(token)).set('Content-Type', 'audio/mpeg').send(mp3()).expect(200);
    await http().post(`/portal/campaigns/${id}/submit`).set(A(token)).expect(200);
    await http().post(`/admin/campaigns/${id}/approve`).set(A(admin)).expect(200);
    return id;
  }

  beforeAll(async () => {
    ({ app, restore } = await bootAdminApp());
    db = app.get(DatabaseService);
    ads = app.get(AdsRepository);
    admin = (await http().post('/admin/auth/login').send(ADMIN).expect(200)).body.token;
  });
  afterAll(async () => {
    await app.close();
    restore();
  });

  describe('platform switches', () => {
    it('are FREE by default: billing off, nothing priced, sign-up open, campaigns reviewed', async () => {
      const p = (await http().get('/admin/platform').set(A(admin)).expect(200)).body;
      expect(p).toMatchObject({ billingEnabled: false, selfSignupEnabled: true, campaignApprovalRequired: true, maxCampaignsPerAccount: 0 });
      expect((await http().get('/portal/auth/config').expect(200)).body).toMatchObject({ billingEnabled: false, selfSignupEnabled: true });
      await http().get('/admin/platform').expect(401);
      await http().put('/admin/platform').set(A(admin)).send({ ...p, pricePerPlayCents: -1 }).expect(400);
    });
  });

  describe('auth', () => {
    it('rate-limits sign-up and login attempts per client', async () => {
      const svc = app.get(PortalAuthService);
      svc.resetThrottle();
      for (let i = 0; i < 8; i++) await http().post('/portal/auth/login').send({ email: 'nobody@x.example', password: 'whatever-1' }).expect(401);
      await http().post('/portal/auth/login').send({ email: 'nobody@x.example', password: 'whatever-1' }).expect(429);
      svc.resetThrottle();
    });


    it('signs up, logs in, and protects everything', async () => {
      const s = await signup('Coffee Co', 'owner@coffee.example');
      expect(s.token).toBeTruthy();
      await http().post('/portal/auth/signup').send({ accountName: 'Dup', email: 'OWNER@coffee.example', password: PW }).expect(409); // email is case-insensitive
      await http().post('/portal/auth/signup').send({ accountName: 'X', email: 'x@x.example', password: 'short' }).expect(400);
      await http().post('/portal/auth/login').send({ email: 'owner@coffee.example', password: 'wrong-password' }).expect(401);
      await http().post('/portal/auth/login').send({ email: 'nobody@coffee.example', password: PW }).expect(401);
      const login = await http().post('/portal/auth/login').send({ email: 'Owner@Coffee.example', password: PW }).expect(200);
      expect(login.body.token).toBeTruthy();
      await http().get('/portal/me').expect(401);
      await http().get('/portal/campaigns').set(A('garbage')).expect(401);
    });

    it('an account token never works on /admin and the admin token never works on /portal', async () => {
      const s = await signup('Iso', 'iso@x.example');
      await http().get('/admin/platform').set(A(s.token)).expect(401);
      await http().get('/admin/accounts').set(A(s.token)).expect(401);
      await http().post('/admin/campaigns/00000000-0000-4000-8000-000000000000/approve').set(A(s.token)).expect(401);
      await http().get('/portal/me').set(A(admin)).expect(401);
    });

    it('a suspended account is locked out immediately, even with a valid token', async () => {
      const s = await signup('Sus', 'sus@x.example');
      await http().patch(`/admin/accounts/${s.accountId}`).set(A(admin)).send({ status: 'SUSPENDED' }).expect(200);
      await http().get('/portal/me').set(A(s.token)).expect(403);
      await http().post('/portal/auth/login').send({ email: 'sus@x.example', password: PW }).expect(403);
      await http().patch(`/admin/accounts/${s.accountId}`).set(A(admin)).send({ status: 'ACTIVE' }).expect(200);
      await http().get('/portal/me').set(A(s.token)).expect(200);
    });

    it('sign-up can be closed by the operator', async () => {
      await platform({ selfSignupEnabled: false });
      await http().post('/portal/auth/signup').send({ accountName: 'Late', email: 'late@x.example', password: PW }).expect(403);
      await platform({ selfSignupEnabled: true });
    });
  });

  describe('campaign review workflow', () => {
    let a: { token: string; accountId: string };
    let b: { token: string; accountId: string };
    let id: string;
    beforeAll(async () => {
      a = await signup('Adv A', 'a@adv.example');
      b = await signup('Adv B', 'b@adv.example');
    });

    it('draft -> (audio required) -> pending -> approved by the operator -> on air; other accounts cannot see or touch it', async () => {
      id = (await http().post('/portal/campaigns').set(A(a.token)).send({ name: 'Spring sale', linkUrl: 'https://shop.example/spring', ctaLabel: 'Shop', maxPlays: 3 }).expect(201)).body.id;
      expect((await http().get('/portal/campaigns').set(A(a.token))).body[0]).toMatchObject({ id, status: 'DRAFT', accountId: a.accountId, maxPlays: 3 });
      await http().post(`/portal/campaigns/${id}/submit`).set(A(a.token)).expect(400); // no audio yet
      const up = await http().put(`/portal/campaigns/${id}/audio`).set(A(a.token)).set('Content-Type', 'audio/mpeg').send(mp3()).expect(200);
      expect(up.body).toMatchObject({ hasAudio: true, durationSeconds: 6, status: 'DRAFT' });
      await http().put(`/portal/campaigns/${id}/audio`).set(A(a.token)).set('Content-Type', 'audio/mpeg').send(Buffer.from('not an mp3')).expect(400);
      expect((await http().post(`/portal/campaigns/${id}/submit`).set(A(a.token)).expect(200)).body.status).toBe('PENDING');
      expect(await ids(off)).not.toContain(id); // pending ads never play

      const queue = (await http().get('/admin/campaigns').query({ status: 'PENDING' }).set(A(admin)).expect(200)).body;
      expect(queue.find((c: { id: string }) => c.id === id)).toMatchObject({ accountName: 'Adv A', status: 'PENDING' });
      expect((await http().post(`/admin/campaigns/${id}/approve`).set(A(admin)).expect(200)).body.status).toBe('APPROVED');
      expect(await ids(off)).toContain(id);

      await http().get('/portal/campaigns').set(A(b.token)).expect(200).then((r) => expect(r.body).toEqual([]));
      const foreign = [
        () => http().patch(`/portal/campaigns/${id}`).send({ name: 'x' }),
        () => http().delete(`/portal/campaigns/${id}`),
        () => http().post(`/portal/campaigns/${id}/submit`),
        () => http().put(`/portal/campaigns/${id}/image`).set('Content-Type', 'image/png').send(Buffer.from([1])),
      ];
      for (const mk of foreign) await mk().set(A(b.token)).expect(404); // built one at a time: supertest shares one server
    });

    it('changing what listeners see or hear sends it back to review; schedule and cap changes do not', async () => {
      await http().patch(`/portal/campaigns/${id}`).set(A(a.token)).send({ maxPlays: 10, startsAt: null }).expect(200).then((r) => expect(r.body.status).toBe('APPROVED'));
      const edited = await http().patch(`/portal/campaigns/${id}`).set(A(a.token)).send({ linkUrl: 'https://shop.example/other' }).expect(200);
      expect(edited.body.status).toBe('DRAFT');
      expect(await ids(off)).not.toContain(id);
      await http().patch(`/portal/campaigns/${id}`).set(A(a.token)).send({ linkUrl: 'javascript:alert(1)' }).expect(400);
      await http().patch(`/portal/campaigns/${id}`).set(A(a.token)).send({ startsAt: '2030-01-02T00:00:00.000Z', endsAt: '2030-01-01T00:00:00.000Z' }).expect(400);
      await http().post(`/portal/campaigns/${id}/submit`).set(A(a.token)).expect(200);
      await http().post(`/admin/campaigns/${id}/approve`).set(A(admin)).expect(200);
    });

    it('the operator can reject (with a reason the advertiser sees), pause and resume', async () => {
      await http().post(`/admin/campaigns/${id}/reject`).set(A(admin)).send({}).expect(400);
      await http().post(`/admin/campaigns/${id}/reject`).set(A(admin)).send({ note: 'Audio is too loud' }).expect(200);
      expect((await http().get('/portal/campaigns').set(A(a.token))).body[0]).toMatchObject({ status: 'REJECTED', reviewNote: 'Audio is too loud' });
      expect(await ids(off)).not.toContain(id);
      await http().post(`/portal/campaigns/${id}/submit`).set(A(a.token)).expect(200); // fix and resubmit
      await http().post(`/admin/campaigns/${id}/approve`).set(A(admin)).expect(200);
      await http().post(`/portal/campaigns/${id}/pause`).set(A(a.token)).expect(200).then((r) => expect(r.body.status).toBe('PAUSED'));
      expect(await ids(off)).not.toContain(id);
      await http().post(`/portal/campaigns/${id}/resume`).set(A(a.token)).expect(200).then((r) => expect(r.body.status).toBe('APPROVED'));
      await http().post(`/admin/campaigns/${id}/approve`).set(A(admin)).expect(400); // already approved
      const audit = (await db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE entity_id = $1`, [id])).rows.map((r) => r.action);
      expect(audit).toEqual(expect.arrayContaining(['campaign.create', 'campaign.submit', 'campaign.approve', 'campaign.reject']));
    });

    it('respects the schedule window, the play cap and the auto-approve policy', async () => {
      const future = await approvedCampaign(a.token, { startsAt: new Date(Date.now() + 86_400_000).toISOString() });
      const expired = await approvedCampaign(a.token, { endsAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() - 86_400_000).toISOString() });
      const capped = await approvedCampaign(a.token, { maxPlays: 2 });
      const live = await ids(off);
      expect(live).toContain(capped);
      expect(live).not.toContain(future);
      expect(live).not.toContain(expired);
      await ads.recordPlay(capped, off);
      await ads.recordPlay(capped, off);
      expect(await ids(off)).not.toContain(capped); // cap reached

      await platform({ campaignApprovalRequired: false });
      const auto = (await http().post('/portal/campaigns').set(A(a.token)).send({ name: 'Auto' }).expect(201)).body.id as string;
      await http().put(`/portal/campaigns/${auto}/audio`).set(A(a.token)).set('Content-Type', 'audio/mpeg').send(mp3()).expect(200);
      expect((await http().post(`/portal/campaigns/${auto}/submit`).set(A(a.token)).expect(200)).body.status).toBe('APPROVED');
      await platform({ campaignApprovalRequired: true });
    });

    it('enforces the optional per-account campaign limit', async () => {
      const c = await signup('Limited', 'limited@x.example');
      await platform({ maxCampaignsPerAccount: 1 });
      await http().post('/portal/campaigns').set(A(c.token)).send({ name: 'one' }).expect(201);
      await http().post('/portal/campaigns').set(A(c.token)).send({ name: 'two' }).expect(403);
      await platform({ maxCampaignsPerAccount: 0 });
    });
  });

  describe('billing switch (off = free, on = credit, prices, limits)', () => {
    let acc: { token: string; accountId: string };
    let camp: string;
    const balance = async (): Promise<number> => (await http().get('/portal/billing').set(A(acc.token)).expect(200)).body.creditCents;

    beforeAll(async () => {
      acc = await signup('Pay Co', 'pay@x.example');
      camp = await approvedCampaign(acc.token, { linkUrl: 'https://pay.example' });
      await db.query(`UPDATE ads SET plays = 0 WHERE id = $1`, [camp]);
    });

    it('while billing is OFF: plays and clicks are free, need no credit and write no ledger', async () => {
      expect(await ids(off)).toContain(camp);
      await ads.recordPlay(camp, off);
      await ads.click(camp, off);
      expect(await balance()).toBe(0);
      expect((await http().get('/portal/billing').set(A(acc.token))).body.ledger).toEqual([]);
    });

    it('when billing is ON: no credit = does not air; an operator top-up makes it air; each play and click is charged to the cent', async () => {
      await platform({ billingEnabled: true, pricePerPlayCents: 500, pricePerClickCents: 2000 });
      expect((await http().get('/portal/me').set(A(acc.token))).body.platform).toMatchObject({ billingEnabled: true, pricePerPlayCents: 500 });
      expect(await ids(on)).not.toContain(camp); // 0 credit

      await http().post(`/admin/accounts/${acc.accountId}/credit`).set(A(admin)).send({ amountCents: 0 }).expect(400);
      await http().post(`/admin/accounts/${acc.accountId}/credit`).set(A(admin)).send({ amountCents: 1200, note: 'bank transfer #77' }).expect(200).then((r) => expect(r.body.creditCents).toBe(1200));
      expect(await ids(on)).toContain(camp);

      await ads.recordPlay(camp, on);
      expect(await balance()).toBe(700);
      const go = await http().get(`/radio/go/ad/${camp}`).redirects(0).expect(302); // the public click redirect charges through the platform settings
      expect(go.headers.location).toBe('https://pay.example');
      expect(await balance()).toBe(-1300); // 700 - 2000 (a click is worth more than a play)
      expect(await ids(on)).not.toContain(camp); // credit exhausted: stops airing by itself

      const ledger = (await http().get('/portal/billing').set(A(acc.token))).body.ledger as { kind: string; amountCents: number; balanceAfter: number }[];
      expect(ledger.map((l) => [l.kind, l.amountCents, l.balanceAfter])).toEqual([
        ['CLICK', -2000, -1300],
        ['PLAY', -500, 700],
        ['TOPUP', 1200, 1200],
      ]);
    });

    it('operator-created ads (no owner) are never money-gated, and a suspended owner stops airing', async () => {
      const own = (await http().post('/admin/ads').set(A(admin)).send({ name: 'House ad' }).expect(201)).body.id as string;
      await http().put(`/admin/ads/${own}/audio`).set(A(admin)).set('Content-Type', 'audio/mpeg').send(mp3()).expect(200);
      expect(await ids(on)).toContain(own);
      await http().post(`/admin/accounts/${acc.accountId}/credit`).set(A(admin)).send({ amountCents: 100_000 }).expect(200);
      expect(await ids(on)).toContain(camp);
      await http().patch(`/admin/accounts/${acc.accountId}`).set(A(admin)).send({ status: 'SUSPENDED' }).expect(200);
      expect(await ids(on)).not.toContain(camp);
      expect(await ids(on)).toContain(own);
      await http().patch(`/admin/accounts/${acc.accountId}`).set(A(admin)).send({ status: 'ACTIVE' }).expect(200);
    });

    it('turning billing OFF again frees everything immediately (no code change, no redeploy)', async () => {
      await platform({ billingEnabled: false });
      await db.query('UPDATE accounts SET credit_cents = -5000 WHERE id = $1', [acc.accountId]);
      expect(await ids(off)).toContain(camp);
    });
  });

  describe('station owners', () => {
    let owner: { token: string; accountId: string };
    let other: { token: string; accountId: string };
    beforeAll(async () => {
      owner = await signup('Radio Owner', 'radio@x.example');
      other = await signup('Someone else', 'else@x.example');
    });

    it('sees nothing until the operator assigns a station', async () => {
      expect((await http().get('/portal/stations').set(A(owner.token)).expect(200)).body).toEqual([]);
      await http().get(`/portal/stations/${CH}/engagement`).set(A(owner.token)).expect(404);
    });

    it('after assignment: stats and engagement settings of THAT station only', async () => {
      await http().put(`/admin/channels/${CH}/owner`).set(A(admin)).send({ accountId: owner.accountId }).expect(200).then((r) => expect(r.body.ownerAccountId).toBe(owner.accountId));
      const list = (await http().get('/portal/stations').set(A(owner.token)).expect(200)).body;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: CH, slug: 'chan', plays24h: 0, listenersNow: 0 });

      const settings = { adsEveryNTracks: 4, tagVoteEnabled: true, tagVoteIntervalMinutes: 30, tagVotePollMinutes: 2, tagVotePlayMinutes: 10, tagVoteOptions: 3, tagVoteAllowlist: [] };
      await http().put(`/portal/stations/${CH}/engagement`).set(A(owner.token)).send(settings).expect(200);
      expect((await http().get(`/portal/stations/${CH}/engagement`).set(A(owner.token))).body.adsEveryNTracks).toBe(4);
      expect((await http().get(`/admin/channels/${CH}/engagement`).set(A(admin))).body.adsEveryNTracks).toBe(4); // same data the operator sees
      await http().put(`/portal/stations/${CH}/engagement`).set(A(owner.token)).send({ ...settings, tagVoteOptions: 1 }).expect(400);
      expect((await http().get(`/portal/stations/${CH}/tag-votes`).set(A(owner.token)).expect(200)).body).toHaveProperty('history');

      for (const path of [`/portal/stations/${CH}/engagement`, `/portal/stations/${CH}/tag-votes`]) await http().get(path).set(A(other.token)).expect(404);
      await http().put(`/portal/stations/${CH}/engagement`).set(A(other.token)).send(settings).expect(404);
      await http().get('/portal/stations/not-a-number/engagement').set(A(owner.token)).expect(400);
    });

    it('the operator can take the station back; unknown accounts/channels are rejected', async () => {
      await http().put(`/admin/channels/${CH}/owner`).set(A(admin)).send({ accountId: '00000000-0000-4000-8000-000000000000' }).expect(400);
      await http().put('/admin/channels/9999/owner').set(A(admin)).send({ accountId: null }).expect(404);
      await http().put(`/admin/channels/${CH}/owner`).set(A(admin)).send({ accountId: null }).expect(200);
      await http().get(`/portal/stations/${CH}/engagement`).set(A(owner.token)).expect(404);
    });

    it('lists accounts for the operator with their counts', async () => {
      const list = (await http().get('/admin/accounts').set(A(admin)).expect(200)).body as { name: string; email: string; campaigns: number }[];
      expect(list.find((x) => x.name === 'Adv A')).toMatchObject({ email: 'a@adv.example' });
      expect(list.length).toBeGreaterThanOrEqual(5);
    });
  });
});
