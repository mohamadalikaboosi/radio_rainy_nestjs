import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { Broadcaster } from '../../radio/domain/broadcaster';
import { MemoryRealtimeBus } from '../infrastructure/events';
import { DEFAULT_REALTIME, RealtimeOptions, RealtimeService } from './realtime.service';

interface World {
  current: { status: string; trackId: string; title: string; serverTime: string; position: number };
  vote: { status: string; serverTime: string };
  messages: { id: string; text: string }[];
  transport: 'HTTP' | 'WEBSOCKET';
  calls: { current: number; vote: number; messages: number };
}

const fresh = (): World => ({ current: { status: 'PLAYING', trackId: 't1', title: 'One', serverTime: 'x', position: 1 }, vote: { status: 'NONE', serverTime: 'x' }, messages: [], transport: 'HTTP', calls: { current: 0, vote: 0, messages: 0 } });

function mkService(world: World, bus: MemoryRealtimeBus, instanceId: string, stations: Map<string, { broadcaster: Broadcaster }>, opt: Partial<RealtimeOptions> = {}): RealtimeService {
  return new RealtimeService(
    {
      channels: { bySlug: async (slug: string) => (slug === 'chan' ? ({ id: '1001' } as never) : null) },
      current: { current: async () => (world.calls.current++, { ...world.current, serverTime: new Date().toISOString() } as never) },
      votes: { view: async () => (world.calls.vote++, { ...world.vote, serverTime: new Date().toISOString() } as never) },
      messages: { active: async () => (world.calls.messages++, world.messages.map((m) => ({ ...m, channelId: '1001', level: 'INFO' as const, createdBy: 'a', createdAt: '', expiresAt: '' }))) },
      settings: { get: async () => ({ audioTransport: world.transport }) },
      stations: { get: (id: string) => stations.get(id) as never },
      bus,
      instanceId,
    },
    { ...DEFAULT_REALTIME, pingMs: 60_000, clientsEveryMs: 60_000, ...opt },
  );
}

/** A client that records every JSON message so tests can wait for the next one. */
function client(port: number, path: string): Promise<{ ws: WebSocket; next: (type?: string) => Promise<Record<string, unknown>>; all: Record<string, unknown>[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const all: Record<string, unknown>[] = [];
    const waiters: { type?: string; resolve: (m: Record<string, unknown>) => void }[] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      all.push(m);
      const i = waiters.findIndex((w) => !w.type || w.type === m.type);
      if (i >= 0) waiters.splice(i, 1)[0]?.resolve(m);
    });
    const next = (type?: string): Promise<Record<string, unknown>> =>
      new Promise((res, rej) => {
        const idx = all.findIndex((m, i) => i >= consumed && (!type || m.type === type));
        if (idx >= 0) {
          consumed = idx + 1;
          return res(all[idx] as Record<string, unknown>);
        }
        const t = setTimeout(() => rej(new Error(`timeout waiting for ${type ?? 'a message'}; got ${JSON.stringify(all.map((m) => m.type))}`)), 2000);
        waiters.push({ type, resolve: (m) => (clearTimeout(t), (consumed = all.indexOf(m) + 1), res(m)) });
      });
    let consumed = 0;
    ws.on('open', () => resolve({ ws, next, all, closed }));
    ws.on('error', reject);
  });
}

const rejectedWith = (port: number, path: string): Promise<number> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => undefined);
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('RealtimeService (WebSocket control plane fed by pub/sub)', () => {
  let server: Server;
  let port: number;
  let bus: MemoryRealtimeBus;
  let world: World;
  let stations: Map<string, { broadcaster: Broadcaster }>;
  const started: RealtimeService[] = [];

  const boot = async (opt: Partial<RealtimeOptions> = {}, id = 'A', b = bus, w = world): Promise<RealtimeService> => {
    const s = mkService(w, b, id, stations, opt);
    await s.start(server);
    started.push(s);
    return s;
  };

  beforeEach(async () => {
    bus = new MemoryRealtimeBus();
    world = fresh();
    stations = new Map();
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await Promise.all(started.splice(0).map((s) => s.stop()));
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('says hello with everything a player needs: what is on air, the vote, messages, the transport and the counts', async () => {
    world.transport = 'WEBSOCKET';
    world.messages = [{ id: 'm1', text: 'Welcome' }];
    await boot();
    const c = await client(port, '/radio/chan/ws');
    const hello = await c.next('hello');
    expect(hello).toMatchObject({ current: { status: 'PLAYING', title: 'One' }, vote: { status: 'NONE' }, messages: [{ text: 'Welcome' }], transport: 'WEBSOCKET', clients: 1 });
    c.ws.close();
  });

  it('pushes changes the moment a pub/sub hint arrives, and only real changes (no duplicates)', async () => {
    await boot();
    const c = await client(port, '/radio/chan/ws');
    await c.next('hello');
    world.current = { ...world.current, trackId: 't2', title: 'Two' };
    await bus.publish({ type: 'current', channelId: '1001' });
    expect(await c.next('current')).toMatchObject({ current: { trackId: 't2', title: 'Two' } });

    // the same state announced again (e.g. by another instance) is not pushed twice
    await bus.publish({ type: 'current', channelId: '1001' });
    await sleep(80);
    expect(c.all.filter((m) => m.type === 'current')).toHaveLength(1);

    world.vote = { status: 'OPEN', serverTime: 'x' };
    await bus.publish({ type: 'vote', channelId: '1001' });
    expect(await c.next('vote')).toMatchObject({ vote: { status: 'OPEN' } });

    world.messages = [{ id: 'm2', text: 'Maintenance at 22:00' }];
    await bus.publish({ type: 'messages', channelId: '1001' });
    expect(await c.next('messages')).toMatchObject({ messages: [{ text: 'Maintenance at 22:00' }] });
    c.ws.close();
  });

  it('computes NOTHING for a station nobody is connected to', async () => {
    await boot();
    const before = { ...world.calls };
    for (const type of ['current', 'vote', 'messages'] as const) await bus.publish({ type, channelId: '1001' });
    await bus.publish({ type: 'current', channelId: '9999' });
    await sleep(40);
    expect(world.calls).toEqual(before);
  });

  it('two instances behind one Redis: each holds its own sockets, yet both report the SUM as "clients" and the leader\'s listener count', async () => {
    // instance B = another process: its own HTTP server, the same bus
    const serverB = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => serverB.listen(0, '127.0.0.1', r));
    const portB = (serverB.address() as AddressInfo).port;
    const svcA = await boot({}, 'A');
    const svcB = mkService(fresh(), bus, 'B', stations, { pingMs: 60_000, clientsEveryMs: 60_000 });
    await svcB.start(serverB);
    started.push(svcB);

    const a = await client(port, '/radio/chan/ws');
    const b = await client(portB, '/radio/chan/ws');
    await a.next('hello');
    await b.next('hello');
    // every connect announces the instance's socket count over pub/sub; both ends converge on 2
    await sleep(80);
    expect(svcA.counts('1001').clients).toBe(2);
    expect(svcB.counts('1001').clients).toBe(2);

    // only the leader knows the audio listeners: one publish reaches the sockets of BOTH instances
    await bus.publish({ type: 'listeners', channelId: '1001', count: 42 });
    for (let m = await a.next('counts'); m.listeners !== 42; m = await a.next('counts')); // skip earlier count updates
    const last = (): Record<string, unknown> | undefined => [...b.all].reverse().find((m) => m.type === 'counts');
    await sleep(40);
    expect(last()).toMatchObject({ listeners: 42, clients: 2 });

    b.ws.close();
    await b.closed;
    await sleep(80);
    expect(svcA.counts('1001').clients).toBe(1); // B's socket left: A hears about it
    a.ws.close();
    await new Promise<void>((r) => serverB.close(() => r()));
  });

  it('forgets an instance that stopped announcing (crashed): its clients no longer count', async () => {
    let now = 1_000_000;
    const s = new RealtimeService({ channels: { bySlug: async () => ({ id: '1001' }) as never }, current: { current: async () => ({}) as never }, votes: { view: async () => ({}) as never }, messages: { active: async () => [] }, settings: { get: async () => ({ audioTransport: 'HTTP' as const }) }, stations: { get: () => undefined }, bus, instanceId: 'me' }, { ...DEFAULT_REALTIME, clientsTtlMs: 30_000 }, () => now);
    await s.start(server);
    started.push(s);
    const c = await client(port, '/radio/chan/ws');
    await c.next('hello');
    await bus.publish({ type: 'clients', channelId: '1001', instance: 'dead', count: 10 });
    expect(s.counts('1001').clients).toBe(11);
    now += 31_000;
    expect(s.counts('1001').clients).toBe(1);
    c.ws.close();
  });

  it('answers ping with pong, ignores anything else, and drops a closed socket from the count', async () => {
    const svc = await boot();
    const c = await client(port, '/radio/chan/ws');
    await c.next('hello');
    c.ws.send('ping');
    expect(await c.next('pong')).toEqual({ type: 'pong' });
    c.ws.send('{"type":"vote","hashtag":"rock"}'); // the socket is read-only for listeners
    await sleep(50);
    expect(c.all.filter((m) => m.type !== 'hello' && m.type !== 'pong' && m.type !== 'counts')).toEqual([]);
    expect(svc.counts('1001').clients).toBe(1);
    c.ws.close();
    await c.closed;
    await sleep(50);
    expect(svc.counts('1001').clients).toBe(0);
  });

  it('rejects unknown stations and bad paths, and caps sockets per IP', async () => {
    await boot({ maxPerIp: 2 });
    expect(await rejectedWith(port, '/radio/nope/ws')).toBe(404);
    expect(await rejectedWith(port, '/admin/ws')).toBe(404);
    const a = await client(port, '/radio/chan/ws');
    const b = await client(port, '/radio/chan/ws');
    expect(await rejectedWith(port, '/radio/chan/ws')).toBe(429);
    a.ws.close();
    await a.closed;
    await sleep(30);
    const c = await client(port, '/radio/chan/ws'); // a slot is free again
    c.ws.close();
    b.ws.close();
  });

  it('stop() closes every socket and stops reacting to events', async () => {
    const svc = await boot();
    const c = await client(port, '/radio/chan/ws');
    await c.next('hello');
    await svc.stop();
    await c.closed;
    expect(svc.socketCount).toBe(0);
  });

  describe('audio over WebSocket (same shared stream as the HTTP endpoint)', () => {
    const bytesOf = (): { chunks: Buffer[]; done: Promise<number> } => ({ chunks: [], done: Promise.resolve(0) });
    const listen = async (path: string): Promise<{ ws: WebSocket; chunks: Buffer[]; closed: Promise<number> }> => {
      const chunks: Buffer[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      ws.binaryType = 'nodebuffer';
      ws.on('message', (d, bin) => bin && chunks.push(Buffer.from(d as Buffer)));
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      await new Promise<void>((res, rej) => {
        ws.on('open', () => res());
        ws.on('error', rej);
      });
      return { ws, chunks, closed };
    };
    void bytesOf;

    it('streams the broadcaster\'s bytes as binary frames; a late joiner starts with the buffered tail; listeners are counted', async () => {
      const broadcaster = new Broadcaster(10);
      stations.set('1001', { broadcaster });
      await boot();
      broadcaster.push(Buffer.from('AAAA')); // before anyone listens: lands in the ring buffer
      const a = await listen('/radio/chan/audio');
      await sleep(40);
      expect(Buffer.concat(a.chunks).toString()).toBe('AAAA'); // instant start from the ring
      expect(broadcaster.listenerCount).toBe(1);
      const b = await listen('/radio/chan/audio');
      broadcaster.push(Buffer.from('BBBB'));
      broadcaster.push(Buffer.from('CCCC'));
      await sleep(60);
      expect(Buffer.concat(a.chunks).toString()).toBe('AAAABBBBCCCC');
      expect(Buffer.concat(b.chunks).toString()).toContain('CCCC'); // both listeners follow the same timeline
      expect(broadcaster.listenerCount).toBe(2);
      a.ws.close();
      b.ws.close();
      await Promise.all([a.closed, b.closed]);
      await sleep(30);
      expect(broadcaster.listenerCount).toBe(0); // only listener-specific resources are released
    });

    it('audio sockets are not "clients" of the control channel, and cannot send anything', async () => {
      const broadcaster = new Broadcaster(10);
      stations.set('1001', { broadcaster });
      const svc = await boot();
      const a = await listen('/radio/chan/audio');
      a.ws.send('hello?');
      await sleep(40);
      expect(svc.counts('1001').clients).toBe(0);
      a.ws.close();
    });

    it('a station that is not broadcasting here closes with 1013 (the player then falls back to HTTP)', async () => {
      await boot();
      const a = await listen('/radio/chan/audio');
      expect(await a.closed).toBe(1013);
    });

    it('closes the audio socket when the station stops', async () => {
      const broadcaster = new Broadcaster(10);
      stations.set('1001', { broadcaster });
      await boot();
      const a = await listen('/radio/chan/audio');
      broadcaster.endAll();
      expect(await a.closed).toBe(1000);
    });
  });
});
