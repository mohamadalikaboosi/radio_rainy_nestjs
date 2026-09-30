import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LiveStation } from '../api';
import { LiveContext } from '../live-context';
import { Live } from './Live';

const station = (over: Partial<LiveStation> = {}): LiveStation => ({
  id: '1001', slug: 'chan', title: 'Chan Radio', started: true, running: true, status: 'PLAYING', statusReason: null, transitionSeq: 7, listeners: 3,
  liveOnTelegram: { enabled: true, status: 'LIVE', error: null }, streamUrl: '/radio/chan/stream',
  nowPlaying: { trackId: 't1', title: 'Rainy Night', artist: 'Luna', album: 'Nocturne', duration: 200, startedAt: '2026-01-01T00:00:00Z', position: 50, lyricsStatus: 'LYRICS_READY', activeLine: 'Hello my friend' },
  upNext: null, recent: [{ trackId: 't0', title: 'Old Song', artist: 'X', startedAt: '2026-01-01T00:00:00Z', endReason: 'SKIPPED' }], ...over,
});

function mock(handlers: Record<string, (init: RequestInit, url: string) => unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    const h = handlers[key];
    if (!h) return { status: 404, ok: false, json: async () => ({ message: `unmocked ${key}` }) } as Response;
    return { status: 200, ok: true, json: async () => h(init ?? {}, url) } as Response;
  });
}
const view = (stations: LiveStation[], refresh = vi.fn()) => render(<MemoryRouter><LiveContext.Provider value={{ stations, error: null, loading: false, refresh }}><Live /></LiveContext.Provider></MemoryRouter>);

describe('<Live /> control room', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows what is on air now: track, artist, progress, current lyric line, listeners and Telegram live status', () => {
    view([station()]);
    expect(screen.getByText('Rainy Night')).toBeInTheDocument();
    expect(screen.getByText(/Luna · Nocturne/)).toBeInTheDocument();
    expect(screen.getByText('Hello my friend')).toBeInTheDocument();
    expect(screen.getByText('3 listening')).toBeInTheDocument();
    expect(screen.getByText(/Telegram LIVE/)).toBeInTheDocument();
    expect(screen.getByText('00:50')).toBeInTheDocument();
    expect(screen.getByText('picked automatically near the end of the track')).toBeInTheDocument();
  });

  it('Next sends skip with the current transition token (a stale click is ignored by the server)', async () => {
    let body: unknown;
    const refresh = vi.fn();
    mock({ 'POST /admin/channels/1001/radio/skip': (i) => { body = JSON.parse(String(i.body)); return { accepted: true }; } });
    view([station()], refresh);
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(body).toEqual({ expectedSeq: 7 }));
    expect(await screen.findByRole('button', { name: 'Skipping…' })).toBeDisabled(); // cannot double-click
    expect(refresh).toHaveBeenCalled();
  });

  it('search a track and play it now, or queue it after the current one', async () => {
    const calls: string[] = [];
    mock({
      'GET /admin/tracks': (_i, url) => { calls.push(url); return { total: 1, page: 1, pageSize: 8, items: [{ id: 'tX', title: 'Chosen Song', artist: 'Kai', album: null, duration: 180 }] }; },
      'POST /admin/channels/1001/radio/queue-next': (i) => { calls.push(`queue:${String(i.body)}`); return { accepted: true }; },
      'POST /admin/channels/1001/radio/play-next': (i) => { calls.push(`play:${String(i.body)}`); return { accepted: true }; },
    });
    view([station()]);
    fireEvent.click(screen.getByRole('button', { name: /Queue next…/ }));
    fireEvent.change(screen.getByLabelText('search tracks'), { target: { value: 'chosen' } });
    fireEvent.click(await screen.findByText('+ Queue next'));
    await waitFor(() => expect(calls).toContain('queue:{"trackId":"tX"}'));
    expect(calls.some((c) => c.includes('channel=1001') && c.includes('q=chosen') && c.includes('playback=PLAYABLE'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Play a track…/ }));
    fireEvent.click(await screen.findByText('▶ Play now'));
    await waitFor(() => expect(calls).toContain('play:{"trackId":"tX"}'));
  });

  it('a stopped station offers Start; the Next button is disabled when nothing plays', async () => {
    const started = vi.fn(() => ({}));
    mock({ 'POST /admin/channels/1001/start': started });
    const { unmount } = view([station({ started: false, running: false, status: 'STOPPED', nowPlaying: null })]);
    expect(screen.getByText('stopped')).toBeInTheDocument();
    fireEvent.click(screen.getByText('▶ Start station'));
    await waitFor(() => expect(started).toHaveBeenCalled());
    unmount();
    view([station({ nowPlaying: null, status: 'IDLE', statusReason: 'NO_PLAYABLE_TRACKS' })]);
    expect(screen.getByText(/NO_PLAYABLE_TRACKS/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
  });

  it('shows Telegram live errors and the empty state', () => {
    const { unmount } = view([station({ liveOnTelegram: { enabled: true, status: 'ERROR', error: 'CHAT_ADMIN_REQUIRED' } })]);
    expect(screen.getByRole('alert')).toHaveTextContent('CHAT_ADMIN_REQUIRED');
    unmount();
    view([]);
    expect(screen.getByText(/No channels yet/)).toBeInTheDocument();
  });
});
