import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Api, TelegramClient } from 'telegram';
import { GramJsTelegramGateway } from '../../catalog/infrastructure/telegram/gramjs.gateway';
import { TelegramClientManager } from '../../catalog/infrastructure/telegram/telegram-client.manager';
import { RtmpTarget, TelegramLiveApi } from '../application/telegram-live-streamer';

/** Telegram error codes of the live-stream methods, with what to do about them. */
const HINTS: Record<string, string> = {
  CHAT_ADMIN_REQUIRED: 'the logged-in Telegram account must be the owner/an admin of the channel with the "Manage Live Streams" (voice chats) right',
  CHANNEL_PRIVATE: 'the logged-in account is not a member/admin of this channel',
  CHANNEL_INVALID: 'the channel could not be resolved; check the channel reference',
  PEER_ID_INVALID: 'the channel could not be resolved; check the channel reference',
  GROUPCALL_ALREADY_STARTED: 'a live stream is already running in this channel',
  GROUPCALL_INVALID: 'the live stream of this channel is not valid (it was probably just ended); try again',
  GROUPCALL_FORBIDDEN: 'this account may not manage the live stream of the channel',
  RTMP_CHANNEL_INVALID: 'this channel cannot use RTMP streaming',
  CREATE_CALL_FAILED: 'Telegram refused to create the live stream (the account needs the "Manage Live Streams" right; some accounts/channels cannot stream yet)',
  BROADCAST_FORBIDDEN: 'only a channel (not a group) can start a live stream like this',
};

function rpcCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'errorMessage' in err ? String((err as { errorMessage: unknown }).errorMessage) : '';
}

/**
 * Telegram live streams (RTMP) through MTProto, so no link has to be pasted:
 *   1. channels.getFullChannel      -> is there already a live stream / voice chat (`call`)?
 *   2. phone.getGroupCall           -> is it an RTMP live stream? (a normal voice chat has no RTMP ingest)
 *   3. phone.createGroupCall(rtmp_stream = true)  -> create the live stream when there is none
 *   4. phone.getGroupCallStreamRtmpUrl            -> the server URL + stream key that ffmpeg publishes to
 * The logged-in account must be an admin of the channel with the "Manage Live Streams" right.
 * Every failure names the step that failed and the Telegram error code, so the panel shows an actionable message.
 */
@Injectable()
export class GramJsLiveApi implements TelegramLiveApi {
  private readonly logger = new Logger(GramJsLiveApi.name);

  constructor(private readonly manager: TelegramClientManager, private readonly gateway: GramJsTelegramGateway) {}

  async openLiveStream(channelId: string, title: string): Promise<RtmpTarget> {
    const client = this.manager.getClient();
    const peer = await this.step('resolve the channel', async () => client.getInputEntity((await this.gateway.entityOf(channelId)).entity));

    let call = await this.step('read the channel', () => this.currentCall(client, peer));
    if (call) {
      const state = await this.step('read the live stream', () => this.callState(client, call as Api.InputGroupCall));
      if (state === 'ended') call = null;
      else if (state === 'voice-chat') {
        // a normal voice chat has no RTMP ingest; an empty one is replaced, one with people in it is never killed
        const people = await this.step('read the voice chat', () => this.participants(client, call as Api.InputGroupCall));
        if (people > 1) throw new Error('Telegram: this channel already has a normal voice chat with people in it (not a live stream). End it in Telegram, then start again.');
        await this.step('replace the empty voice chat', () => client.invoke(new Api.phone.DiscardGroupCall({ call: call as Api.InputGroupCall })));
        call = null;
      }
    }
    if (!call) {
      try {
        await this.step('create the live stream', () => client.invoke(new Api.phone.CreateGroupCall({ peer, randomId: randomBytes(4).readInt32BE(), rtmpStream: true, title: title.slice(0, 64) })));
        this.logger.log({ msg: 'created telegram live stream', channelId });
      } catch (err) {
        // lost a race with the Telegram app / another start: the stream exists, that's all we wanted
        if (!String(err instanceof Error ? err.message : err).includes('GROUPCALL_ALREADY_STARTED')) throw err;
      }
    }
    const res = await this.step('get the stream URL and key', async () => {
      try {
        return await client.invoke(new Api.phone.GetGroupCallStreamRtmpUrl({ peer, revoke: false }));
      } catch (err) {
        if (!/GROUPCALL_INVALID|GROUPCALL_NOT_FOUND/.test(rpcCode(err))) throw err;
        await new Promise((r) => setTimeout(r, 1500)); // a stream created a moment ago is not always visible yet
        return client.invoke(new Api.phone.GetGroupCallStreamRtmpUrl({ peer, revoke: false }));
      }
    });
    if (!/^rtmps?:\/\//i.test(res.url) || !res.key) throw new Error(`Telegram returned an unusable stream address ("${res.url.slice(0, 40)}")`);
    return { url: res.url, key: res.key };
  }

  async closeLiveStream(channelId: string): Promise<void> {
    const client = this.manager.getClient();
    const { entity } = await this.gateway.entityOf(channelId);
    const call = await this.currentCall(client, await client.getInputEntity(entity));
    if (call) await client.invoke(new Api.phone.DiscardGroupCall({ call }));
  }

  private async currentCall(client: TelegramClient, peer: Api.TypeInputPeer): Promise<Api.InputGroupCall | null> {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: peer as unknown as Api.TypeInputChannel }));
    const call = full.fullChat instanceof Api.ChannelFull ? full.fullChat.call : undefined;
    return call instanceof Api.InputGroupCall ? call : null;
  }

  private async callState(client: TelegramClient, call: Api.InputGroupCall): Promise<'rtmp' | 'voice-chat' | 'ended'> {
    const res = await client.invoke(new Api.phone.GetGroupCall({ call, limit: 1 }));
    if (!(res.call instanceof Api.GroupCall)) return 'ended';
    return res.call.rtmpStream ? 'rtmp' : 'voice-chat';
  }

  private async participants(client: TelegramClient, call: Api.InputGroupCall): Promise<number> {
    const res = await client.invoke(new Api.phone.GetGroupCall({ call, limit: 1 }));
    return res.call instanceof Api.GroupCall ? res.call.participantsCount : 0;
  }

  /** Runs one step; a failure says which step and which Telegram error. */
  private async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Telegram: ')) throw err;
      throw this.describe(name, err);
    }
  }

  private describe(step: string, err: unknown): Error {
    const code = rpcCode(err);
    const flood = /^FLOOD_WAIT_(\d+)/.exec(code) ?? /^FLOOD_WAIT_(\d+)/.exec(err instanceof Error ? err.message : '');
    if (flood) return new Error(`Telegram: could not ${step}: too many requests, retry in ${flood[1]} s`);
    const msg = code || (err instanceof Error ? err.message : String(err));
    const hint = HINTS[code] ?? Object.entries(HINTS).find(([k]) => msg.includes(k))?.[1];
    return new Error(`Telegram: could not ${step}: ${msg}${hint ? ` — ${hint}` : ''}`);
  }
}
