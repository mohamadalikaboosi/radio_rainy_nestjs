import { Controller, Get, Header, Headers, Inject, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { computePosition } from '../radio/playback-position';
import { StationManager } from '../playback/station-manager';
import { RadioMetrics, StationSnapshot } from './radio-metrics';

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Prometheus scrape endpoint. Disabled (404) unless METRICS_TOKEN is set; then it needs `Authorization: Bearer <token>`.
 * The numbers live in the process that runs the stations (the leader); point Prometheus at the instance that broadcasts.
 */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig, private readonly metrics: RadioMetrics, private readonly stations: StationManager) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  scrape(@Headers('authorization') authorization?: string): string {
    const token = this.cfg.METRICS_TOKEN;
    if (!token) throw new NotFoundException();
    const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '';
    if (!same(given, token)) throw new UnauthorizedException();
    const now = Date.now();
    const snapshots: StationSnapshot[] = this.stations.active.map((s) => {
      const st = s.engine.getState();
      const cur = s.engine.current;
      return { channelId: s.channel.id, slug: s.channel.slug, trackId: st.trackId, title: cur?.track.title ?? null, position: cur ? computePosition(cur.startedAt, now, cur.track.duration) : null, listeners: s.broadcaster.listenerCount };
    });
    return this.metrics.render(snapshots);
  }
}
