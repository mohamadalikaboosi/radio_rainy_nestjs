import { listenersOf } from '../playback/station-manager';
import { Injectable } from '@nestjs/common';
import { ChannelRepository } from '../channels/channel.repository';
import { PlaybackHistoryRepository } from '../playback/playback-history.repository';
import { StationManager } from '../playback/station-manager';
import { computePosition } from '../radio/playback-position';
import { CurrentRadioService } from '../radio/current-radio.service';
import { RadioStateRepository } from '../radio/radio-state.repository';
import { TrackRepository } from '../track/track.repository';

interface TrackBrief {
  trackId: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  hashtags?: string[];
}

/** What is on air right now, per station: the data behind the "Live control" page (polled every second). */
@Injectable()
export class LiveService {
  constructor(
    private readonly channels: ChannelRepository,
    private readonly state: RadioStateRepository,
    private readonly tracks: TrackRepository,
    private readonly history: PlaybackHistoryRepository,
    private readonly stations: StationManager,
    private readonly current: CurrentRadioService,
  ) {}

  async snapshot(): Promise<{ serverTime: string; stations: unknown[] }> {
    const rows = await this.channels.list();
    const stations = await Promise.all(
      rows.map(async (c) => {
        const st = await this.state.get(c.id);
        const station = this.stations.get(c.id);
        const [cur, next, recent, active] = await Promise.all([
          st.currentTrackId && st.status === 'PLAYING' ? this.tracks.findById(st.currentTrackId) : Promise.resolve(null),
          st.nextTrackId ? this.tracks.findById(st.nextTrackId) : Promise.resolve(null),
          this.history.list(c.id, 6),
          st.status === 'PLAYING' ? this.current.activeLine(c.id).catch(() => null) : Promise.resolve(null),
        ]);
        const brief = (t: NonNullable<typeof cur>): TrackBrief => ({ trackId: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration });
        return {
          id: c.id,
          slug: c.slug,
          title: c.title,
          started: c.started,
          running: station !== undefined,
          status: st.status,
          statusReason: st.statusReason,
          transitionSeq: st.transitionSeq,
          listeners: listenersOf(station),
          liveOnTelegram: { enabled: c.telegramLiveEnabled, status: c.liveStatus, error: c.liveError },
          streamUrl: `/radio/${c.slug}/stream`,
          nowPlaying: cur && st.startedAt ? { ...brief(cur), startedAt: st.startedAt.toISOString(), position: Math.round(computePosition(st.startedAt, Date.now(), cur.duration)), lyricsStatus: cur.lyricsStatus, activeLine: active?.active?.text ?? null } : null,
          upNext: next ? { ...brief(next), queued: true } : null,
          recent: recent.slice(0, 5).map((r) => ({ trackId: r.trackId, title: r.title, artist: r.artist, startedAt: r.startedAt.toISOString(), endReason: r.endReason })),
        };
      }),
    );
    return { serverTime: new Date().toISOString(), stations };
  }
}
