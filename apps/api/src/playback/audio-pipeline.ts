import { Logger } from '@nestjs/common';
import { stripId3v2 } from '../streaming/id3';
import { TelegramFloodWaitError, TelegramGateway, TelegramNotReadyError } from '../telegram/telegram.types';
import { Track } from '../track/track.types';

/** Live transcoder (ffmpeg) for non-MP3 sources so the shared HTTP stream stays one continuous MP3. */
export interface LiveTranscoder {
  toMp3(source: AsyncIterable<Uint8Array>, bitrateKbps: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface OpenedAudio {
  bytes: AsyncIterable<Uint8Array>;
  bytesPerSec: number;
  /** Releases the underlying Telegram download (idempotent). */
  cancel(): Promise<void>;
}

const MP3_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3']);
const MIN_BPS = 4_000; // 32 kbps
const MAX_BPS = 40_000; // 320 kbps

/** Download with resume: a mid-file network hiccup continues from the last received byte instead of skipping the track. */
export async function* resilientDownload(
  gateway: TelegramGateway,
  channelId: string,
  messageId: number,
  signal: AbortSignal | undefined,
  maxResumes = 2,
  logger?: Logger,
): AsyncGenerator<Uint8Array> {
  let received = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const chunk of gateway.download(channelId, messageId, { offset: received, signal })) {
        received += chunk.length;
        yield chunk;
      }
      return;
    } catch (err) {
      if (signal?.aborted) return;
      // Global outages are not fixed by an immediate retry; let the engine back off.
      if (err instanceof TelegramNotReadyError || err instanceof TelegramFloodWaitError) throw err;
      if (attempt >= maxResumes) throw err;
      logger?.warn({ msg: 'download interrupted, resuming', messageId, offset: received, attempt: attempt + 1, err: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Bounded read-ahead of the next track's first bytes so the transition has no download latency.
 * Memory is capped at `maxBytes`; the rest streams live from the same iterator.
 */
export class PrefetchedAudio implements OpenedAudio {
  private readonly buffered: Uint8Array[] = [];
  private bufferedBytes = 0;
  private ended = false;
  private error: unknown;
  private started: Promise<void> | null = null;
  private consumed = false;
  private readonly iterator: AsyncIterator<Uint8Array>;

  constructor(private readonly inner: OpenedAudio, private readonly maxBytes: number) {
    this.iterator = inner.bytes[Symbol.asyncIterator]();
  }
  get bytesPerSec(): number {
    return this.inner.bytesPerSec;
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      try {
        while (this.bufferedBytes < this.maxBytes) {
          const r = await this.iterator.next();
          if (r.done) {
            this.ended = true;
            return;
          }
          this.buffered.push(r.value);
          this.bufferedBytes += r.value.length;
        }
      } catch (err) {
        this.error = err;
      }
    })();
    return this.started;
  }

  get bytes(): AsyncIterable<Uint8Array> {
    return this.stream();
  }

  private async *stream(): AsyncGenerator<Uint8Array> {
    if (this.consumed) throw new Error('PrefetchedAudio can be consumed only once');
    this.consumed = true;
    await this.start();
    for (const c of this.buffered) yield c;
    this.buffered.length = 0;
    if (this.error) throw this.error;
    if (this.ended) return;
    try {
      for (;;) {
        const r = await this.iterator.next();
        if (r.done) return;
        yield r.value;
      }
    } finally {
      await this.iterator.return?.();
    }
  }

  async cancel(): Promise<void> {
    this.buffered.length = 0;
    await this.started?.catch(() => undefined);
    await this.iterator.return?.();
    await this.inner.cancel();
  }
}

export class TrackAudioPipeline {
  private readonly logger = new Logger(TrackAudioPipeline.name);

  constructor(
    private readonly gateway: TelegramGateway,
    private readonly transcoder: LiveTranscoder | null,
    private readonly defaultBitrateKbps: number,
  ) {}

  open(track: Track, signal: AbortSignal): OpenedAudio {
    const raw = resilientDownload(this.gateway, track.telegramChannelId, track.telegramMessageId, signal, 2, this.logger);
    const isMp3 = track.mimeType !== null && MP3_MIME.has(track.mimeType.toLowerCase());
    const cancel = async (): Promise<void> => {
      await raw.return(undefined);
    };

    if (isMp3) {
      let bps = (this.defaultBitrateKbps * 1000) / 8;
      if (track.fileSize && track.duration && track.duration > 0) {
        const measured = track.fileSize / track.duration;
        if (measured >= MIN_BPS && measured <= MAX_BPS) bps = measured;
      }
      return { bytes: stripId3v2(raw), bytesPerSec: bps, cancel };
    }
    if (!this.transcoder) throw new Error(`Track ${track.id} is ${track.mimeType ?? 'unknown'} and no transcoder (ffmpeg) is configured`);
    return { bytes: this.transcoder.toMp3(raw, this.defaultBitrateKbps, signal), bytesPerSec: (this.defaultBitrateKbps * 1000) / 8, cancel };
  }
}
