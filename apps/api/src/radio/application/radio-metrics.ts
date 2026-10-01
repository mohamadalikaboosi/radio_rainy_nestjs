/**
 * In-process radio metrics (the leader process owns the engines, so that is where they live).
 * They exist to answer "why did the radio have a 2-second gap?": every transition records how long it took and whether the
 * listeners' buffer covered it (`audible`); underruns, Telegram failures and cache behaviour are counted separately.
 */
export class StationMetrics {
  /** Seconds of audio already sent beyond real time = how much the listeners' buffers can absorb right now. */
  bufferSeconds = 0;
  /** Smoothed Telegram/cache read speed in bytes per second. */
  downloadBytesPerSec = 0;
  underruns = 0;
  transitions = 0;
  audibleGaps = 0;
  transitionFailures = 0;
  telegramDownloadFailures = 0;
  prefetchFailovers = 0;
  transitionMsTotal = 0;
  lastTransitionMs = 0;
  maxTransitionMs = 0;

  recordBuffer(seconds: number): void {
    this.bufferSeconds = seconds;
  }

  recordDownload(bytes: number, ms: number): void {
    if (ms <= 0 || bytes <= 0) return;
    const bps = (bytes * 1000) / ms;
    this.downloadBytesPerSec = this.downloadBytesPerSec === 0 ? bps : this.downloadBytesPerSec * 0.7 + bps * 0.3;
  }

  recordUnderrun(): void {
    this.underruns++;
  }

  /** `gapMs` = time from the last byte of track A to the first byte of track B; `audible` = it exceeded what the buffers cover. */
  recordTransition(gapMs: number, audible: boolean): void {
    this.transitions++;
    this.transitionMsTotal += gapMs;
    this.lastTransitionMs = gapMs;
    this.maxTransitionMs = Math.max(this.maxTransitionMs, gapMs);
    if (audible) this.audibleGaps++;
  }

  recordTransitionFailure(): void {
    this.transitionFailures++;
  }

  recordDownloadFailure(): void {
    this.telegramDownloadFailures++;
  }

  recordFailover(): void {
    this.prefetchFailovers++;
  }
}

export class CacheMetrics {
  hits = 0;
  misses = 0;
  evictions = 0;
  corrupted = 0;
  fillFailures = 0;
  fillBytes = 0;
  bytesOnDisk = 0;
  filesOnDisk = 0;
}

export interface StationSnapshot {
  channelId: string;
  slug: string;
  trackId: string | null;
  title: string | null;
  position: number | null;
  listeners: number;
}

const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export class RadioMetrics {
  private readonly stations = new Map<string, StationMetrics>();
  readonly cache = new CacheMetrics();

  forStation(channelId: string): StationMetrics {
    let m = this.stations.get(channelId);
    if (!m) {
      m = new StationMetrics();
      this.stations.set(channelId, m);
    }
    return m;
  }

  /** Prometheus text exposition. Gauges that live elsewhere (listeners, position, current track) come from `snapshots`. */
  render(snapshots: readonly StationSnapshot[]): string {
    const out: string[] = [];
    const metric = (name: string, type: 'gauge' | 'counter', help: string, rows: [string, number][]): void => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, v] of rows) out.push(`${name}${labels} ${Number.isFinite(v) ? v : 0}`);
    };
    const lab = (s: StationSnapshot, extra = ''): string => `{station="${esc(s.slug)}"${extra}}`;
    const per = (get: (m: StationMetrics) => number): [string, number][] => snapshots.map((s) => [lab(s), get(this.forStation(s.channelId))]);

    metric('radio_current_track', 'gauge', 'Track on air (value 1; labels identify it)', snapshots.filter((s) => s.trackId).map((s) => [lab(s, `,track_id="${esc(s.trackId ?? '')}",title="${esc(s.title ?? '')}"`), 1]));
    metric('radio_playback_position', 'gauge', 'Canonical playback position of the current track in seconds', snapshots.map((s) => [lab(s), s.position ?? 0]));
    metric('radio_listener_count', 'gauge', 'Connected listeners', snapshots.map((s) => [lab(s), s.listeners]));
    metric('radio_buffer_seconds', 'gauge', 'Seconds of audio sent ahead of real time (listener buffer health)', per((m) => m.bufferSeconds));
    metric('radio_download_speed', 'gauge', 'Smoothed audio read speed in bytes per second', per((m) => m.downloadBytesPerSec));
    metric('radio_track_transition_duration', 'gauge', 'Gap between the last byte of a track and the first byte of the next one, in seconds (last / max)', [
      ...snapshots.map((s): [string, number] => [lab(s, ',stat="last"'), this.forStation(s.channelId).lastTransitionMs / 1000]),
      ...snapshots.map((s): [string, number] => [lab(s, ',stat="max"'), this.forStation(s.channelId).maxTransitionMs / 1000]),
    ]);
    metric('radio_track_transitions_total', 'counter', 'Track transitions', per((m) => m.transitions));
    metric('radio_audible_gaps_total', 'counter', 'Transitions longer than the buffered lead (a listener could hear a gap)', per((m) => m.audibleGaps));
    metric('radio_track_transition_failures', 'counter', 'Tracks that failed to start', per((m) => m.transitionFailures));
    metric('radio_prefetch_failovers_total', 'counter', 'Pre-fetched next tracks that were replaced by another one', per((m) => m.prefetchFailovers));
    metric('radio_buffer_underruns', 'counter', 'Times the audio source could not keep up with real time', per((m) => m.underruns));
    metric('radio_telegram_download_failures', 'counter', 'Failed Telegram audio downloads', per((m) => m.telegramDownloadFailures));
    metric('radio_cache_hits', 'counter', 'Audio served from the local cache', [['', this.cache.hits]]);
    metric('radio_cache_misses', 'counter', 'Audio that had to be downloaded', [['', this.cache.misses]]);
    metric('radio_cache_evictions', 'counter', 'Cached files removed to stay under the size limit', [['', this.cache.evictions]]);
    metric('radio_cache_corrupted', 'counter', 'Cached files discarded because their size did not match', [['', this.cache.corrupted]]);
    metric('radio_cache_fill_failures', 'counter', 'Cache downloads that failed', [['', this.cache.fillFailures]]);
    metric('radio_cache_bytes', 'gauge', 'Bytes currently in the local cache', [['', this.cache.bytesOnDisk]]);
    return `${out.join('\n')}\n`;
  }
}
