import { Logger } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { ChannelRepository } from '../../catalog/application/ports/channel.repository';
import { TagVoteService } from '../../engagement/application/tag-vote.service';
import { StationManager } from '../../radio/application/station-manager';
import { CurrentRadioService } from '../../radio/application/current-radio.service';
import { LiveMessage, MessagesRepository } from '../application/ports/messages.repository';
import { RealtimeBus, RealtimeEvent } from '../application/ports/realtime-bus';

export interface RealtimeOptions {
  /** Open sockets allowed per client IP and instance. */
  maxPerIp: number;
  pingMs: number;
  /** How often this instance re-announces how many sockets it holds. */
  clientsEveryMs: number;
  /** A peer instance that has been silent this long no longer counts. */
  clientsTtlMs: number;
  /** A WebSocket audio listener that falls this far behind (bytes queued in its socket) is dropped, exactly like a slow HTTP listener. */
  audioMaxBacklogBytes: number;
}
export const DEFAULT_REALTIME: RealtimeOptions = { maxPerIp: 20, pingMs: 30_000, clientsEveryMs: 10_000, clientsTtlMs: 35_000, audioMaxBacklogBytes: 512 * 1024 };

/** What a socket receives. `type` tells the client what changed; a client never has to poll. */
export type ServerMessage =
  | { type: 'hello'; current: unknown; vote: unknown; messages: LiveMessage[]; listeners: number; clients: number; transport: 'HTTP' | 'WEBSOCKET' }
  | { type: 'current'; current: unknown }
  | { type: 'vote'; vote: unknown }
  | { type: 'messages'; messages: LiveMessage[] }
  | { type: 'counts'; listeners: number; clients: number }
  | { type: 'pong' };

interface Room {
  sockets: Set<WebSocket>;
  listeners: number;
  /** instance id -> { sockets held, last heard } */
  peers: Map<string, { count: number; at: number }>;
  lastCurrent: string;
}

const PATH = /^\/radio\/([a-z0-9][a-z0-9-]{0,60})\/(ws|audio)$/;
const stable = (v: unknown): string => JSON.stringify(v, (k, x) => (k === 'serverTime' || k === 'position' ? undefined : x));

/**
 * Live "control plane" for listeners over WebSocket (audio stays on plain HTTP, see docs/PLAYBACK.md).
 * It is fed by Redis pub/sub hints, so any instance can hold sockets: a hint only says WHAT changed; each instance builds the
 * message from the database for the sockets it holds. Nothing is computed when a station has no sockets.
 */
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly rooms = new Map<string, Room>();
  private readonly perIp = new Map<string, number>();
  private wss: WebSocketServer | null = null;
  private unsubscribe: (() => Promise<void>) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private server: Server | null = null;
  private readonly onUpgradeBound = (req: IncomingMessage, socket: Duplex, head: Buffer): void => void this.onUpgrade(req, socket, head);

  constructor(
    private readonly deps: {
      channels: Pick<ChannelRepository, 'bySlug'>;
      current: Pick<CurrentRadioService, 'current'>;
      votes: Pick<TagVoteService, 'view'>;
      messages: Pick<MessagesRepository, 'active'>;
      settings: { get(channelId: string): Promise<{ audioTransport: 'HTTP' | 'WEBSOCKET' }> };
      stations: Pick<StationManager, 'get'>;
      bus: RealtimeBus;
      instanceId: string;
    },
    private readonly opt: RealtimeOptions = DEFAULT_REALTIME,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async start(server: Server): Promise<void> {
    this.server = server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    server.on('upgrade', this.onUpgradeBound);
    this.unsubscribe = await this.deps.bus.subscribe((e) => void this.onEvent(e).catch((err: unknown) => this.logger.warn({ msg: 'realtime event failed', err: String(err) })));
    const ping = setInterval(() => this.heartbeat(), this.opt.pingMs);
    const announce = setInterval(() => void this.announceClients(), this.opt.clientsEveryMs);
    ping.unref();
    announce.unref();
    this.timers = [ping, announce];
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.server?.off('upgrade', this.onUpgradeBound);
    await this.unsubscribe?.().catch(() => undefined);
    this.unsubscribe = null;
    for (const room of this.rooms.values()) for (const s of room.sockets) s.terminate();
    this.wss?.close();
    this.wss = null;
  }

  /** Sockets held by this instance (all stations). */
  get socketCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.sockets.size;
    return n;
  }

  counts(channelId: string): { listeners: number; clients: number } {
    const room = this.rooms.get(channelId);
    if (!room) return { listeners: 0, clients: 0 };
    return { listeners: room.listeners, clients: this.totalClients(room) };
  }

  // ---- connections ----

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = (code: number, text: string): void => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    try {
      const m = PATH.exec(new URL(req.url ?? '/', 'http://x').pathname);
      const slug = m?.[1];
      const kind = m?.[2];
      if (!slug || !this.wss) return reject(404, 'Not Found');
      const ip = req.socket.remoteAddress ?? 'unknown';
      if ((this.perIp.get(ip) ?? 0) >= this.opt.maxPerIp) return reject(429, 'Too Many Requests');
      const channel = await this.deps.channels.bySlug(slug);
      if (!channel) return reject(404, 'Not Found');
      this.wss.handleUpgrade(req, socket as never, head, (ws) => void (kind === 'audio' ? this.acceptAudio(ws, channel.id, ip, new URL(req.url ?? '/', 'http://x').searchParams.get('quality') === 'low') : this.accept(ws, channel.id, ip)));
    } catch (err) {
      this.logger.warn({ msg: 'websocket upgrade failed', err: String(err) });
      reject(400, 'Bad Request');
    }
  }

  private room(channelId: string): Room {
    let r = this.rooms.get(channelId);
    if (!r) {
      r = { sockets: new Set(), listeners: 0, peers: new Map(), lastCurrent: '' };
      this.rooms.set(channelId, r);
    }
    return r;
  }

  private async accept(ws: WebSocket, channelId: string, ip: string): Promise<void> {
    const room = this.room(channelId);
    room.sockets.add(ws);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on('pong', () => void ((ws as WebSocket & { alive?: boolean }).alive = true));
    ws.on('message', (data) => {
      // The socket is one-way except for keep-alive pings; anything else is ignored (and capped by maxPayload).
      if (data.toString() === 'ping') this.send(ws, { type: 'pong' });
    });
    ws.on('error', () => undefined);
    ws.on('close', () => {
      room.sockets.delete(ws);
      const left = (this.perIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, left);
      void this.announceClients(channelId);
      this.broadcastCounts(channelId);
    });
    await this.announceClients(channelId);
    try {
      const [current, vote, messages] = await Promise.all([this.deps.current.current(channelId), this.deps.votes.view(channelId), this.deps.messages.active(channelId)]);
      room.lastCurrent = stable(current);
      const { audioTransport } = await this.deps.settings.get(channelId);
      this.send(ws, { type: 'hello', current, vote, messages, transport: audioTransport, ...this.counts(channelId) });
    } catch (err) {
      this.logger.warn({ msg: 'could not build hello', err: String(err) });
    }
    this.broadcastCounts(channelId);
  }

  /**
   * Audio over WebSocket: the SAME shared stream as the HTTP endpoint (one Broadcaster per station: one download, one ffmpeg),
   * sent as binary MP3 frames. The ring buffer gives an instant start; a slow socket is dropped like a slow HTTP listener.
   * Only the leader instance broadcasts a station: elsewhere the socket is closed with 1013 and the player falls back to HTTP.
   */
  private acceptAudio(ws: WebSocket, channelId: string, ip: string, wantLow = false): void {
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    const station = this.deps.stations.get(channelId);
    let unsubscribe: (() => void) | null = null;
    ws.on('error', () => undefined);
    ws.on('message', () => undefined); // one-way: nothing is accepted from the listener
    ws.on('close', () => {
      unsubscribe?.();
      const left = (this.perIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, left);
    });
    if (!station) {
      ws.close(1013, 'station not broadcasting on this instance');
      return;
    }
    const source = wantLow && station.low?.available ? station.low : station.broadcaster; // data saver when asked (and possible)
    unsubscribe = source.subscribe({
      write: (chunk) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > this.opt.audioMaxBacklogBytes) {
          ws.close(1008, 'too slow');
          return;
        }
        ws.send(chunk, { binary: true });
      },
      end: () => ws.close(1000, 'station stopped'),
    });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      ws.terminate();
    }
  }

  private broadcast(channelId: string, msg: ServerMessage): void {
    const room = this.rooms.get(channelId);
    if (room) for (const ws of room.sockets) this.send(ws, msg);
  }

  private broadcastCounts(channelId: string): void {
    this.broadcast(channelId, { type: 'counts', ...this.counts(channelId) });
  }

  private heartbeat(): void {
    for (const room of this.rooms.values()) {
      for (const ws of room.sockets) {
        const s = ws as WebSocket & { alive?: boolean };
        if (s.alive === false) {
          ws.terminate();
          continue;
        }
        s.alive = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }
  }

  // ---- pub/sub ----

  private totalClients(room: Room): number {
    const t = this.now();
    let n = 0;
    for (const [id, p] of room.peers) {
      if (id !== this.deps.instanceId && t - p.at > this.opt.clientsTtlMs) room.peers.delete(id);
      else n += id === this.deps.instanceId ? room.sockets.size : p.count;
    }
    return Math.max(n, room.sockets.size);
  }

  /** Tells the other instances how many sockets we hold (and records it for ourselves). */
  private async announceClients(only?: string): Promise<void> {
    for (const [channelId, room] of this.rooms) {
      if (only !== undefined && only !== channelId) continue;
      room.peers.set(this.deps.instanceId, { count: room.sockets.size, at: this.now() });
      await this.deps.bus.publish({ type: 'clients', channelId, instance: this.deps.instanceId, count: room.sockets.size }).catch(() => undefined);
    }
  }

  async onEvent(e: RealtimeEvent): Promise<void> {
    const room = this.rooms.get(e.channelId);
    if (!room || room.sockets.size === 0) return; // nobody here: nothing is computed
    switch (e.type) {
      case 'current': {
        const current = await this.deps.current.current(e.channelId);
        const key = stable(current);
        if (key === room.lastCurrent) return; // the hint arrived on every instance; only real changes are pushed
        room.lastCurrent = key;
        this.broadcast(e.channelId, { type: 'current', current });
        return;
      }
      case 'vote':
        this.broadcast(e.channelId, { type: 'vote', vote: await this.deps.votes.view(e.channelId) });
        return;
      case 'messages':
        this.broadcast(e.channelId, { type: 'messages', messages: await this.deps.messages.active(e.channelId) });
        return;
      case 'listeners':
        room.listeners = e.count;
        this.broadcastCounts(e.channelId);
        return;
      case 'clients':
        if (e.instance !== this.deps.instanceId) {
          const isNew = !room.peers.has(e.instance);
          room.peers.set(e.instance, { count: e.count, at: this.now() });
          this.broadcastCounts(e.channelId);
          // A peer we had not heard of does not know about us either (it may have just started): introduce ourselves once.
          if (isNew) await this.announceClients(e.channelId);
        }
        return;
    }
  }
}
