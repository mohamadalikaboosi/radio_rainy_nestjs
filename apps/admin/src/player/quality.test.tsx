import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { Player } from './Player';
import { loadQuality, saveQuality, slowConnection, stallTracker, withQuery } from './helpers';

describe('quality helpers', () => {
  beforeEach(() => localStorage.clear());
  it('remembers the choice and defaults to auto', () => {
    expect(loadQuality()).toBe('auto');
    saveQuality('low');
    expect(loadQuality()).toBe('low');
    localStorage.setItem('rr_quality', 'garbage');
    expect(loadQuality()).toBe('auto');
  });
  it('detects slow connections / save-data', () => {
    expect(slowConnection({})).toBe(false);
    expect(slowConnection({ connection: { effectiveType: '4g' } })).toBe(false);
    expect(slowConnection({ connection: { effectiveType: '3g' } })).toBe(true);
    expect(slowConnection({ connection: { effectiveType: '2g' } })).toBe(true);
    expect(slowConnection({ connection: { effectiveType: '4g', saveData: true } })).toBe(true);
  });
  it('stall tracker trips after 3 stalls within the window only', () => {
    const t = stallTracker(3, 1000);
    expect(t(0)).toBe(false);
    expect(t(500)).toBe(false);
    expect(t(5000)).toBe(false); // earlier ones expired
    expect(t(5100)).toBe(false);
    expect(t(5200)).toBe(true);
  });
  it('withQuery appends with ? or &', () => {
    expect(withQuery('/a', { quality: 'low' })).toBe('/a?quality=low');
    expect(withQuery('/a?x=1', { quality: 'low' })).toBe('/a?x=1&quality=low');
  });
});

describe('<Player /> data-saver quality', () => {
  const json = (data: unknown): Response => ({ ok: true, status: 200, json: async () => data }) as Response;
  let lowQuality: boolean;
  const srcs: string[] = [];

  beforeEach(() => {
    localStorage.clear();
    srcs.length = 0;
    lowQuality = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0] ?? '';
      if (url === '/radio/stations') return json([{ slug: 'chan', title: 'Chan', live: true, transport: 'HTTP', lowQuality }]);
      if (url.endsWith('/current')) return json({ status: 'PLAYING', trackId: 't1', title: 'Song', artist: 'A', duration: 240, startedAt: new Date().toISOString(), serverTime: new Date().toISOString() });
      if (url.endsWith('/sponsors')) return json([]);
      return json({ status: 'NONE', serverTime: new Date().toISOString() });
    }) as typeof fetch);
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, set(v: string) { srcs.push(v); (this as HTMLElement).setAttribute('src', v); }, get() { return (this as HTMLElement).getAttribute('src') ?? ''; } });
    void desc;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (navigator as unknown as { connection?: unknown }).connection;
  });

  const renderPlayer = () =>
    render(
      <MemoryRouter>
        <I18nProvider>
          <Player />
        </I18nProvider>
      </MemoryRouter>,
    );

  it('no selector when the station has no data-saver stream', async () => {
    lowQuality = false;
    renderPlayer();
    await screen.findByRole('button', { name: 'Listen live' });
    expect(screen.queryByLabelText('Quality')).toBeNull();
  });

  it('plays the normal stream by default and the low one when chosen (remembered)', async () => {
    renderPlayer();
    const btn = await screen.findByRole('button', { name: 'Listen live' });
    const sel = await screen.findByLabelText('Quality');
    fireEvent.click(btn);
    await waitFor(() => expect(srcs.length).toBe(1));
    expect(srcs[0]).not.toContain('quality=low');
    fireEvent.change(sel, { target: { value: 'low' } });
    await waitFor(() => expect(srcs.some((s) => s.includes('quality=low'))).toBe(true)); // rejoined on the light stream
    expect(localStorage.getItem('rr_quality')).toBe('low');
    expect(await screen.findByText(/Data saver/)).toBeInTheDocument();
  });

  it('auto mode starts light on a slow connection', async () => {
    (navigator as unknown as { connection: unknown }).connection = { effectiveType: '3g' };
    renderPlayer();
    fireEvent.click(await screen.findByRole('button', { name: 'Listen live' }));
    await waitFor(() => expect(srcs.some((s) => s.includes('quality=low'))).toBe(true));
  });

  it('auto mode switches to the light stream after repeated stalls', async () => {
    const { container } = renderPlayer();
    fireEvent.click(await screen.findByRole('button', { name: 'Listen live' }));
    await waitFor(() => expect(srcs.length).toBe(1));
    const el = container.querySelector('audio') as HTMLAudioElement;
    act(() => {
      for (let i = 0; i < 3; i++) el.dispatchEvent(new Event('waiting'));
    });
    await waitFor(() => expect(srcs.some((s) => s.includes('quality=low'))).toBe(true));
  });
});
