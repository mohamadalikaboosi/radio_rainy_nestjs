import { Writable } from 'node:stream';
import { ListenerSink } from '../domain/broadcaster';

/**
 * Adapts an HTTP response to a ListenerSink. Slow clients are disconnected once their queued
 * bytes exceed `maxBacklogBytes`, so a single bad connection can never grow memory or stall others.
 */
export class HttpListenerSink implements ListenerSink {
  constructor(
    private readonly out: Writable,
    private readonly maxBacklogBytes: number,
    private readonly onDrop?: (reason: string) => void,
  ) {}

  write(chunk: Buffer): void {
    if (this.out.destroyed || this.out.writableEnded) return;
    if (this.out.writableLength > this.maxBacklogBytes) {
      this.onDrop?.('slow-listener');
      this.out.destroy();
      return;
    }
    this.out.write(chunk);
  }

  end(): void {
    if (!this.out.destroyed && !this.out.writableEnded) this.out.end();
  }
}
