import { Injectable } from '@nestjs/common';
import { AlignedLine } from '../alignment/lyrics-aligner';
import { parseLyricLines } from '../alignment/normalize';
import { LyricsRepository } from '../lyrics/lyrics.repository';
import { TrackRepository } from '../track/track.repository';
import { Track } from '../track/track.types';
import { computePosition, findActiveLine, ActiveLine } from './playback-position';
import { RadioStateRepository, RadioStateRow } from './radio-state.repository';
import { RadioStatus } from './radio.types';

export interface AdView {
  id: string;
  name: string;
  startedAt: string | null;
  duration: number | null;
  linkUrl: string | null;
  ctaLabel: string | null;
  imageUrl: string | null;
}

export interface CurrentView {
  /** 'AD' while an audio ad is on air (then `ad` is set and the track fields are omitted). */
  status: RadioStatus | 'AD';
  ad?: AdView;
  trackId?: string;
  title?: string;
  artist?: string | null;
  album?: string | null;
  startedAt?: string;
  duration?: number | null;
  position?: number;
  serverTime: string;
}

export type PublicLyricsStatus = 'READY' | 'PENDING' | 'PROCESSING' | 'FAILED' | 'NONE' | 'PLAIN';

export interface LyricsView {
  trackId: string;
  status: PublicLyricsStatus;
  lines?: AlignedLine[];
  /** Unsynchronized lyrics when synchronization is unavailable. */
  plain?: string[];
}

interface Snapshot {
  at: number;
  state: RadioStateRow;
  track: Track | null;
}

const STATE_TTL_MS = 500;
const LYRICS_CACHE_MAX = 64;

/** Read model behind the public radio API: cached briefly so thousands of pollers don't hammer the DB. */
@Injectable()
export class CurrentRadioService {
  private readonly snapshots = new Map<string, { at: number; value: Promise<Snapshot> }>();
  private readonly lyricsCache = new Map<string, { at: number; view: LyricsView }>();

  constructor(
    private readonly state: RadioStateRepository,
    private readonly tracks: TrackRepository,
    private readonly lyrics: LyricsRepository,
    private readonly now: () => number = () => Date.now(),
    private readonly ads?: { onAir(id: string): Promise<{ id: string; name: string; linkUrl: string | null; ctaLabel: string | null; hasImage: boolean; durationSeconds: number | null } | null> },
  ) {}

  private load(channelId: string): Promise<Snapshot> {
    const t = this.now();
    const hit = this.snapshots.get(channelId);
    if (hit && t - hit.at <= STATE_TTL_MS) return hit.value;
    const value = (async () => {
      const state = await this.state.get(channelId);
      const track = state.status === 'PLAYING' && state.currentTrackId ? await this.tracks.findById(state.currentTrackId) : null;
      return { at: t, state, track };
    })();
    this.snapshots.set(channelId, { at: t, value });
    value.catch(() => this.snapshots.delete(channelId));
    return value;
  }

  async current(channelId: string): Promise<CurrentView> {
    const { state, track } = await this.load(channelId);
    const serverTime = new Date(this.now()).toISOString();
    if (state.adId && this.ads) {
      const ad = await this.ads.onAir(state.adId).catch(() => null);
      if (ad) {
        return {
          status: 'AD',
          ad: { id: ad.id, name: ad.name, startedAt: state.adStartedAt?.toISOString() ?? null, duration: ad.durationSeconds, linkUrl: ad.linkUrl ? `/radio/go/ad/${ad.id}` : null, ctaLabel: ad.ctaLabel, imageUrl: ad.hasImage ? `/radio/ads/${ad.id}/image` : null },
          serverTime,
        };
      }
    }
    if (state.status !== 'PLAYING' || !track || !state.startedAt) return { status: state.status, serverTime };
    return {
      status: 'PLAYING',
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      startedAt: state.startedAt.toISOString(),
      duration: track.duration,
      position: round1(computePosition(state.startedAt, this.now(), track.duration)),
      serverTime,
    };
  }

  async currentLyrics(channelId: string): Promise<LyricsView | null> {
    const { state, track } = await this.load(channelId);
    if (state.adId || state.status !== 'PLAYING' || !track) return null;
    return this.lyricsFor(track);
  }

  async activeLine(channelId: string): Promise<{ status: PublicLyricsStatus; trackId: string; position: number; active: ActiveLine | null } | null> {
    const { state, track } = await this.load(channelId);
    if (state.adId || state.status !== 'PLAYING' || !track || !state.startedAt) return null;
    const view = await this.lyricsFor(track);
    const position = round1(computePosition(state.startedAt, this.now(), track.duration));
    return { status: view.status, trackId: track.id, position, active: view.lines ? findActiveLine(view.lines, position) : null };
  }

  private async lyricsFor(track: Track): Promise<LyricsView> {
    const key = `${track.id}:${track.lyricsStatus}`;
    const hit = this.lyricsCache.get(key);
    if (hit && this.now() - hit.at < 5_000) return hit.view;

    let view: LyricsView;
    switch (track.lyricsStatus) {
      case 'LYRICS_READY': {
        const synced = await this.lyrics.getLatestSynced(track.id);
        view = synced ? { trackId: track.id, status: 'READY', lines: synced.lines } : { trackId: track.id, status: 'PENDING' };
        break;
      }
      case 'LYRICS_PENDING':
        view = { trackId: track.id, status: 'PENDING' };
        break;
      case 'LYRICS_PROCESSING':
        view = { trackId: track.id, status: 'PROCESSING' };
        break;
      case 'LYRICS_FAILED':
        view = { trackId: track.id, status: 'FAILED' };
        break;
      case 'LYRICS_NONE': {
        const raw = await this.lyrics.getLyrics(track.id);
        view = raw?.rawText
          ? { trackId: track.id, status: 'PLAIN', plain: parseLyricLines(raw.rawText).map((l) => l.text) }
          : { trackId: track.id, status: 'NONE' };
        break;
      }
    }
    if (this.lyricsCache.size >= LYRICS_CACHE_MAX) this.lyricsCache.delete(this.lyricsCache.keys().next().value as string);
    this.lyricsCache.set(key, { at: this.now(), view });
    return view;
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
