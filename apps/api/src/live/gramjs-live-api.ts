import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Api } from 'telegram';
import { GramJsTelegramGateway } from '../telegram/gramjs.gateway';
import { TelegramClientManager } from '../telegram/telegram-client.manager';
import { RtmpTarget, TelegramLiveApi } from './telegram-live-streamer';

/**
 * Telegram live streams (RTMP) through MTProto: phone.createGroupCall(rtmp_stream) + phone.getGroupCallStreamRtmpUrl.
 * The logged-in account must be an admin of the channel with the "Manage Live Streams" right.
 */
@Injectable()
export class GramJsLiveApi implements TelegramLiveApi {
  private readonly logger = new Logger(GramJsLiveApi.name);

  constructor(private readonly manager: TelegramClientManager, private readonly gateway: GramJsTelegramGateway) {}

  async openLiveStream(channelId: string, title: string): Promise<RtmpTarget> {
    const client = this.manager.getClient();
    const { entity } = await this.gateway.entityOf(channelId);
    const peer = await client.getInputEntity(entity);

    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: await client.getInputEntity(entity) }));
    const hasCall = full.fullChat instanceof Api.ChannelFull && full.fullChat.call !== undefined;
    if (!hasCall) {
      try {
        await client.invoke(new Api.phone.CreateGroupCall({ peer, randomId: randomBytes(4).readInt32BE(), rtmpStream: true, title: title.slice(0, 64) }));
        this.logger.log({ msg: 'created telegram live stream', channelId });
      } catch (err) {
        throw this.describe(err);
      }
    }
    try {
      const res = await client.invoke(new Api.phone.GetGroupCallStreamRtmpUrl({ peer, revoke: false }));
      return { url: res.url, key: res.key };
    } catch (err) {
      throw this.describe(err);
    }
  }

  async closeLiveStream(channelId: string): Promise<void> {
    const client = this.manager.getClient();
    const { entity } = await this.gateway.entityOf(channelId);
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: await client.getInputEntity(entity) }));
    const call = full.fullChat instanceof Api.ChannelFull ? full.fullChat.call : undefined;
    if (call instanceof Api.InputGroupCall) await client.invoke(new Api.phone.DiscardGroupCall({ call }));
  }

  private describe(err: unknown): Error {
    const rpc = typeof err === 'object' && err !== null && 'errorMessage' in err ? String((err as { errorMessage: unknown }).errorMessage) : '';
    const hints: Record<string, string> = {
      CHAT_ADMIN_REQUIRED: 'the logged-in account must be an admin of the channel with the "Manage Live Streams" right',
      GROUPCALL_ALREADY_STARTED: 'a live stream is already running in this channel',
      RTMP_CHANNEL_INVALID: 'this channel cannot use RTMP streaming',
    };
    return new Error(rpc ? `Telegram: ${rpc}${hints[rpc] ? ` — ${hints[rpc]}` : ''}` : err instanceof Error ? err.message : String(err));
  }
}
