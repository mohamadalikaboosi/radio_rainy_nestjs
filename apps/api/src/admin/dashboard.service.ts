import { Injectable, NotFoundException } from '@nestjs/common';
import { ChannelRepository } from '../channels/channel.repository';
import { DatabaseService } from '../database/database.service';
import { PlaybackHistoryRepository } from '../playback/playback-history.repository';
import { StationManager } from '../playback/station-manager';
import { computePosition } from '../radio/playback-position';
import { RadioConfigRepository } from '../radio/radio-config.repository';
import { RadioStateRepository } from '../radio/radio-state.repository';
import { TelegramClientManager } from '../telegram/telegram-client.manager';
import { TrackRepository } from '../track/track.repository';

const COUNTS_TTL_MS = 5000;
type Counts = Record<string, number>;

@Injectable()
export class DashboardService {
  private readonly counts = new Map<string, { at: number; value: Promise<Counts> }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly state: RadioStateRepository,
    private readonly config: RadioConfigRepository,
    private readonly tracks: TrackRepository,
    private readonly history: PlaybackHistoryRepository,
    private readonly stations: StationManager,
    private readonly channels: ChannelRepository,
    private readonly telegram: TelegramClientManager,
  ) {}

  private loadCounts(channelId: string | null): Promise<Counts> {
    const key = channelId ?? '*';
    const now = Date.now();
    const hit = this.counts.get(key);
    if (hit && now - hit.at <= COUNTS_TTL_MS) return hit.value;
    const value = this.db
      .query<Counts>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'READY' AND enabled AND deleted_at IS NULL)::int AS playable,
                count(*) FILTER (WHERE lyrics_status = 'LYRICS_READY')::int AS with_lyrics,
                count(*) FILTER (WHERE lyrics_status IN ('LYRICS_PENDING', 'LYRICS_PROCESSING'))::int AS lyrics_waiting,
                count(*) FILTER (WHERE status = 'FAILED')::int AS failed_tracks,
                count(*) FILTER (WHERE lyrics_status = 'LYRICS_FAILED')::int AS failed_lyrics,
                count(*) FILTER (WHERE NOT enabled)::int AS disabled,
                (SELECT count(*)::int FROM hashtags) AS hashtags
           FROM tracks WHERE ($1::bigint IS NULL OR telegram_channel_id = $1)`,
        [channelId],
      )
      .then((r) => r.rows[0] ?? {});
    this.counts.set(key, { at: now, value });
    return value;
  }

  private shape(c: Counts): Record<string, number> {
    return {
      totalTracks: c.total ?? 0,
      playableTracks: c.playable ?? 0,
      tracksWithLyrics: c.with_lyrics ?? 0,
      tracksWaitingForLyrics: c.lyrics_waiting ?? 0,
      failedTracks: c.failed_tracks ?? 0,
      failedLyrics: c.failed_lyrics ?? 0,
      disabledTracks: c.disabled ?? 0,
      hashtags: c.hashtags ?? 0,
    };
  }

  /** All stations at a glance + global counts. */
  async overview(): Promise<unknown> {
    const [rows, counts] = await Promise.all([this.channels.list(), this.loadCounts(null)]);
    const stations = await Promise.all(
      rows.map(async (c) => {
        const st = await this.state.get(c.id);
        const cur = st.currentTrackId && st.status === 'PLAYING' ? await this.tracks.findById(st.currentTrackId) : null;
        return {
          id: c.id,
          slug: c.slug,
          title: c.title,
          started: c.started,
          running: this.stations.get(c.id) !== undefined,
          status: st.status,
          statusReason: st.statusReason,
          listeners: this.stations.get(c.id)?.broadcaster.listenerCount ?? 0,
          liveOnTelegram: { enabled: c.telegramLiveEnabled, status: c.liveStatus, error: c.liveError },
          current: cur ? { title: cur.title, artist: cur.artist } : null,
        };
      }),
    );
    return { stations, counts: this.shape(counts), telegram: this.telegram.getStatus() };
  }

  async channel(channelId: string): Promise<unknown> {
    const ch = await this.channels.get(channelId);
    if (!ch) throw new NotFoundException('Channel not found');
    const [st, cfg, counts, recent] = await Promise.all([this.state.get(channelId), this.config.getSnapshot(channelId), this.loadCounts(channelId), this.history.list(channelId, 10)]);
    const current = st.currentTrackId ? await this.tracks.findById(st.currentTrackId) : null;
    const next = st.nextTrackId ? await this.tracks.findById(st.nextTrackId) : null;
    return {
      channel: { id: ch.id, slug: ch.slug, title: ch.title, started: ch.started, liveOnTelegram: { enabled: ch.telegramLiveEnabled, status: ch.liveStatus, error: ch.liveError } },
      radio: {
        status: st.status,
        statusReason: st.statusReason,
        transitionSeq: st.transitionSeq,
        configurationVersion: st.configurationVersion,
        listeners: this.stations.get(channelId)?.broadcaster.listenerCount ?? 0,
        current: current && st.startedAt && st.status === 'PLAYING'
          ? { trackId: current.id, title: current.title, artist: current.artist, duration: current.duration, startedAt: st.startedAt, position: Math.round(computePosition(st.startedAt, Date.now(), current.duration)) }
          : null,
        next: next ? { trackId: next.id, title: next.title, artist: next.artist } : null,
        selection: { mode: cfg.snapshot.mode, matchMode: cfg.snapshot.hashtagMatchMode, activeHashtags: cfg.snapshot.hashtags.map((h) => h.hashtag), recentTrackWindow: cfg.snapshot.recentTrackWindow, enabled: cfg.enabled },
      },
      counts: this.shape(counts),
      recentlyPlayed: recent,
      telegram: this.telegram.getStatus(),
    };
  }
}
