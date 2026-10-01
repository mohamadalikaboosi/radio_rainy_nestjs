export interface LyricsSource {
  /** Returns clean plain-text lyrics (lines separated by "\n"). Throws LyricsError. */
  fetch(url: string, signal?: AbortSignal): Promise<string>;
}

export const LYRICS_SOURCE = Symbol('LYRICS_SOURCE');
