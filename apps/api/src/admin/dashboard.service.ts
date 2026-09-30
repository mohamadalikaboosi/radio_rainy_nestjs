import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { PlaybackHistoryRepository } from '../playback/playback-history.repository';
import { computePosition } from '../radio/playback-position';
import { RadioConfigRepository } from '../radio/radio-config.repository';
import { RadioStateRepository } from '../radio/radio-state.repository';
import { Broadcaster } from '../streaming/broadcaster';
import { TelegramClientManager } from '../telegram/telegram-client.manager';
import { TrackRepository } from '../track/track.repository';

const COUNTS_TTL_MS = 5000;

@Injectable()
export class DashboardService {
  private counts: { at: number; value: Promise<Record<string, number>> } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly state: RadioStateRepository,
    private readonly config: RadioConfigRepository,
    private readonly tracks: TrackRepository,
    private readonly history: PlaybackHistoryRepository,
    private readonly broadcaster: Broadcaster,
    private readonly telegram: TelegramClientManager,
  ) {}

  private loadCounts(): Promise<Record<string, number>> {
    const now = Date.now();
    if (!this.counts || now - this.counts.at > COUNTS_TTL_MS) {
      this.counts = {
        at: now,
        value: this.db
          .query<Record<string, number>>(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE status = 'READY' AND enabled AND deleted_at IS NULL)::int AS playable,
                    count(*) FILTER (WHERE lyrics_status = 'LYRICS_READY')::int AS with_lyrics,
                    count(*) FILTER (WHERE lyrics_status IN ('LYRICS_PENDING', 'LYRICS_PROCESSING'))::int AS lyrics_waiting,
                    count(*) FILTER (WHERE status = 'FAILED')::int AS failed_tracks,
                    count(*) FILTER (WHERE lyrics_status = 'LYRICS_FAILED')::int AS failed_lyrics,
                    count(*) FILTER (WHERE NOT enabled)::int AS disabled,
                    (SELECT count(*)::int FROM hashtags) AS hashtags
               FROM tracks`,
          )
          .then((r) => r.rows[0] ?? {}),
      };
    }
    return this.counts.value;
  }

  async get(): Promise<unknown> {
    const [st, cfg, counts, recent] = await Promise.all([this.state.get(), this.config.getSnapshot(), this.loadCounts(), this.history.list(10)]);
    const current = st.currentTrackId ? await this.tracks.findById(st.currentTrackId) : null;
    const next = st.nextTrackId ? await this.tracks.findById(st.nextTrackId) : null;
    return {
      radio: {
        status: st.status,
        statusReason: st.statusReason,
        transitionSeq: st.transitionSeq,
        configurationVersion: st.configurationVersion,
        listeners: this.broadcaster.listenerCount,
        current: current && st.startedAt && st.status === 'PLAYING'
          ? { trackId: current.id, title: current.title, artist: current.artist, duration: current.duration, startedAt: st.startedAt, position: Math.round(computePosition(st.startedAt, Date.now(), current.duration)) }
          : null,
        next: next ? { trackId: next.id, title: next.title, artist: next.artist } : null,
        selection: { mode: cfg.snapshot.mode, matchMode: cfg.snapshot.hashtagMatchMode, activeHashtags: cfg.snapshot.hashtags.map((h) => h.hashtag), recentTrackWindow: cfg.snapshot.recentTrackWindow, enabled: cfg.enabled },
      },
      counts: {
        totalTracks: counts.total ?? 0,
        playableTracks: counts.playable ?? 0,
        tracksWithLyrics: counts.with_lyrics ?? 0,
        tracksWaitingForLyrics: counts.lyrics_waiting ?? 0,
        failedTracks: counts.failed_tracks ?? 0,
        failedLyrics: counts.failed_lyrics ?? 0,
        disabledTracks: counts.disabled ?? 0,
        hashtags: counts.hashtags ?? 0,
      },
      recentlyPlayed: recent,
      telegram: this.telegram.getStatus(),
    };
  }
}
