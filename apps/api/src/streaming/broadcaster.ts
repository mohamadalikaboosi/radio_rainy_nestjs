export interface ListenerSink {
  write(chunk: Buffer): void;
  end(): void;
}

/**
 * One producer, many listeners. The current track is downloaded/decoded once and pushed here;
 * every listener gets the same bytes. A short ring buffer gives new listeners an instant start
 * (low join latency) without any per-listener Telegram download.
 */
export class Broadcaster {
  private readonly sinks = new Set<ListenerSink>();
  private ring: Buffer[] = [];
  private ringSize = 0;

  constructor(private readonly ringBytes: number) {}

  get listenerCount(): number {
    return this.sinks.size;
  }

  push(chunk: Buffer): void {
    this.ring.push(chunk);
    this.ringSize += chunk.length;
    while (this.ring.length > 1 && this.ringSize - (this.ring[0]?.length ?? 0) >= this.ringBytes) {
      this.ringSize -= this.ring.shift()?.length ?? 0;
    }
    for (const sink of [...this.sinks]) this.safeWrite(sink, chunk);
  }

  /** Sends the buffered tail immediately, then live chunks. Returns an idempotent unsubscribe. */
  subscribe(sink: ListenerSink): () => void {
    this.sinks.add(sink);
    for (const c of this.ring) this.safeWrite(sink, c);
    return () => {
      this.sinks.delete(sink);
    };
  }

  endAll(): void {
    for (const sink of [...this.sinks]) {
      this.sinks.delete(sink);
      try {
        sink.end();
      } catch {
        // sink already dead; nothing else to clean
        continue;
      }
    }
  }

  private safeWrite(sink: ListenerSink, chunk: Buffer): void {
    try {
      sink.write(chunk);
    } catch {
      // A failing listener must never affect the others: drop it.
      this.sinks.delete(sink);
    }
  }
}
