import { commandSchema, RadioCommand, RadioBus } from '../application/ports/radio-bus';

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import IORedis from 'ioredis';
const CHANNEL = 'radio_rainy:commands';

@Injectable()
export class RedisRadioBus implements RadioBus, OnModuleDestroy {
  private readonly logger = new Logger(RedisRadioBus.name);
  private readonly pub: IORedis;
  private readonly subs: IORedis[] = [];

  constructor(private readonly url: string, private readonly channel = CHANNEL) {
    this.pub = new IORedis(url);
    this.pub.on('error', (e) => this.logger.warn({ msg: 'redis pub error', err: e.message }));
  }

  async publish(cmd: RadioCommand): Promise<void> {
    await this.pub.publish(this.channel, JSON.stringify(cmd));
  }

  async subscribe(handler: (cmd: RadioCommand) => void): Promise<() => Promise<void>> {
    const sub = new IORedis(this.url);
    sub.on('error', (e) => this.logger.warn({ msg: 'redis sub error', err: e.message }));
    this.subs.push(sub);
    await sub.subscribe(this.channel);
    sub.on('message', (_ch, raw) => {
      try {
        const parsed = commandSchema.safeParse(JSON.parse(raw));
        if (parsed.success) handler(parsed.data);
        else this.logger.warn({ msg: 'ignored invalid radio command' });
      } catch (err) {
        this.logger.warn({ msg: 'ignored malformed radio command', err: String(err) });
      }
    });
    return async () => {
      await sub.quit().catch((e: unknown) => this.logger.warn({ msg: 'sub quit failed', err: String(e) }));
    };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.pub, ...this.subs].map((c) => c.quit().catch(() => 'closed')));
  }
}

export class InMemoryRadioBus implements RadioBus {
  private handlers = new Set<(c: RadioCommand) => void>();
  async publish(cmd: RadioCommand): Promise<void> {
    for (const h of [...this.handlers]) h(cmd);
  }
  async subscribe(handler: (cmd: RadioCommand) => void): Promise<() => Promise<void>> {
    this.handlers.add(handler);
    return async () => void this.handlers.delete(handler);
  }
}
