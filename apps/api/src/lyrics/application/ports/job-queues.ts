export const QUEUES = {
  TELEGRAM_SYNC: 'telegram-sync',
  LYRICS_FETCH: 'lyrics-fetch',
  AUDIO_TRANSCRIPTION: 'audio-transcription',
  LYRICS_ALIGNMENT: 'lyrics-alignment',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface LyricsJobPayload {
  trackId: string;
  /** Set for lyrics-alignment jobs. */
  transcriptId?: string;
  /** Bypass caches (admin "reprocess"). */
  force?: boolean;
}

export interface SyncJobPayload {
  /** Telegram channel id; omitted = every channel. */
  channelId?: string;
  full?: boolean;
}

/** Port used by domain code to schedule work; BullMQ in production, inline in tests. */
export interface JobQueue {
  enqueueLyricsFetch(payload: LyricsJobPayload): Promise<void>;
  enqueueTranscription(payload: LyricsJobPayload): Promise<void>;
  enqueueAlignment(payload: LyricsJobPayload & { transcriptId: string }): Promise<void>;
  enqueueTelegramSync(payload: SyncJobPayload): Promise<void>;
}

export const JOB_QUEUE = Symbol('JOB_QUEUE');

export interface AttemptContext {
  /** True when a failure now will not be retried. */
  isLastAttempt: boolean;
}
