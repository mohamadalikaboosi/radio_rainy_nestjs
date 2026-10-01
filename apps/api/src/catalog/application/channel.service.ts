import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../administration/application/audit.service';
import { RadioBus } from '../../radio/infrastructure/radio-bus';
import { ActorContext } from '../../radio/application/radio-configuration.service';
import { TelegramGateway, TelegramNotReadyError } from './ports/telegram.types';
import { SessionCipher } from '../../shared/infrastructure/crypto/session-cipher';
import { ChannelRepository, ChannelRow } from '../infrastructure/persistence/channel.repository';

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
    private readonly liveKeyCipher?: SessionCipher,
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

  /**
   * Manual live target: the "Server URL" and "Stream key" of Telegram's "Stream with..." screen (works like OBS, no admin rights needed
   * for our account). A single pasted `rtmps://host/s/<key>` link is split automatically. `null` returns to the automatic (MTProto) mode.
   */
  async setLiveTarget(id: string, target: { url: string; key?: string } | null, ctx: ActorContext): Promise<ChannelRow> {
    const before = await this.require(id);
    if (!this.liveKeyCipher) throw new BadRequestException('Live target encryption is not configured');
    if (target === null) {
      await this.channels.setLiveTarget(id, null, null);
    } else {
      const parsed = parseLiveTarget(target.url, target.key);
      await this.channels.setLiveTarget(id, parsed.url, this.liveKeyCipher.encrypt(parsed.key));
    }
    // The key is a secret: only whether a manual target is set (and its URL) is audited.
    await this.audit.record({ actor: ctx.actor, action: target ? 'channel.live.target.set' : 'channel.live.target.clear', entityType: 'channel', entityId: id, before: { url: before.liveRtmpUrl }, after: { url: target ? parseLiveTarget(target.url, target.key).url : null }, requestId: ctx.requestId });
    await this.bus.publish({ type: 'stations-changed' });
    return this.require(id);
  }
}

/** Splits/validates an RTMP(S) URL + key. Exported for tests. */
export function parseLiveTarget(rawUrl: string, rawKey?: string): { url: string; key: string } {
  let url = rawUrl.trim();
  let key = (rawKey ?? '').trim();
  if (!/^rtmps?:\/\/[^\s]+$/i.test(url)) throw new BadRequestException('The link must start with rtmp:// or rtmps://');
  if (key === '') {
    const cut = url.lastIndexOf('/');
    const tail = url.slice(cut + 1);
    if (cut <= url.indexOf('//') + 1 || tail === '') throw new BadRequestException('Paste the stream key too (or a full link that ends with the key)');
    key = tail;
    url = url.slice(0, cut + 1);
  }
  if (/\s/.test(key) || key.length > 300) throw new BadRequestException('Invalid stream key');
  if (url.length > 300) throw new BadRequestException('The link is too long');
  return { url: url.endsWith('/') ? url : `${url}/`, key };
}
