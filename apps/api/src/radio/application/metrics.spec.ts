import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AppConfig } from '../../shared/infrastructure/config/app-config';
import { StationManager } from './station-manager';
import { MetricsController } from '../interface/metrics.controller';
import { RadioMetrics } from './radio-metrics';

describe('RadioMetrics', () => {
  it('renders Prometheus text with every required series, labelled per station', () => {
    const m = new RadioMetrics();
    const s = m.forStation('1');
    s.recordBuffer(1.8);
    s.recordDownload(200_000, 100);
    s.recordUnderrun();
    s.recordTransition(40, false);
    s.recordTransition(2500, true);
    s.recordTransitionFailure();
    s.recordDownloadFailure();
    m.cache.hits = 7;
    m.cache.misses = 2;
    const text = m.render([{ channelId: '1', slug: 'chan"x', trackId: 't1', title: 'A "quoted" song', position: 82.4, listeners: 3 }]);
    for (const name of ['radio_current_track', 'radio_playback_position', 'radio_listener_count', 'radio_buffer_seconds', 'radio_download_speed', 'radio_track_transition_duration', 'radio_track_transition_failures', 'radio_buffer_underruns', 'radio_telegram_download_failures', 'radio_cache_hits', 'radio_cache_misses']) {
      expect(text).toContain(`# TYPE ${name} `);
    }
    expect(text).toContain('radio_playback_position{station="chan\\"x"} 82.4');
    expect(text).toContain('radio_listener_count{station="chan\\"x"} 3');
    expect(text).toContain('radio_buffer_underruns{station="chan\\"x"} 1');
    expect(text).toContain('radio_audible_gaps_total{station="chan\\"x"} 1');
    expect(text).toContain('radio_track_transition_duration{station="chan\\"x",stat="max"} 2.5');
    expect(text).toContain('radio_cache_hits 7');
    expect(text).toContain('title="A \\"quoted\\" song"');
    expect(s.downloadBytesPerSec).toBe(2_000_000);
  });
});

describe('MetricsController', () => {
  const stations = { active: [] } as unknown as StationManager;
  const make = (token?: string): MetricsController => new MetricsController({ METRICS_TOKEN: token } as AppConfig, new RadioMetrics(), stations);

  it('is disabled (404) without METRICS_TOKEN', () => {
    expect(() => make().scrape('Bearer whatever')).toThrow(NotFoundException);
  });

  it('requires the exact bearer token', () => {
    const c = make('a-long-enough-token-1');
    expect(() => c.scrape(undefined)).toThrow(UnauthorizedException);
    expect(() => c.scrape('Bearer wrong-token-of-same-len')).toThrow(UnauthorizedException);
    expect(() => c.scrape('a-long-enough-token-1')).toThrow(UnauthorizedException);
    expect(c.scrape('Bearer a-long-enough-token-1')).toContain('# TYPE radio_cache_hits counter');
  });
});
