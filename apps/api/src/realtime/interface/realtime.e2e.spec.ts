import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebSocket } from 'ws';
import { ADMIN, bootAdminApp } from '../../../test/admin-app';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';

const CH = '1001';
const PW = 'a-long-password-1';

/** Collects every JSON message of a socket and lets the test await the next one of a type. */
async function connect(port: number, path: string): Promise<{ ws: WebSocket; next: (type: string, pred?: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const all: Record<string, unknown>[] = [];
  const listeners: (() => void)[] = [];
  ws.on('message', (d, bin) => {
    if (bin) return;
    all.push(JSON.parse(d.toString()) as Record<string, unknown>);
    for (const l of [...listeners]) l();
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', rej);
  });
  let from = 0;
  const next = (type: string, pred: (m: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for "${type}"; got ${JSON.stringify(all.map((m) => m.type))}`)), 4000);
      const check = (): void => {
        for (let i = from; i < all.length; i++) {
          const m = all[i] as Record<string, unknown>;
          if (m.type === type && pred(m)) {
            from = i + 1;
            clearTimeout(t);
            listeners.splice(listeners.indexOf(check), 1);
            resolve(m);
            return;
          }
        }
      };
      listeners.push(check);
      check();
    });
  return { ws, next, closed };
}

describe('live sockets, messages and the audio-transport switch on the real app (Redis pub/sub)', () => {
  let app: INestApplication;
  let db: DatabaseService;
  let restore: () => void;
  let port: number;
  let admin: string;
  const http = () => request(app.getHttpServer());
  const A = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    ({ app, restore } = await bootAdminApp());
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as { port: number }).port;
    db = app.get(DatabaseService);
    admin = (await http().post('/admin/auth/login').send(ADMIN).expect(200)).body.token;
  });
  afterAll(async () => {
    await app.close();
    restore();
  });

  it('a listener gets hello, then an announcement posted in the panel arrives instantly over Redis pub/sub, and disappears when deleted', async () => {
    const c = await connect(port, '/radio/chan/ws');
    const hello = await c.next('hello');
    expect(hello).toMatchObject({ transport: 'HTTP', messages: [], clients: 1 });

    await http().post(`/admin/channels/${CH}/messages`).set(A(admin)).send({}).expect(400);
    await http().post(`/admin/channels/${CH}/messages`).set(A(admin)).send({ text: '   ' }).expect(400);
    await http().post(`/admin/channels/${CH}/messages`).set(A(admin)).send({ text: 'x'.repeat(501) }).expect(400);
    await http().post('/admin/channels/9999/messages').set(A(admin)).send({ text: 'hi' }).expect(404);
    const posted = (await http().post(`/admin/channels/${CH}/messages`).set(A(admin)).send({ text: 'Live concert at 21:00!', level: 'WARN', minutes: 30 }).expect(201)).body;
    const push = await c.next('messages', (m) => (m.messages as unknown[]).length === 1);
    expect(push.messages).toMatchObject([{ id: posted.id, text: 'Live concert at 21:00!', level: 'WARN' }]);

    // a late joiner sees it in its hello
    const late = await connect(port, '/radio/chan/ws');
    expect((await late.next('hello')).messages).toMatchObject([{ text: 'Live concert at 21:00!' }]);

    await http().delete(`/admin/channels/${CH}/messages/${posted.id}`).set(A(admin)).expect(204);
    await http().delete(`/admin/channels/${CH}/messages/${posted.id}`).set(A(admin)).expect(404);
    expect((await c.next('messages', (m) => (m.messages as unknown[]).length === 0)).messages).toEqual([]);
    expect((await db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action LIKE 'message.%' ORDER BY at`)).rows.map((r) => r.action)).toEqual(['message.create', 'message.delete']);
    c.ws.close();
    late.ws.close();
  });

  it('expired announcements are not shown', async () => {
    await db.query(`INSERT INTO live_messages (channel_id, text, created_by, expires_at) VALUES ($1, 'old news', 'a', now() - interval '1 minute')`, [CH]);
    const c = await connect(port, '/radio/chan/ws');
    expect((await c.next('hello')).messages).toEqual([]);
    c.ws.close();
  });

  it('the tag vote is pushed live: opening a vote and casting a vote reach every connected listener', async () => {
    let n = 500;
    for (const tag of ['rock', 'jazz']) {
      for (let i = 0; i < 2; i++) {
        const t = await db.query<{ id: string }>(`INSERT INTO tracks (telegram_channel_id, telegram_message_id, title, artist, telegram_file_reference, mime_type, duration, file_size) VALUES (1001, $1, 'S', 'A', 'r', 'audio/mpeg', 100, 1600000) RETURNING id`, [n++]);
        const h = await db.query<{ id: string }>(`INSERT INTO hashtags (value, normalized_value) VALUES ($1,$1) ON CONFLICT (normalized_value) DO UPDATE SET value = hashtags.value RETURNING id`, [tag]);
        await db.query('INSERT INTO track_hashtags (track_id, hashtag_id) VALUES ($1,$2)', [t.rows[0]?.id, h.rows[0]?.id]);
      }
    }
    const c = await connect(port, '/radio/chan/ws');
    await c.next('hello');
    await http().post(`/admin/channels/${CH}/tag-votes/start`).set(A(admin)).expect(200);
    const open = await c.next('vote', (m) => (m.vote as { status: string }).status === 'OPEN');
    expect((open.vote as { poll: { options: unknown[] } }).poll.options).toHaveLength(2);

    await http().post('/radio/chan/vote').send({ voterId: 'listener-0001', hashtag: 'jazz' }).expect(200);
    const tally = await c.next('vote', (m) => (m.vote as { poll?: { totalVotes: number } }).poll?.totalVotes === 1);
    expect(tally).toBeTruthy();
    c.ws.close();
  });

  it('the audio transport is a per-station switch: saved in the panel, offered to players, HTTP keeps working', async () => {
    expect((await http().get('/radio/stations').expect(200)).body).toEqual([]); // the test station is stopped
    await db.query('UPDATE channels SET started = true');
    const before = (await http().get('/radio/stations').expect(200)).body;
    expect(before).toEqual([expect.objectContaining({ slug: 'chan', transport: 'HTTP' })]);

    const cur = (await http().get(`/admin/channels/${CH}/engagement`).set(A(admin)).expect(200)).body;
    expect(cur.audioTransport).toBe('HTTP');
    await http().put(`/admin/channels/${CH}/engagement`).set(A(admin)).send({ ...cur, audioTransport: 'WEBSOCKET' }).expect(200);
    await http().put(`/admin/channels/${CH}/engagement`).set(A(admin)).send({ ...cur, audioTransport: 'CARRIER-PIGEON' }).expect(400);
    expect((await http().get('/radio/stations').expect(200)).body[0]).toMatchObject({ transport: 'WEBSOCKET' });

    const c = await connect(port, '/radio/chan/ws');
    expect(await c.next('hello')).toMatchObject({ transport: 'WEBSOCKET' });
    c.ws.close();
    await http().get('/radio/chan/stream').expect(503); // no engine here in the test, but the URL is still the HTTP one (unchanged)
  });

  it('an audio socket to a station this instance is not broadcasting closes with 1013 so the player falls back to HTTP', async () => {
    const a = new WebSocket(`ws://127.0.0.1:${port}/radio/chan/audio`);
    const code = await new Promise<number>((r) => a.on('close', (c) => r(c)));
    expect(code).toBe(1013);
  });

  it('station owners can post announcements to THEIR station only', async () => {
    const signup = async (email: string): Promise<{ token: string; accountId: string }> => {
      const r = await http().post('/portal/auth/signup').send({ accountName: email, email, password: PW }).expect(201);
      return { token: r.body.token, accountId: (await http().get('/portal/me').set(A(r.body.token))).body.account.id };
    };
    const owner = await signup('owner@radio.example');
    const other = await signup('other@radio.example');
    await http().put(`/admin/channels/${CH}/owner`).set(A(admin)).send({ accountId: owner.accountId }).expect(200);
    const c = await connect(port, '/radio/chan/ws');
    await c.next('hello');
    const m = (await http().post(`/portal/stations/${CH}/messages`).set(A(owner.token)).send({ text: 'Hello from the owner' }).expect(201)).body;
    await c.next('messages', (x) => (x.messages as { text: string }[]).some((y) => y.text === 'Hello from the owner'));
    await http().post(`/portal/stations/${CH}/messages`).set(A(other.token)).send({ text: 'hijack' }).expect(404);
    await http().delete(`/portal/stations/${CH}/messages/${m.id}`).set(A(other.token)).expect(404);
    await http().get(`/portal/stations/${CH}/messages`).set(A(owner.token)).expect(200).then((r) => expect(r.body).toHaveLength(1));
    await http().delete(`/portal/stations/${CH}/messages/${m.id}`).set(A(owner.token)).expect(204);
    await http().post(`/admin/channels/${CH}/messages`).send({ text: 'x' }).expect(401);
    c.ws.close();
  });
});
