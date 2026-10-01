import { Broadcaster, ListenerSink } from '../../domain/broadcaster';

/**
 * A second, lighter MP3 stream of one station for slow connections ("data saver").
 * It is ONE ffmpeg process per station (never per listener) that re-encodes the station's normal stream, shared by every low-quality
 * listener. It only runs while somebody listens: the first low listener starts it, the last one stops it. If ffmpeg is missing or keeps
 * failing, `available` turns false for a while and the controller serves the normal stream instead, so nobody is left without audio.
 */
export abstract class LowQualityStream {
  abstract readonly broadcaster: Broadcaster;
  abstract get listenerCount(): number;
  /** false while ffmpeg cannot be used (the caller then serves the normal stream). */
  abstract get available(): boolean;
  abstract get running(): boolean;
  /** Same contract as Broadcaster.subscribe; starts the encoder with the first listener and stops it with the last. */
  abstract subscribe(sink: ListenerSink): () => void;
  /** Station stopped: end every low listener and release ffmpeg. */
  abstract shutdown(): void;
}
