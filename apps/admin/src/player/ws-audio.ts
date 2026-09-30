/**
 * Plays the radio from binary WebSocket frames through Media Source Extensions (the alternative to the plain HTTP MP3 stream).
 * The server sends the very same shared stream; this class only feeds it to a <audio> element and keeps the latency low.
 * Any problem (no MSE for audio/mpeg, socket closed, append error) is reported through `onFail` so the player can fall back to HTTP.
 */
export interface WsAudioEnv {
  MediaSource: typeof MediaSource;
  WebSocket: typeof WebSocket;
  createObjectURL: (ms: MediaSource) => string;
  revokeObjectURL: (url: string) => void;
}

const MIME = 'audio/mpeg';
/** Seconds of audio kept behind the playhead. */
const KEEP_BEHIND = 10;
/** If more than this is buffered ahead, jump to the live edge (keeps latency small after a stall / background tab). */
const MAX_LEAD = 4;
const LIVE_LEAD = 0.8;

export function wsAudioSupported(env: Pick<WsAudioEnv, 'MediaSource'> | undefined = typeof window === 'undefined' ? undefined : { MediaSource: (window as unknown as { MediaSource?: typeof MediaSource }).MediaSource as typeof MediaSource }): boolean {
  const MS = env?.MediaSource;
  try {
    return typeof MS === 'function' && MS.isTypeSupported(MIME);
  } catch {
    return false;
  }
}

export class WsAudioPlayer {
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private readonly queue: ArrayBuffer[] = [];
  private stopped = false;
  private failed = false;

  constructor(
    private readonly el: HTMLAudioElement,
    private readonly socketUrl: string,
    private readonly onFail: (reason: string) => void,
    private readonly env: WsAudioEnv = {
      MediaSource: (window as unknown as { MediaSource: typeof MediaSource }).MediaSource,
      WebSocket: window.WebSocket,
      createObjectURL: (m) => URL.createObjectURL(m),
      revokeObjectURL: (u) => URL.revokeObjectURL(u),
    },
  ) {}

  /** Resolves once audio is playing; rejects (after calling `onFail`) when it cannot. */
  async start(): Promise<void> {
    if (!wsAudioSupported(this.env)) return this.fail('MSE/mp3 not supported');
    const ms = new this.env.MediaSource();
    this.ms = ms;
    this.url = this.env.createObjectURL(ms);
    this.el.src = this.url;
    await new Promise<void>((resolve, reject) => {
      ms.addEventListener('sourceopen', () => resolve(), { once: true });
      setTimeout(() => reject(new Error('MediaSource did not open')), 5000);
    }).catch((e: unknown) => this.fail(String(e)));
    if (this.stopped || this.failed) return;
    try {
      this.sb = ms.addSourceBuffer(MIME);
      this.sb.mode = 'sequence';
      this.sb.addEventListener('updateend', () => this.pump());
      this.sb.addEventListener('error', () => this.fail('source buffer error'));
    } catch (e) {
      return this.fail(String(e));
    }
    const ws = new this.env.WebSocket(this.socketUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        this.queue.push(ev.data);
        this.pump();
      }
    };
    ws.onclose = () => {
      if (!this.stopped) this.fail('audio socket closed');
    };
    ws.onerror = () => undefined; // onclose follows
    await this.el.play().catch((e: unknown) => this.fail(`play() rejected: ${String(e)}`));
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
  }

  private fail(reason: string): void {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.cleanup();
    this.onFail(reason);
  }

  private cleanup(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.queue.length = 0;
    try {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    } catch {
      /* element already gone */
    }
    if (this.url) this.env.revokeObjectURL(this.url);
    this.url = null;
    this.sb = null;
    this.ms = null;
  }

  /** Appends the next chunk when the buffer is idle, then trims old audio and snaps to the live edge. */
  private pump(): void {
    const sb = this.sb;
    if (!sb || sb.updating || this.stopped) return;
    try {
      const buffered = sb.buffered;
      if (buffered.length > 0) {
        const start = buffered.start(0);
        const end = buffered.end(buffered.length - 1);
        if (this.el.currentTime - start > KEEP_BEHIND) {
          sb.remove(start, this.el.currentTime - KEEP_BEHIND);
          return; // `updateend` calls pump again
        }
        if (end - this.el.currentTime > MAX_LEAD) this.el.currentTime = end - LIVE_LEAD;
      }
      const next = this.queue.shift();
      if (next) sb.appendBuffer(next);
    } catch (e) {
      this.fail(`append failed: ${String(e)}`);
    }
  }
}
