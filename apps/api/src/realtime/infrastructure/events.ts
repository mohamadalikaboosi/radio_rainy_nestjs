import IORedis from 'ioredis';
import { Logger } from '@nestjs/common';
import { z } from 'zod';

/**
 * Tiny "something changed" hints that travel over Redis pub/sub between instances. They carry no heavy payload:
 * every instance builds the actual message from the database for the sockets IT holds, so all instances agree and
 * a listener can connect to any of them.
 */
export const realtimeEventSchema = z.discriminatedUnion('type', [
  /** The track / ad on air changed (published by the leader's engine). */
  z.object({ type: z.literal('current'), channelId: z.string() }),
  /** The tag vote opened, closed, changed its winner or received a vote. */
  z.object({ type: z.literal('vote'), channelId: z.string() }),
  /** An announcement was posted or removed. */
  z.object({ type: z.literal('messages'), channelId: z.string() }),
  /** Audio-stream listeners of a station (only the leader knows them). */
  z.object({ type: z.literal('listeners'), channelId: z.string(), count: z.number().int().min(0) }),
  /** How many WebSocket clients one instance holds for a station (summed over instances for the "clients" number). */
  z.object({ type: z.literal('clients'), channelId: z.string(), instance: z.string(), count: z.number().int().min(0) }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export interface RealtimeBus {
  publish(event: RealtimeEvent): Promise<void>;
  subscribe(handler: (event: RealtimeEvent) => void): Promise<() => Promise<void>>;
}
export const REALTIME_BUS = Symbol('REALTIME_BUS');

const CHANNEL = 'radio_rainy:realtime';

export class RedisRealtimeBus implements RealtimeBus {
  private readonly logger = new Logger(RedisRealtimeBus.name);
  private readonly pub: IORedis;
  private readonly subs: IORedis[] = [];

  constructor(private readonly url: string, private readonly channel = CHANNEL) {
    this.pub = new IORedis(url);
    this.pub.on('error', (e) => this.logger.warn({ msg: 'redis pub error', err: e.message }));
  }

  async publish(event: RealtimeEvent): Promise<void> {
    await this.pub.publish(this.channel, JSON.stringify(event));
  }

  async subscribe(handler: (event: RealtimeEvent) => void): Promise<() => Promise<void>> {
    const sub = new IORedis(this.url);
    sub.on('error', (e) => this.logger.warn({ msg: 'redis sub error', err: e.message }));
    await sub.subscribe(this.channel);
    sub.on('message', (_c, raw) => {
      try {
        const parsed = realtimeEventSchema.safeParse(JSON.parse(raw));
        if (parsed.success) handler(parsed.data);
      } catch {
        this.logger.warn({ msg: 'ignored malformed realtime event' });
      }
    });
    this.subs.push(sub);
    return async () => {
      await sub.quit().catch(() => undefined);
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.pub.quit().catch(() => undefined), ...this.subs.map((s) => s.quit().catch(() => undefined))]);
  }
}

/** In-process bus for tests (several "instances" can share one). */
export class MemoryRealtimeBus implements RealtimeBus {
  private readonly handlers = new Set<(e: RealtimeEvent) => void>();
  readonly published: RealtimeEvent[] = [];

  async publish(event: RealtimeEvent): Promise<void> {
    this.published.push(event);
    for (const h of [...this.handlers]) h(event);
  }

  async subscribe(handler: (event: RealtimeEvent) => void): Promise<() => Promise<void>> {
    this.handlers.add(handler);
    return async () => {
      this.handlers.delete(handler);
    };
  }
}
