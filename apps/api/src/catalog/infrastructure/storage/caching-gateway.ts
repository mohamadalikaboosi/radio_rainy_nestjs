import { Logger } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { audioHashFrom } from '../../../lyrics/application/track-transcription.service';
import { FetchAudioOptions, TelegramAudioMessage, TelegramChannelInfo, TelegramGateway } from '../../application/ports/telegram.types';
import { AudioStore, AudioStoreSource } from '../../application/ports/audio-store';

export interface AudioKeyResolver {
  /** Stable object key for a message's audio, or null if the track is unknown. The key changes if Telegram's file changes. */
  keyFor(channelId: string, messageId: number): Promise<{ key: string; size: number | null } | null>;
}

export function resolverFrom(lookup: (channelId: string, messageId: number) => Promise<{ fileReference: string; fileSize: number | null } | null>): AudioKeyResolver {
  return {
    async keyFor(channelId, messageId) {
      const id = await lookup(channelId, messageId);
      return id ? { key: `audio/${channelId}/${messageId}-${audioHashFrom(id.fileReference, id.fileSize).slice(0, 16)}`, size: id.fileSize } : null;
    },
  };
}

/** Larger files are streamed straight from Telegram without being cached (their tee buffer would be too big). */
const MAX_TEE_BYTES = 64 * 1024 * 1024;

/**
 * Cache-through decorator around the Telegram gateway: audio is served from the object store (MinIO) when it is there;
 * otherwise it is downloaded from Telegram ONCE, streamed to the caller and to the store at the same time.
 * Any store problem degrades to plain Telegram streaming, so playback never depends on MinIO being healthy.
 */
export class CachingTelegramGateway implements TelegramGateway {
  private readonly logger = new Logger(CachingTelegramGateway.name);
  private readonly filling = new Set<string>();

  constructor(
    private readonly inner: TelegramGateway,
    private readonly source: AudioStoreSource,
    private readonly keys: AudioKeyResolver,
  ) {}

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
    const offset = opts.offset ?? 0;
    const target = await this.locate(channelId, messageId);
    if (!target) {
      yield* this.inner.download(channelId, messageId, opts);
      return;
    }
    const { store, key, size } = target;

    // 1) cache hit
    let stored: { size: number } | null = null;
    try {
      stored = await store.stat(key);
    } catch (err) {
      this.logger.warn({ msg: 'audio store unreachable, streaming from Telegram', key, err: String(err) });
      yield* this.inner.download(channelId, messageId, opts);
      return;
    }
    if (stored && (size === null || stored.size === size)) {
      let position = offset;
      try {
        for await (const chunk of store.open(key, { offset, signal: opts.signal })) {
          position += chunk.length;
          yield chunk;
        }
        return;
      } catch (err) {
        if (opts.signal?.aborted) return;
        this.logger.warn({ msg: 'audio store read failed, continuing from Telegram', key, position, err: String(err) });
        yield* this.inner.download(channelId, messageId, { ...opts, offset: position });
        return;
      }
    }

    // 2) miss: one Telegram download that also fills the cache (only for complete, reasonably sized files)
    if (offset > 0 || this.filling.has(key) || (size !== null && size > MAX_TEE_BYTES)) {
      yield* this.inner.download(channelId, messageId, opts);
      return;
    }
    yield* this.tee(store, key, size, channelId, messageId, opts.signal);
  }

  private async locate(channelId: string, messageId: number): Promise<{ store: AudioStore; key: string; size: number | null } | null> {
    try {
      const store = await this.source.current();
      if (!store) return null;
      const id = await this.keys.keyFor(channelId, messageId);
      return id ? { store, ...id } : null;
    } catch (err) {
      this.logger.warn({ msg: 'audio cache lookup failed', err: String(err) });
      return null;
    }
  }

  /**
   * Reads Telegram at full speed into (a) the store upload and (b) a queue for the caller. The download keeps going after the
   * caller leaves (e.g. skip) so the cache still ends up complete; a failed/partial download never leaves an object behind.
   */
  private async *tee(store: AudioStore, key: string, size: number | null, channelId: string, messageId: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    this.filling.add(key);
    const pass = new PassThrough({ highWaterMark: 1024 * 1024 });
    pass.on('error', () => undefined); // reported through the upload promise
    let uploadOk = true;
    const upload = store.put(key, pass, size ?? undefined).catch((err: unknown) => {
      uploadOk = false;
      this.logger.warn({ msg: 'audio cache upload failed (playback continues)', key, err: String(err) });
    });

    const queue: Uint8Array[] = [];
    let done = false;
    let failure: unknown;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      wake?.();
      wake = null;
    };
    let received = 0;

    void (async () => {
      try {
        for await (const chunk of this.inner.download(channelId, messageId, {})) {
          received += chunk.length;
          queue.push(chunk);
          notify();
          if (uploadOk && !pass.destroyed) {
            if (!pass.write(chunk)) await Promise.race([once(pass, 'drain'), upload]);
          }
        }
        if (size !== null && received !== size) throw new Error(`incomplete download: ${received}/${size} bytes`);
        pass.end();
      } catch (err) {
        failure = err;
        pass.destroy(err instanceof Error ? err : new Error(String(err))); // aborts the upload: nothing partial is stored
      } finally {
        done = true;
        notify();
        void upload.finally(() => this.filling.delete(key));
      }
    })();

    while (!signal?.aborted) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (done) {
        if (failure) throw failure;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }
}
