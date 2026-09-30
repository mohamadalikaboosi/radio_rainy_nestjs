import { Controller, Get, Header, Inject, Logger, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PlaybackEngine } from '../playback/playback-engine';
import { CurrentRadioService } from '../radio/current-radio.service';
import { Broadcaster } from './broadcaster';
import { HttpListenerSink } from './http-listener-sink';

export const STREAM_OPTIONS = Symbol('STREAM_OPTIONS');
export interface StreamOptions {
  /** Max bytes queued per listener before it is disconnected as too slow. */
  maxBacklogBytes: number;
  stationName: string;
}

/** Public, unauthenticated radio endpoints. Exposes nothing about Telegram or internals. */
@Controller('radio')
export class RadioController {
  private readonly logger = new Logger(RadioController.name);

  constructor(
    private readonly broadcaster: Broadcaster,
    private readonly engine: PlaybackEngine,
    private readonly current: CurrentRadioService,
    @Inject(STREAM_OPTIONS) private readonly opts: StreamOptions,
  ) {}

  @Get('stream')
  stream(@Req() req: Request, @Res() res: Response): void {
    if (!this.engine.running) throw new ServiceUnavailableException('Radio is not broadcasting on this instance');
    res.status(200);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store, no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx) => lower latency
    res.setHeader('icy-name', this.opts.stationName);
    res.socket?.setNoDelay(true);
    res.socket?.setTimeout(0);
    res.flushHeaders();

    const sink = new HttpListenerSink(res, this.opts.maxBacklogBytes, (reason) =>
      this.logger.warn({ msg: 'listener dropped', reason, ip: req.ip }),
    );
    const unsubscribe = this.broadcaster.subscribe(sink);
    this.logger.log({ msg: 'listener connected', listeners: this.broadcaster.listenerCount });
    // Every way a connection can end frees the subscription (no leaks).
    const cleanup = (): void => {
      unsubscribe();
      this.logger.log({ msg: 'listener disconnected', listeners: this.broadcaster.listenerCount });
    };
    res.once('close', cleanup);
    res.once('error', cleanup);
  }

  @Get('current')
  @Header('Cache-Control', 'no-store')
  currentTrack(): Promise<unknown> {
    return this.current.current();
  }

  @Get('current/lyrics')
  @Header('Cache-Control', 'no-store')
  async currentLyrics(): Promise<unknown> {
    return (await this.current.currentLyrics()) ?? { status: 'NONE' };
  }

  @Get('current/lyrics/active')
  @Header('Cache-Control', 'no-store')
  async activeLyric(): Promise<unknown> {
    const r = await this.current.activeLine();
    if (!r) return { index: -1, start: null, end: null, text: null, status: 'NONE' };
    if (!r.active) return { index: -1, start: null, end: null, text: null, status: r.status, position: r.position, trackId: r.trackId };
    return { ...r.active, status: r.status, position: r.position, trackId: r.trackId };
  }
}
