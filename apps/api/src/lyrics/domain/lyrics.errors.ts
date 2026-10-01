export type LyricsErrorCode = 'INVALID_URL' | 'NOT_FOUND' | 'NETWORK' | 'EMPTY' | 'PARSE';

export class LyricsError extends Error {
  constructor(
    public readonly code: LyricsErrorCode,
    message: string,
    /** Network errors are worth retrying; the rest are data problems. */
    public readonly retryable: boolean = code === 'NETWORK',
  ) {
    super(message);
    this.name = 'LyricsError';
  }
}
