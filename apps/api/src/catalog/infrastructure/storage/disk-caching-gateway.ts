import { TelegramAudioMessage, TelegramChannelInfo, FetchAudioOptions, TelegramGateway } from '../../application/ports/telegram.types';
import { AudioKeyResolver } from './caching-gateway';
import { DiskAudioCache } from './disk-audio-cache';

/**
 * Outermost audio layer: every download goes through the local disk cache (Telegram or the object store is only hit on a miss,
 * once per track). Everything else is delegated untouched.
 */
export class DiskCachingGateway implements TelegramGateway {
  constructor(private readonly inner: TelegramGateway, private readonly cache: DiskAudioCache, private readonly keys: AudioKeyResolver) {}

  resolveChannel(reference: string): Promise<TelegramChannelInfo> {
    return this.inner.resolveChannel(reference);
  }
  fetchAudioMessages(channelId: string, opts?: FetchAudioOptions): AsyncIterable<TelegramAudioMessage> {
    return this.inner.fetchAudioMessages(channelId, opts);
  }
  getAudioMessage(channelId: string, messageId: number): Promise<TelegramAudioMessage | null> {
    return this.inner.getAudioMessage(channelId, messageId);
  }
  existingAudioMessageIds(channelId: string, messageIds: readonly number[]): Promise<Set<number>> {
    return this.inner.existingAudioMessageIds(channelId, messageIds);
  }

  async *download(channelId: string, messageId: number, opts: { offset?: number; signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    let id: { key: string; size: number | null } | null = null;
    if (this.cache.enabled) {
      try {
        id = await this.keys.keyFor(channelId, messageId);
      } catch {
        id = null; // unknown track / DB hiccup: plain streaming below
      }
    }
    if (!id) {
      yield* this.inner.download(channelId, messageId, opts);
      return;
    }
    yield* this.cache.stream(id.key, id.size, () => this.inner.download(channelId, messageId, {}), opts);
  }
}
