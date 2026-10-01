import { realtimeEventSchema, RealtimeEvent, RealtimeBus } from '../application/ports/realtime-bus';

import IORedis from 'ioredis';
import { Logger } from '@nestjs/common';


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
