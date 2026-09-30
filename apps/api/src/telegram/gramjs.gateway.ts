import { Inject, Injectable, Logger } from '@nestjs/common';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { withFloodWait } from './flood-wait';
import { TelegramClientManager } from './telegram-client.manager';
import {
  FetchAudioOptions,
  TelegramAudioMessage,
  TelegramChannelInfo,
  TelegramGateway,
  TelegramMediaError,
} from './telegram.types';

/** 128 KiB requests: small first chunk = low time-to-first-byte for the radio (must be a multiple of 4096). */
const DOWNLOAD_REQUEST_SIZE = 128 * 1024;

/** Converts a raw MTProto message into our neutral type. Returns null for non-audio (voice notes, video, text...). */
export function toAudioMessage(msg: Api.Message, channelId: string, username?: string): TelegramAudioMessage | null {
  const media = msg.media;
  if (!(media instanceof Api.MessageMediaDocument)) return null;
  const doc = media.document;
  if (!(doc instanceof Api.Document)) return null;

  let audio: Api.DocumentAttributeAudio | undefined;
  let fileName: string | undefined;
  for (const attr of doc.attributes) {
    if (attr instanceof Api.DocumentAttributeAudio) audio = attr;
    else if (attr instanceof Api.DocumentAttributeFilename) fileName = attr.fileName;
  }
  if (audio?.voice) return null;
  if (!audio && !doc.mimeType.startsWith('audio/')) return null;

  const entityUrls: string[] = [];
  for (const e of msg.entities ?? []) {
    if (e instanceof Api.MessageEntityTextUrl) entityUrls.push(e.url);
  }
  const postUrl = username ? `https://t.me/${username}/${msg.id}` : `https://t.me/c/${channelId}/${msg.id}`;

  return {
    channelId,
    messageId: msg.id,
    date: new Date(msg.date * 1000),
    caption: msg.message ?? '',
    entityUrls,
    postUrl,
    audio: {
      mimeType: doc.mimeType,
      size: doc.size.toJSNumber(),
      duration: audio?.duration,
      title: audio?.title,
      performer: audio?.performer,
      fileName,
      fileReference: JSON.stringify({
        id: doc.id.toString(),
        accessHash: doc.accessHash.toString(),
        dcId: doc.dcId,
        fileReference: Buffer.from(doc.fileReference).toString('base64'),
      }),
    },
  };
}

@Injectable()
export class GramJsTelegramGateway implements TelegramGateway {
  private readonly logger = new Logger(GramJsTelegramGateway.name);
  private channelCache: { entity: Api.Channel; info: TelegramChannelInfo } | null = null;

  constructor(
    private readonly manager: TelegramClientManager,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'TELEGRAM_CHANNEL'>,
  ) {}

  async resolveChannel(): Promise<TelegramChannelInfo> {
    return (await this.channel()).info;
  }

  private async channel(): Promise<{ entity: Api.Channel; info: TelegramChannelInfo }> {
    const client = this.manager.getClient();
    if (this.channelCache) return this.channelCache;
    const ref = this.config.TELEGRAM_CHANNEL.trim();
    let entity: unknown;
    try {
      entity = await withFloodWait('getEntity', () => client.getEntity(/^-?\d+$/.test(ref) ? bigInt(ref.replace(/^-100/, '')) : ref));
    } catch (err) {
      if (!/^-?\d+$/.test(ref)) throw err;
      // Numeric ids need the access hash cached: load dialogs once, then retry.
      await withFloodWait('getDialogs', () => client.getDialogs({ limit: 200 }));
      entity = await client.getEntity(new Api.PeerChannel({ channelId: bigInt(ref.replace(/^-100/, '')) }));
    }
    if (!(entity instanceof Api.Channel)) throw new TelegramMediaError(`TELEGRAM_CHANNEL "${ref}" is not a channel`, false);
    const info: TelegramChannelInfo = { id: entity.id.toString(), title: entity.title, username: entity.username ?? undefined };
    this.channelCache = { entity, info };
    return this.channelCache;
  }

  async *fetchAudioMessages(opts: FetchAudioOptions = {}): AsyncIterable<TelegramAudioMessage> {
    const { entity, info } = await this.channel();
    const client = this.manager.getClient();
    const iter = client.iterMessages(entity, {
      filter: new Api.InputMessagesFilterMusic(),
      minId: opts.minId ?? 0,
      limit: opts.limit,
      waitTime: 1, // gentle pacing between history pages
    });
    for await (const m of iter) {
      if (!(m instanceof Api.Message)) continue;
      const converted = toAudioMessage(m, info.id, info.username);
      if (converted) yield converted;
    }
  }

  async getAudioMessage(messageId: number): Promise<TelegramAudioMessage | null> {
    const { info } = await this.channel();
    const m = await this.fetchRaw(messageId);
    return m ? toAudioMessage(m, info.id, info.username) : null;
  }

  async existingAudioMessageIds(messageIds: readonly number[]): Promise<Set<number>> {
    const { entity, info } = await this.channel();
    const client = this.manager.getClient();
    const found = await withFloodWait('getMessages', () => client.getMessages(entity, { ids: [...messageIds] }));
    const out = new Set<number>();
    for (const m of found) {
      if (m instanceof Api.Message && toAudioMessage(m, info.id, info.username)) out.add(m.id);
    }
    return out;
  }

  private async fetchRaw(messageId: number): Promise<Api.Message | null> {
    const { entity } = await this.channel();
    const client = this.manager.getClient();
    const [m] = await withFloodWait('getMessages', () => client.getMessages(entity, { ids: [messageId] }));
    return m instanceof Api.Message ? m : null;
  }

  /**
   * Streams the file in small chunks. The message is re-fetched right before download so the file reference
   * is always fresh (expired references are the classic MTProto download failure).
   */
  async *download(messageId: number, opts: { offset?: number; signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    const { entity } = await this.channel();
    const client: TelegramClient = this.manager.getClient();
    const message = await this.fetchRaw(messageId);
    if (!message || !message.media) throw new TelegramMediaError(`Message ${messageId} not found or has no media`, false);

    const iter = client.iterDownload({
      file: message.media,
      offset: bigInt(opts.offset ?? 0),
      requestSize: DOWNLOAD_REQUEST_SIZE,
      msgData: [entity, messageId],
    });
    try {
      for await (const chunk of iter) {
        if (opts.signal?.aborted) return;
        yield chunk;
      }
    } catch (err) {
      throw new TelegramMediaError(`Download failed for message ${messageId}: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      await iter.close().catch((e: unknown) => this.logger.warn({ msg: 'download iterator close failed', err: String(e) }));
    }
  }
}
