import { Injectable, Logger } from '@nestjs/common';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { withFloodWait } from '../../application/flood-wait';
import { TelegramClientManager } from './telegram-client.manager';
import {
  ChannelDirectory,
  FetchAudioOptions,
  TelegramAudioMessage,
  TelegramChannelInfo,
  TelegramGateway,
  TelegramMediaError,
} from '../../application/ports/telegram.types';

/**
 * Bytes per upload.getFile request. A download is one request after another, so its speed is (request size / round-trip time):
 * 128 KiB gave only ~1 MB/s on a 120 ms link, 512 KiB is four times faster. Telegram needs a power of two between 64 KiB and 1 MiB.
 */
export const DEFAULT_DOWNLOAD_REQUEST_KB = 512;

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
  private readonly cache = new Map<string, { entity: Api.Channel; info: TelegramChannelInfo }>();

  constructor(
    private readonly manager: TelegramClientManager,
    private readonly directory: ChannelDirectory,
    private readonly requestKb: number = DEFAULT_DOWNLOAD_REQUEST_KB,
  ) {}

  async resolveChannel(reference: string): Promise<TelegramChannelInfo> {
    return (await this.lookup(reference.trim())).info;
  }

  private async lookup(ref: string): Promise<{ entity: Api.Channel; info: TelegramChannelInfo }> {
    const client = this.manager.getClient();
    const numeric = /^-?\d+$/.test(ref);
    let entity: unknown;
    try {
      entity = await withFloodWait('getEntity', () => client.getEntity(numeric ? bigInt(ref.replace(/^-100/, '')) : ref));
    } catch (err) {
      if (!numeric) throw err;
      // Numeric ids need the access hash cached: load dialogs once, then retry.
      await withFloodWait('getDialogs', () => client.getDialogs({ limit: 200 }));
      entity = await client.getEntity(new Api.PeerChannel({ channelId: bigInt(ref.replace(/^-100/, '')) }));
    }
    if (!(entity instanceof Api.Channel)) throw new TelegramMediaError(`"${ref}" is not a channel`, false);
    const info: TelegramChannelInfo = { id: entity.id.toString(), title: entity.title, username: entity.username ?? undefined };
    const hit = { entity, info };
    this.cache.set(info.id, hit);
    return hit;
  }

  /** Entity of a known station channel (resolved lazily from its stored reference after restarts). */
  async entityOf(channelId: string): Promise<{ entity: Api.Channel; info: TelegramChannelInfo }> {
    const cached = this.cache.get(channelId);
    if (cached) return cached;
    const ref = (await this.directory.referenceOf(channelId)) ?? channelId;
    const found = await this.lookup(ref);
    if (found.info.id !== channelId) throw new TelegramMediaError(`Channel reference "${ref}" now points to a different channel`, false);
    return found;
  }

  async *fetchAudioMessages(channelId: string, opts: FetchAudioOptions = {}): AsyncIterable<TelegramAudioMessage> {
    const { entity, info } = await this.entityOf(channelId);
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

  async getAudioMessage(channelId: string, messageId: number): Promise<TelegramAudioMessage | null> {
    const { info } = await this.entityOf(channelId);
    const m = await this.fetchRaw(channelId, messageId);
    return m ? toAudioMessage(m, info.id, info.username) : null;
  }

  async existingAudioMessageIds(channelId: string, messageIds: readonly number[]): Promise<Set<number>> {
    const { entity, info } = await this.entityOf(channelId);
    const client = this.manager.getClient();
    const found = await withFloodWait('getMessages', () => client.getMessages(entity, { ids: [...messageIds] }));
    const out = new Set<number>();
    for (const m of found) {
      if (m instanceof Api.Message && toAudioMessage(m, info.id, info.username)) out.add(m.id);
    }
    return out;
  }

  private async fetchRaw(channelId: string, messageId: number): Promise<Api.Message | null> {
    const { entity } = await this.entityOf(channelId);
    const client = this.manager.getClient();
    const [m] = await withFloodWait('getMessages', () => client.getMessages(entity, { ids: [messageId] }));
    return m instanceof Api.Message ? m : null;
  }

  /**
   * Streams the file in small chunks. The message is re-fetched right before download so the file reference
   * is always fresh (expired references are the classic MTProto download failure).
   */
  async *download(channelId: string, messageId: number, opts: { offset?: number; signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    const { entity } = await this.entityOf(channelId);
    const client: TelegramClient = this.manager.getClient();
    const message = await this.fetchRaw(channelId, messageId);
    if (!message || !message.media) throw new TelegramMediaError(`Message ${messageId} not found or has no media`, false);

    // Telegram wants the offset to be a multiple of the request size: start at the block boundary and drop the bytes already received
    const requestSize = this.requestKb * 1024;
    const wanted = opts.offset ?? 0;
    const start = Math.floor(wanted / requestSize) * requestSize;
    let skip = wanted - start;
    const iter = client.iterDownload({
      file: message.media,
      offset: bigInt(start),
      requestSize,
      msgData: [entity, messageId],
    });
    try {
      for await (const chunk of iter) {
        if (opts.signal?.aborted) return;
        if (skip > 0) {
          if (chunk.length <= skip) {
            skip -= chunk.length;
            continue;
          }
          yield chunk.subarray(skip);
          skip = 0;
          continue;
        }
        yield chunk;
      }
    } catch (err) {
      throw new TelegramMediaError(`Download failed for message ${messageId}: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      await iter.close().catch((e: unknown) => this.logger.warn({ msg: 'download iterator close failed', err: String(e) }));
    }
  }
}
