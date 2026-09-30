import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../admin/audit.service';
import { RadioBus } from '../radio/radio-bus';
import { ActorContext } from '../radio/radio-configuration.service';
import { TelegramGateway, TelegramNotReadyError } from '../telegram/telegram.types';
import { ChannelRepository, ChannelRow } from './channel.repository';

export const addChannelSchema = z.object({ reference: z.string().trim().min(2).max(200) });

const RESERVED_SLUGS = new Set(['current', 'stream', 'lyrics', 'admin', 'radio', 'panel', 'api']);

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Admin operations on stations. Starting/stopping only flips a flag and tells the leader (which owns the players). */
@Injectable()
export class ChannelService {
  constructor(
    private readonly channels: ChannelRepository,
    private readonly gateway: Pick<TelegramGateway, 'resolveChannel'>,
    private readonly bus: RadioBus,
    private readonly audit: AuditService,
    private readonly defaultRecentWindow: number,
  ) {}

  list(): Promise<ChannelRow[]> {
    return this.channels.list();
  }

  async require(id: string): Promise<ChannelRow> {
    const c = await this.channels.get(id);
    if (!c) throw new NotFoundException('Channel not found');
    return c;
  }

  async add(reference: string, ctx: ActorContext): Promise<ChannelRow> {
    let info;
    try {
      info = await this.gateway.resolveChannel(reference);
    } catch (err) {
      if (err instanceof TelegramNotReadyError) throw new BadRequestException('Log in to Telegram first (Telegram page), then add channels');
      const rpc = typeof err === 'object' && err !== null && 'errorMessage' in err ? String((err as { errorMessage: unknown }).errorMessage) : undefined;
      if (rpc) throw new BadRequestException({ message: 'Telegram could not resolve this channel', telegramError: rpc });
      throw err;
    }
    if (await this.channels.get(info.id)) throw new ConflictException('This channel is already added');

    const base = slugify(info.username ?? info.title) || `channel-${info.id.slice(-6)}`;
    let slug = RESERVED_SLUGS.has(base) ? `${base}-radio` : base;
    for (let n = 2; await this.channels.slugExists(slug); n++) slug = `${base}-${n}`;

    const row = await this.channels.insert({ id: info.id, reference: reference.trim(), title: info.title, username: info.username, slug, recentTrackWindow: this.defaultRecentWindow });
    await this.audit.record({ actor: ctx.actor, action: 'channel.add', entityType: 'channel', entityId: row.id, after: { title: row.title, slug: row.slug, reference: row.reference }, requestId: ctx.requestId });
    await this.bus.publish({ type: 'stations-changed' });
    return row;
  }

  async remove(id: string, deleteTracks: boolean, ctx: ActorContext): Promise<void> {
    const c = await this.require(id);
    await this.channels.setStarted(id, false);
    await this.bus.publish({ type: 'stations-changed' }); // leader stops the player before the rows disappear
    await this.channels.remove(id, deleteTracks);
    await this.audit.record({ actor: ctx.actor, action: 'channel.remove', entityType: 'channel', entityId: id, before: { title: c.title, slug: c.slug }, after: { deleteTracks }, requestId: ctx.requestId });
  }

  /** Idempotent. */
  async setStarted(id: string, started: boolean, ctx: ActorContext): Promise<ChannelRow> {
    const before = await this.require(id);
    if (before.started !== started) {
      await this.channels.setStarted(id, started);
      await this.audit.record({ actor: ctx.actor, action: started ? 'channel.start' : 'channel.stop', entityType: 'channel', entityId: id, before: { started: before.started }, after: { started }, requestId: ctx.requestId });
    }
    await this.bus.publish({ type: 'stations-changed' });
    return this.require(id);
  }

  async setLive(id: string, enabled: boolean, ctx: ActorContext): Promise<ChannelRow> {
    const before = await this.require(id);
    if (before.telegramLiveEnabled !== enabled) {
      await this.channels.setLiveEnabled(id, enabled);
      await this.audit.record({ actor: ctx.actor, action: enabled ? 'channel.live.enable' : 'channel.live.disable', entityType: 'channel', entityId: id, before: { live: before.telegramLiveEnabled }, after: { live: enabled }, requestId: ctx.requestId });
    }
    await this.bus.publish({ type: 'stations-changed' });
    return this.require(id);
  }
}
