import { Injectable, Logger } from '@nestjs/common';
import { LyricsError } from './lyrics.errors';
import { LyricsRepository } from './lyrics.repository';
import { LyricsSource } from './lyrics-source';
import { detectLanguage } from '../language/language-detect';
import { TrackRepository } from '../track/track.repository';

export type FetchOutcome =
  | { kind: 'FETCHED'; rawText: string; cached: boolean }
  | { kind: 'NO_URL' }
  | { kind: 'FAILED'; reason: string };

/** Fetches Telegraph lyrics with caching; never throws for data problems, only for retryable (network) errors. */
@Injectable()
export class LyricsService {
  private readonly logger = new Logger(LyricsService.name);

  constructor(
    private readonly source: LyricsSource,
    private readonly lyrics: LyricsRepository,
    private readonly tracks: TrackRepository,
    private readonly cacheTtlSeconds: number,
  ) {}

  async fetchForTrack(trackId: string, opts: { force?: boolean } = {}): Promise<FetchOutcome> {
    const track = await this.tracks.findById(trackId);
    if (!track || !track.lyricsUrl) return { kind: 'NO_URL' };
    const url = track.lyricsUrl;

    if (!opts.force) {
      const own = await this.lyrics.getLyrics(trackId);
      if (own && own.status === 'FETCHED' && own.sourceUrl === url && own.rawText && own.expiresAt && own.expiresAt > new Date()) {
        this.logger.log({ msg: 'lyrics cache hit', trackId, scope: 'track' });
        await this.tracks.setLyricsLanguage(trackId, detectLanguage(own.rawText));
        return { kind: 'FETCHED', rawText: own.rawText, cached: true };
      }
      const shared = await this.lyrics.findFreshRawByUrl(url);
      if (shared) {
        await this.lyrics.saveFetched(trackId, url, shared, this.cacheTtlSeconds);
        this.logger.log({ msg: 'lyrics cache hit', trackId, scope: 'url' });
        await this.tracks.setLyricsLanguage(trackId, detectLanguage(shared));
        return { kind: 'FETCHED', rawText: shared, cached: true };
      }
    }

    try {
      const started = Date.now();
      const text = await this.source.fetch(url);
      await this.lyrics.saveFetched(trackId, url, text, this.cacheTtlSeconds);
      await this.tracks.setLyricsLanguage(trackId, detectLanguage(text));
      this.logger.log({ msg: 'telegraph fetched', trackId, chars: text.length, ms: Date.now() - started });
      return { kind: 'FETCHED', rawText: text, cached: false };
    } catch (err) {
      if (err instanceof LyricsError && !err.retryable) {
        await this.lyrics.saveFetchFailure(trackId, url, `${err.code}: ${err.message}`);
        this.logger.warn({ msg: 'telegraph fetch failed', trackId, code: err.code });
        return { kind: 'FAILED', reason: err.code };
      }
      this.logger.warn({ msg: 'telegraph fetch error (retryable)', trackId, err: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
}
