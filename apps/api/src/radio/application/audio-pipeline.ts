import { Logger } from '@nestjs/common';
import { mp3BytesPerSec } from '../../engagement/domain/mp3-info';
import { stripId3v2 } from '../domain/id3';
import { TelegramFloodWaitError, TelegramGateway, TelegramNotReadyError } from '../../catalog/application/ports/telegram.types';
import { Track } from '../../catalog/domain/track.types';

/** Live transcoder (ffmpeg) for non-MP3 sources so the shared HTTP stream stays one continuous MP3. */
export interface LiveTranscoder {
  toMp3(source: AsyncIterable<Uint8Array>, bitrateKbps: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface OpenedAudio {
  bytes: AsyncIterable<Uint8Array>;
  /** Real-time rate. May be refined once the first bytes have been read (it is read again for every paced slice). */
  readonly bytesPerSec: number;
  /** Releases the underlying Telegram download (idempotent). */
  cancel(): Promise<void>;
}

const MP3_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3']);
const MIN_BPS = 4_000; // 32 kbps
const MAX_BPS = 40_000; // 320 kbps: no MP3 is faster
/** Enough audio to find the first frames (and a Xing/VBRI header) after the ID3 tag. */
const PROBE_BYTES = 16 * 1024;

/**
 * Rate from the Telegram metadata. The file size includes the ID3 tag (cover art!) and the duration is rounded, so a 320 kbps file reads a
 * little above 320 kbps: that is capped, never thrown away (falling back to 128 kbps played such tracks at 0.4x real time).
 */
export function metadataBytesPerSec(audioBytes: number | null, duration: number | null): number | null {
  if (!audioBytes || !duration || duration <= 0) return null;
  const bps = audioBytes / duration;
  return bps < MIN_BPS ? null : Math.min(bps, MAX_BPS);
}

/** Passes the audio through untouched and shows `inspect` its first `size` bytes as soon as they are there (or the whole input, if shorter). */
async function* tapHead(source: AsyncIterable<Uint8Array>, size: number, inspect: (head: Buffer) => void): AsyncGenerator<Uint8Array> {
  let head: Uint8Array[] | null = [];
  let bytes = 0;
  for await (const chunk of source) {
    if (head) {
      head.push(chunk);
      bytes += chunk.length;
      if (bytes >= size) {
        inspect(Buffer.concat(head));
        head = null;
      }
    }
    yield chunk;
  }
  if (head && bytes > 0) inspect(Buffer.concat(head));
}

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
  private headWaiters: (() => void)[] = [];

  constructor(private readonly inner: OpenedAudio, private readonly maxBytes: number) {
    this.iterator = inner.bytes[Symbol.asyncIterator]();
  }
  get bytesPerSec(): number {
    return this.inner.bytesPerSec;
  }

  /** Why the read-ahead failed (if it did). */
  get failure(): unknown {
    return this.error;
  }

  /** The first buffered bytes (for a quick sanity check of the audio). */
  head(max: number): Buffer {
    return Buffer.concat(this.buffered.map((b) => Buffer.from(b))).subarray(0, max);
  }

  /**
   * Waits for the read-ahead to finish (first bytes arrived / file ended) or fail, at most `timeoutMs`.
   * A slow download is 'TIMEOUT', a failed one 'FAILED'.
   */
  async whenReady(timeoutMs: number): Promise<'READY' | 'FAILED' | 'TIMEOUT'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
    });
    try {
      return await Promise.race([this.start().then(() => (this.error !== undefined ? ('FAILED' as const) : ('READY' as const))), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** True once enough bytes arrived to start playing (first 256 KiB, the end of the file, or a failure). */
  private get headDone(): boolean {
    return this.bufferedBytes >= Math.min(this.maxBytes, 256 * 1024) || this.ended || this.error !== undefined;
  }

  /** Like whenReady, but only waits for the FIRST bytes (not the whole read-ahead). */
  async whenHead(timeoutMs: number): Promise<'READY' | 'FAILED' | 'TIMEOUT'> {
    void this.start();
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<'READY' | 'FAILED'>((resolve) => {
      const check = (): void => resolve(this.error !== undefined ? 'FAILED' : 'READY');
      if (this.headDone) return check();
      this.headWaiters.push(check);
    });
    const timeout = new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
    });
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private wakeHead(): void {
    if (!this.headDone) return;
    const w = this.headWaiters;
    this.headWaiters = [];
    for (const f of w) f();
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      try {
        while (this.bufferedBytes < this.maxBytes) {
          const r = await this.iterator.next();
          if (r.done) {
            this.ended = true;
            this.wakeHead();
            return;
          }
          this.buffered.push(r.value);
          this.bufferedBytes += r.value.length;
          this.wakeHead();
        }
      } catch (err) {
        this.error = err;
      } finally {
        this.wakeHead();
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
      // First guess from the metadata; replaced by what the audio itself says (frame bitrate / VBR header) once its first bytes arrive.
      let bps = metadataBytesPerSec(track.fileSize, track.duration) ?? (this.defaultBitrateKbps * 1000) / 8;
      let tagBytes = 0;
      const bytes = tapHead(stripId3v2(raw, (n) => (tagBytes = n)), PROBE_BYTES, (head) => {
        const audioBytes = track.fileSize ? Math.max(0, track.fileSize - tagBytes) : null;
        const fromAudio = mp3BytesPerSec(head, audioBytes);
        const refined = fromAudio !== null && fromAudio >= MIN_BPS ? Math.min(fromAudio, MAX_BPS) : metadataBytesPerSec(audioBytes, track.duration);
        if (refined !== null) bps = refined;
      });
      return {
        bytes,
        get bytesPerSec() {
          return bps;
        },
        cancel,
      };
    }
    if (!this.transcoder) throw new Error(`Track ${track.id} is ${track.mimeType ?? 'unknown'} and no transcoder (ffmpeg) is configured`);
    return { bytes: this.transcoder.toMp3(raw, this.defaultBitrateKbps, signal), bytesPerSec: (this.defaultBitrateKbps * 1000) / 8, cancel };
  }
}
