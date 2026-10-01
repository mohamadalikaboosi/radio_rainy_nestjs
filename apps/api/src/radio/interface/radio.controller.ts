import { Controller, Get, Header, Inject, Logger, NotFoundException, Optional, Param, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ChannelRepository, ChannelRow } from '../../catalog/application/ports/channel.repository';
import { listenersOf, StationManager } from '../application/station-manager';
import { EngagementSettingsRepository } from '../../engagement/application/ports/engagement-settings.repository';
import { CurrentRadioService } from '../application/current-radio.service';
import { HttpListenerSink } from '../application/http-listener-sink';

export const STREAM_OPTIONS = Symbol('STREAM_OPTIONS');
export interface StreamOptions {
  /** Max bytes queued per listener before it is disconnected as too slow. */
  maxBacklogBytes: number;
  stationName: string;
}

/**
 * Public, unauthenticated radio endpoints. One radio per channel: `/radio/:slug/...`.
 * The unprefixed `/radio/stream|current|...` URLs serve the default station (first started channel).
 * Exposes nothing about Telegram or internals.
 */
@Controller('radio')
export class RadioController {
  private readonly logger = new Logger(RadioController.name);

  constructor(
    private readonly stations: StationManager,
    private readonly channels: ChannelRepository,
    private readonly current: CurrentRadioService,
    @Inject(STREAM_OPTIONS) private readonly opts: StreamOptions,
    @Optional() private readonly engagement?: EngagementSettingsRepository,
  ) {}

  private async resolve(slug?: string): Promise<ChannelRow | null> {
    return slug ? this.channels.bySlug(slug) : this.channels.defaultChannel();
  }

  private async require(slug?: string): Promise<ChannelRow> {
    const c = await this.resolve(slug);
    if (!c) throw new NotFoundException('Unknown station');
    return c;
  }

  @Get('stations')
  @Header('Cache-Control', 'no-store')
  async list(): Promise<{ slug: string; title: string; live: boolean; transport: 'HTTP' | 'WEBSOCKET'; lowQuality: boolean }[]> {
    const transports = (await this.engagement?.transports()) ?? new Map<string, 'HTTP' | 'WEBSOCKET'>();
    return (await this.channels.list()).filter((c) => c.started).map((c) => ({ slug: c.slug, title: c.title, live: this.stations.get(c.id) !== undefined, transport: transports.get(c.id) ?? 'HTTP', lowQuality: this.stations.get(c.id)?.low?.available ?? false }));
  }

  // ---- default station (backwards compatible URLs) ----
  @Get('stream')
  streamDefault(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.stream(undefined, req, res);
  }
  @Get('current')
  @Header('Cache-Control', 'no-store')
  currentDefault(): Promise<unknown> {
    return this.currentTrack(undefined);
  }
  @Get('current/lyrics')
  @Header('Cache-Control', 'no-store')
  lyricsDefault(): Promise<unknown> {
    return this.lyricsOf(undefined);
  }
  @Get('current/lyrics/active')
  @Header('Cache-Control', 'no-store')
  activeDefault(): Promise<unknown> {
    return this.activeOf(undefined);
  }

  // ---- per-station ----
  @Get(':slug/stream')
  async stream(@Param('slug') slug: string | undefined, @Req() req: Request, @Res() res: Response): Promise<void> {
    const channel = await this.require(slug);
    const station = this.stations.get(channel.id);
    if (!station || !station.engine.running) throw new ServiceUnavailableException('This station is not broadcasting on this instance');
    res.status(200);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store, no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx) => lower latency
    res.setHeader('icy-name', channel.title || this.opts.stationName);
    if (req.query.quality === 'low' && station.low?.available) res.setHeader('X-Audio-Quality', 'low');
    res.socket?.setNoDelay(true);
    res.socket?.setTimeout(0);
    res.flushHeaders();

    const sink = new HttpListenerSink(res, this.opts.maxBacklogBytes, (reason) => this.logger.warn({ msg: 'listener dropped', reason, channel: channel.slug, ip: req.ip }));
    // ?quality=low = the shared data-saver stream; if it cannot run (no ffmpeg) the normal stream is served instead.
    const low = req.query.quality === 'low' && station.low?.available ? station.low : null;
    const unsubscribe = low ? low.subscribe(sink) : station.broadcaster.subscribe(sink);
    this.logger.log({ msg: 'listener connected', channel: channel.slug, quality: low ? 'low' : 'high', listeners: listenersOf(station) });
    // Every way a connection can end frees the subscription (no leaks).
    const cleanup = (): void => {
      unsubscribe();
      this.logger.log({ msg: 'listener disconnected', channel: channel.slug, listeners: listenersOf(station) });
    };
    res.once('close', cleanup);
    res.once('error', cleanup);
  }

  @Get(':slug/current')
  @Header('Cache-Control', 'no-store')
  async currentTrack(@Param('slug') slug: string | undefined): Promise<unknown> {
    const c = await this.resolve(slug);
    if (!c) return slug ? this.notFound() : { status: 'STOPPED', serverTime: new Date().toISOString() };
    return this.current.current(c.id);
  }

  @Get(':slug/current/lyrics')
  @Header('Cache-Control', 'no-store')
  async lyricsOf(@Param('slug') slug: string | undefined): Promise<unknown> {
    const c = await this.resolve(slug);
    if (!c) return slug ? this.notFound() : { status: 'NONE' };
    return (await this.current.currentLyrics(c.id)) ?? { status: 'NONE' };
  }

  @Get(':slug/current/lyrics/active')
  @Header('Cache-Control', 'no-store')
  async activeOf(@Param('slug') slug: string | undefined): Promise<unknown> {
    const c = await this.resolve(slug);
    if (!c) return slug ? this.notFound() : { index: -1, start: null, end: null, text: null, status: 'NONE' };
    const r = await this.current.activeLine(c.id);
    if (!r) return { index: -1, start: null, end: null, text: null, status: 'NONE' };
    if (!r.active) return { index: -1, start: null, end: null, text: null, status: r.status, position: r.position, trackId: r.trackId };
    return { ...r.active, status: r.status, position: r.position, trackId: r.trackId };
  }

  private notFound(): never {
    throw new NotFoundException('Unknown station');
  }
}
