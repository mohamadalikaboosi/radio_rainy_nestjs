import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { Player } from './Player';
import { useRealtime } from './useRealtime';
import { WsAudioEnv, WsAudioPlayer, wsAudioSupported } from './ws-audio';

/** A scriptable WebSocket: the test decides when it opens, what arrives and when it closes. */
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closedByClient = false;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closedByClient = true;
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
  // --- test controls ---
  open(): void {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  push(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  pushBinary(buf: ArrayBuffer): void {
    this.onmessage?.({ data: buf });
  }
  drop(): void {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
}

const hello = (over: Record<string, unknown> = {}) => ({
  type: 'hello',
  current: { status: 'PLAYING', trackId: 't1', title: 'Hamkharabeh', artist: 'Sadegh', duration: 240, startedAt: new Date(Date.now() - 30_000).toISOString(), serverTime: new Date().toISOString() },
  vote: { status: 'NONE', serverTime: new Date().toISOString() },
  messages: [],
  listeners: 7,
  clients: 12,
  transport: 'HTTP',
  ...over,
});

describe('useRealtime', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.stubGlobal('WebSocket', FakeWS);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connects to the station socket, applies hello and every pushed change', () => {
    const { result } = renderHook(() => useRealtime('chan'));
    const ws = FakeWS.instances[0] as FakeWS;
    expect(ws.url).toBe(`ws://${window.location.host}/radio/chan/ws`);
    expect(result.current.connected).toBe(false);
    act(() => {
      ws.open();
      ws.push(hello({ messages: [{ id: 'm1', text: 'Welcome', level: 'INFO' }], transport: 'WEBSOCKET' }));
    });
    expect(result.current).toMatchObject({ connected: true, transport: 'WEBSOCKET', listeners: 7, clients: 12, messages: [{ text: 'Welcome' }], current: { title: 'Hamkharabeh' } });
    act(() => ws.push({ type: 'current', current: { status: 'PLAYING', title: 'Next song', trackId: 't2' } }));
    expect(result.current.current?.title).toBe('Next song');
    act(() => ws.push({ type: 'counts', listeners: 9, clients: 15 }));
    expect(result.current).toMatchObject({ listeners: 9, clients: 15 });
    act(() => ws.push({ type: 'vote', vote: { status: 'OPEN', serverTime: 'x' } }));
    expect(result.current.vote?.status).toBe('OPEN');
    act(() => ws.push({ type: 'messages', messages: [] }));
    expect(result.current.messages).toEqual([]);
    act(() => ws.onmessage?.({ data: 'not json' })); // ignored
    expect(result.current.connected).toBe(true);
  });

  it('keeps the connection alive with pings, and reconnects with back-off after a drop', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRealtime('chan'));
    const first = FakeWS.instances[0] as FakeWS;
    act(() => first.open());
    act(() => void vi.advanceTimersByTime(25_000));
    expect(first.sent).toEqual(['ping']);

    act(() => first.drop());
    expect(result.current.connected).toBe(false);
    expect(FakeWS.instances).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1000)); // first retry after 1 s
    expect(FakeWS.instances).toHaveLength(2);
    act(() => FakeWS.instances[1]?.drop());
    act(() => void vi.advanceTimersByTime(1500));
    expect(FakeWS.instances).toHaveLength(2); // the second retry waits 2 s
    act(() => void vi.advanceTimersByTime(600));
    expect(FakeWS.instances).toHaveLength(3);
    act(() => {
      FakeWS.instances[2]?.open();
      FakeWS.instances[2]?.push(hello());
    });
    expect(result.current.connected).toBe(true);
  });

  it('closes on unmount and does not reconnect; a new station opens a new socket', () => {
    vi.useFakeTimers();
    const { unmount, rerender } = renderHook(({ slug }) => useRealtime(slug), { initialProps: { slug: 'chan' as string | null } });
    const a = FakeWS.instances[0] as FakeWS;
    rerender({ slug: 'jazz' });
    expect(a.closedByClient).toBe(true);
    expect(FakeWS.instances[1]?.url).toContain('/radio/jazz/ws');
    unmount();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('does nothing without a station or without WebSocket support', () => {
    renderHook(() => useRealtime(null));
    expect(FakeWS.instances).toHaveLength(0);
  });
});

describe('<Player /> with the live socket', () => {
  const json = (data: unknown): Response => ({ ok: true, status: 200, json: async () => data }) as Response;
  let polls: string[];

  beforeEach(() => {
    FakeWS.instances = [];
    polls = [];
    vi.stubGlobal('WebSocket', FakeWS);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0] ?? '';
      polls.push(url);
      if (url === '/radio/stations') return json([{ slug: 'chan', title: 'Chan', live: true, transport: 'HTTP' }]);
      if (url.endsWith('/current')) return json({ status: 'PLAYING', trackId: 't1', title: 'Polled title', artist: 'A', duration: 240, startedAt: new Date(Date.now() - 30_000).toISOString(), serverTime: new Date().toISOString() });
      if (url.endsWith('/current/lyrics')) return json({ trackId: 't1', status: 'NONE' });
      if (url.endsWith('/sponsors')) return json([]);
      if (url.endsWith('/vote')) return json({ status: 'NONE', serverTime: new Date().toISOString() });
      return json({ status: 'NONE' });
    }) as typeof fetch);
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows pushed announcements (dismissible), the counts, and switches track without polling', async () => {
    render(<Player />);
    await screen.findByText('Polled title');
    await waitFor(() => expect(FakeWS.instances.length).toBeGreaterThan(0));
    const ws = FakeWS.instances[0] as FakeWS;
    act(() => {
      ws.open();
      ws.push(hello({ messages: [{ id: 'm1', text: 'Live concert at 21:00', level: 'WARN' }], listeners: 7, clients: 12 }));
    });
    expect(await screen.findByText('Live concert at 21:00')).toBeInTheDocument();
    expect(screen.getByTestId('live-meta')).toHaveTextContent('7 listening');
    expect(screen.getByTestId('live-meta')).toHaveTextContent('12 online');
    expect(await screen.findByText('Hamkharabeh')).toBeInTheDocument(); // the pushed state replaced the polled one

    act(() => ws.push({ type: 'current', current: { status: 'PLAYING', trackId: 't2', title: 'Pushed next song', artist: 'B', duration: 200, startedAt: new Date().toISOString(), serverTime: new Date().toISOString() } }));
    expect(await screen.findByText('Pushed next song')).toBeInTheDocument();

    act(() => ws.push({ type: 'counts', listeners: 8, clients: 13 }));
    expect(screen.getByTestId('live-meta')).toHaveTextContent('8 listening');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Live concert at 21:00')).not.toBeInTheDocument();
    act(() => ws.push({ type: 'messages', messages: [{ id: 'm1', text: 'Live concert at 21:00', level: 'WARN' }] }));
    expect(screen.queryByText('Live concert at 21:00')).not.toBeInTheDocument(); // stays dismissed
    act(() => ws.push({ type: 'messages', messages: [{ id: 'm2', text: 'A second one', level: 'INFO' }] }));
    expect(await screen.findByText('A second one')).toBeInTheDocument();
  });

  it('while the socket is connected the page barely polls /current (it only needs a safety net)', async () => {
    render(<Player />);
    await screen.findByText('Polled title');
    await waitFor(() => expect(FakeWS.instances.length).toBeGreaterThan(0));
    act(() => {
      FakeWS.instances[0]?.open();
      FakeWS.instances[0]?.push(hello());
    });
    await screen.findByText('Hamkharabeh');
    const count = (): number => polls.filter((u) => u.endsWith('/current')).length;
    const before = count();
    await new Promise((r) => setTimeout(r, 2500)); // the un-connected page polls every second: that would be 2-3 more
    expect(count() - before).toBeLessThanOrEqual(1);
  });

  it('keeps working when the socket is not available: polling shows the state', async () => {
    render(<Player />);
    expect(await screen.findByText('Polled title')).toBeInTheDocument();
    expect(screen.queryByTestId('live-meta')).toHaveTextContent(''); // no counts without a socket
  });
});

// ---------------- audio over WebSocket (Media Source Extensions) ----------------

class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = '';
  appended: ArrayBuffer[] = [];
  removed: [number, number][] = [];
  ranges: [number, number][] = [];
  get buffered(): { length: number; start: (i: number) => number; end: (i: number) => number } {
    return { length: this.ranges.length, start: (i) => this.ranges[i]?.[0] ?? 0, end: (i) => this.ranges[i]?.[1] ?? 0 };
  }
  appendBuffer(b: ArrayBuffer): void {
    this.appended.push(b);
    this.updating = true;
  }
  remove(s: number, e: number): void {
    this.removed.push([s, e]);
    this.updating = true;
  }
  finish(): void {
    this.updating = false;
    this.dispatchEvent(new Event('updateend'));
  }
}
class FakeMediaSource extends EventTarget {
  static supported = true;
  static isTypeSupported = (t: string): boolean => FakeMediaSource.supported && t === 'audio/mpeg';
  sb = new FakeSourceBuffer();
  addSourceBuffer(): FakeSourceBuffer {
    return this.sb;
  }
  open(): void {
    this.dispatchEvent(new Event('sourceopen'));
  }
}

describe('WsAudioPlayer (audio frames over WebSocket -> MSE)', () => {
  let el: HTMLAudioElement;
  let ms: FakeMediaSource;
  let revoked: string[];
  let env: WsAudioEnv;
  const fails: string[] = [];

  beforeEach(() => {
    FakeWS.instances = [];
    fails.length = 0;
    revoked = [];
    FakeMediaSource.supported = true;
    el = document.createElement('audio');
    el.play = vi.fn().mockResolvedValue(undefined);
    el.pause = vi.fn();
    el.load = vi.fn();
    env = {
      MediaSource: class extends FakeMediaSource {
        constructor() {
          super();
          ms = this;
        }
      } as never,
      WebSocket: FakeWS as never,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: (u) => void revoked.push(u),
    };
    (env.MediaSource as unknown as typeof FakeMediaSource).isTypeSupported = FakeMediaSource.isTypeSupported;
  });

  const started = async (): Promise<{ p: WsAudioPlayer; ws: FakeWS; done: Promise<void> }> => {
    const p = new WsAudioPlayer(el, 'ws://x/radio/chan/audio', (r) => fails.push(r), env);
    const done = p.start();
    await Promise.resolve();
    ms.open();
    await waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    return { p, ws: FakeWS.instances[0] as FakeWS, done };
  };
  const frame = (n: number): ArrayBuffer => new Uint8Array([n, n, n]).buffer;

  it('detects support (MediaSource + audio/mpeg)', () => {
    expect(wsAudioSupported({ MediaSource: env.MediaSource })).toBe(true);
    FakeMediaSource.supported = false;
    expect(wsAudioSupported({ MediaSource: env.MediaSource })).toBe(false);
    expect(wsAudioSupported({ MediaSource: undefined as never })).toBe(false);
  });

  it('opens the socket as binary, plays, and appends frames strictly in order (one at a time)', async () => {
    const { ws, done } = await started();
    await done;
    expect(ws.binaryType).toBe('arraybuffer');
    expect(el.play).toHaveBeenCalled();
    expect(ms.sb.mode).toBe('sequence');
    ws.pushBinary(frame(1));
    ws.pushBinary(frame(2));
    ws.pushBinary(frame(3));
    expect(ms.sb.appended.map((b) => new Uint8Array(b)[0])).toEqual([1]); // the buffer is busy: the rest waits in the queue
    ms.sb.finish();
    expect(ms.sb.appended.map((b) => new Uint8Array(b)[0])).toEqual([1, 2]);
    ms.sb.finish();
    ms.sb.finish();
    expect(ms.sb.appended.map((b) => new Uint8Array(b)[0])).toEqual([1, 2, 3]);
    expect(fails).toEqual([]);
  });

  it('trims audio far behind the playhead (keeps 10 s)', async () => {
    const { ws, done } = await started();
    await done;
    ms.sb.ranges = [[0, 40]];
    Object.defineProperty(el, 'currentTime', { value: 25, writable: true, configurable: true });
    ws.pushBinary(frame(1));
    expect(ms.sb.removed).toEqual([[0, 15]]);
    expect(ms.sb.appended).toHaveLength(0); // the trim runs first; the append follows on `updateend`
    ms.sb.ranges = [[15, 40]];
    (el as { currentTime: number }).currentTime = 20;
    ms.sb.finish();
    expect(ms.sb.appended).toHaveLength(1);
  });

  it('jumps to the live edge when it is more than 4 s ahead of the playhead (keeps latency low after a stall)', async () => {
    const { ws, done } = await started();
    await done;
    ms.sb.ranges = [[28, 40]];
    Object.defineProperty(el, 'currentTime', { value: 30, writable: true, configurable: true });
    ws.pushBinary(frame(1));
    expect(el.currentTime).toBeCloseTo(39.2, 1); // end - 0.8 s
    expect(ms.sb.appended).toHaveLength(1);
  });

  it('reports a closed socket (server stopped / not the leader) so the player can fall back to HTTP', async () => {
    const { ws, done } = await started();
    await done;
    ws.drop();
    expect(fails).toEqual(['audio socket closed']);
    expect(revoked).toEqual(['blob:fake']);
  });

  it('reports unsupported browsers without opening a socket, and append errors', async () => {
    FakeMediaSource.supported = false;
    const p = new WsAudioPlayer(el, 'ws://x/a', (r) => fails.push(r), env);
    await p.start();
    expect(fails).toEqual(['MSE/mp3 not supported']);
    expect(FakeWS.instances).toHaveLength(0);

    FakeMediaSource.supported = true;
    fails.length = 0;
    const { ws, done } = await started();
    await done;
    ms.sb.appendBuffer = () => {
      throw new Error('QuotaExceeded');
    };
    ws.pushBinary(frame(1));
    expect(fails[0]).toContain('append failed');
  });

  it('stop() is silent: closes the socket, releases the blob URL, never calls onFail', async () => {
    const { p, ws, done } = await started();
    await done;
    p.stop();
    expect(ws.closedByClient).toBe(true);
    expect(revoked).toEqual(['blob:fake']);
    expect(el.pause).toHaveBeenCalled();
    expect(fails).toEqual([]);
  });
});

describe('<Player /> audio transport (HTTP / WebSocket) and the automatic fallback', () => {
  const json = (data: unknown): Response => ({ ok: true, status: 200, json: async () => data }) as Response;
  let mediaSources: FakeMediaSource[];

  beforeEach(() => {
    FakeWS.instances = [];
    mediaSources = [];
    vi.stubGlobal('WebSocket', FakeWS);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0] ?? '';
      if (url === '/radio/stations') return json([{ slug: 'chan', title: 'Chan', live: true, transport: 'WEBSOCKET' }]);
      if (url.endsWith('/current')) return json({ status: 'PLAYING', trackId: 't1', title: 'Song', artist: 'A', duration: 240, startedAt: new Date().toISOString(), serverTime: new Date().toISOString() });
      if (url.endsWith('/sponsors')) return json([]);
      if (url.endsWith('/current/lyrics')) return json({ trackId: 't1', status: 'NONE' });
      return json({ status: 'NONE', serverTime: new Date().toISOString() });
    }) as typeof fetch);
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const installMse = (): void => {
    FakeMediaSource.supported = true;
    vi.stubGlobal(
      'MediaSource',
      class extends FakeMediaSource {
        constructor() {
          super();
          mediaSources.push(this);
        }
      },
    );
    (window as unknown as { MediaSource: unknown }).MediaSource = (globalThis as unknown as { MediaSource: unknown }).MediaSource;
    (globalThis as unknown as { MediaSource: { isTypeSupported: unknown } }).MediaSource.isTypeSupported = FakeMediaSource.isTypeSupported;
  };
  const socketFor = (path: string): FakeWS | undefined => FakeWS.instances.find((w) => w.url.endsWith(path));

  it('WebSocket configured but the browser has no MSE for mp3 (e.g. iPhone): plays over HTTP straight away', async () => {
    (window as unknown as { MediaSource?: unknown }).MediaSource = undefined;
    render(<Player />);
    const btn = await screen.findByRole('button', { name: 'Listen live' });
    await waitFor(() => expect(btn).toBeEnabled());
    await act(async () => fireEvent.click(btn));
    await waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toMatch(/^\/radio\/chan\/stream\?ts=\d+$/));
    expect(socketFor('/radio/chan/audio')).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId('live-meta')).toHaveTextContent('via HTTP'));
  });

  it('WebSocket configured and supported: opens the audio socket, shows "via WebSocket", and does not touch the HTTP stream', async () => {
    installMse();
    render(<Player />);
    const btn = await screen.findByRole('button', { name: 'Listen live' });
    await waitFor(() => expect(btn).toBeEnabled());
    await act(async () => fireEvent.click(btn));
    await waitFor(() => expect(mediaSources).toHaveLength(1));
    await act(async () => mediaSources[0]?.open());
    await waitFor(() => expect(socketFor('/radio/chan/audio')).toBeDefined());
    expect(document.querySelector('audio')?.getAttribute('src')).toBe('blob:fake');
    await waitFor(() => expect(screen.getByTestId('live-meta')).toHaveTextContent('via WebSocket'));
  });

  it('if the audio socket closes (server stopped / not the leader) the player falls back to HTTP by itself and remembers it', async () => {
    installMse();
    render(<Player />);
    const btn = await screen.findByRole('button', { name: 'Listen live' });
    await waitFor(() => expect(btn).toBeEnabled());
    await act(async () => fireEvent.click(btn));
    await waitFor(() => expect(mediaSources).toHaveLength(1));
    await act(async () => mediaSources[0]?.open());
    await waitFor(() => expect(socketFor('/radio/chan/audio')).toBeDefined());
    await act(async () => socketFor('/radio/chan/audio')?.drop()); // 1013: this instance does not broadcast the station
    await waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toMatch(/^\/radio\/chan\/stream\?ts=\d+$/));
    await waitFor(() => expect(screen.getByTestId('live-meta')).toHaveTextContent('via HTTP'));

    // pause and play again: WebSocket is not retried in this session
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pause' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Listen live' })));
    await waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toMatch(/^\/radio\/chan\/stream/));
    expect(mediaSources).toHaveLength(1);
  });
});
