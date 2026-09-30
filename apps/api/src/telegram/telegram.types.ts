export interface TelegramChannelInfo {
  id: string;
  title: string;
  username?: string;
}

export interface TelegramAudioMessage {
  channelId: string;
  messageId: number;
  date: Date;
  caption: string;
  /** Hidden links from text-url entities. */
  entityUrls: string[];
  postUrl?: string;
  audio: {
    mimeType: string;
    size: number;
    duration?: number;
    title?: string;
    performer?: string;
    fileName?: string;
    /** Serialized document reference (id/accessHash/fileReference/dc). Refreshed on every sync. */
    fileReference: string;
  };
}

export interface FetchAudioOptions {
  /** Only messages with id > minId (incremental sync). */
  minId?: number;
  limit?: number;
}

/**
 * Everything the app needs from Telegram, behind an interface so discovery/streaming are testable
 * without a network. The real implementation uses MTProto (GramJS), never the Bot API.
 */
export interface TelegramGateway {
  resolveChannel(): Promise<TelegramChannelInfo>;
  /** Audio messages, newest first. */
  fetchAudioMessages(opts?: FetchAudioOptions): AsyncIterable<TelegramAudioMessage>;
  getAudioMessage(messageId: number): Promise<TelegramAudioMessage | null>;
  /** Returns the subset of `messageIds` that still exist as audio messages. */
  existingAudioMessageIds(messageIds: readonly number[]): Promise<Set<number>>;
  /** Streams the file in chunks from `offset`. Aborts promptly when `signal` fires. */
  download(messageId: number, opts?: { offset?: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>;
}

export const TELEGRAM_GATEWAY = Symbol('TELEGRAM_GATEWAY');

export class TelegramNotReadyError extends Error {
  constructor(message = 'Telegram client is not logged in / connected') {
    super(message);
    this.name = 'TelegramNotReadyError';
  }
}

export class TelegramFloodWaitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Telegram flood wait: retry after ${retryAfterSeconds}s`);
    this.name = 'TelegramFloodWaitError';
  }
}

export class TelegramMediaError extends Error {
  constructor(message: string, public readonly retryable = true) {
    super(message);
    this.name = 'TelegramMediaError';
  }
}
