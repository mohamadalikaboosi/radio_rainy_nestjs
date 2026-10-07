import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Player } from './Player';

interface World {
  current: Record<string, unknown>;
  lyrics: Record<string, unknown> | null;
  vote: Record<string, unknown>;
  sponsors: unknown[];
}

let world: World;
const calls: { url: string; method: string; body?: unknown }[] = [];

const json = (data: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => data }) as Response;

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.startsWith('/radio/stations')) return Promise.resolve(json([{ slug: 'chan', title: 'Chan', live: true }]));
  if (url.includes('/current/lyrics/active')) return Promise.resolve(json({ index: 1, text: 'second', status: 'READY' }));
  if (url.includes('/current/lyrics')) return Promise.resolve(json(world.lyrics));
  if (url.includes('/current')) return Promise.resolve(json(world.current));
  if (url.includes('/sponsors')) return Promise.resolve(json(world.sponsors));
  if (url.includes('/vote') && init?.method === 'POST') {
    const tag = (JSON.parse(String(init.body)) as { hashtag: string }).hashtag;
    return Promise.resolve(json({ ...world.vote, myVote: tag }));
  }
  if (url.includes('/vote')) return Promise.resolve(json(world.vote));
  return Promise.resolve(json({}, 404));
}

const playing = { status: 'PLAYING', trackId: 't1', title: 'Hamkharabeh', artist: 'Sadegh', duration: 200, startedAt: new Date(Date.now() - 30_000).toISOString(), position: 30, serverTime: new Date().toISOString() };

describe('<Player />', () => {
  beforeEach(() => {
    calls.length = 0;
    localStorage.clear();
    world = { current: playing, lyrics: { trackId: 't1', status: 'NONE' }, vote: { status: 'NONE', serverTime: new Date().toISOString() }, sponsors: [] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch as typeof fetch);
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the track on air, ON AIR, the visualizer, and says so when a track has no lyrics', async () => {
    render(<Player />);
    expect(await screen.findByText('Hamkharabeh')).toBeInTheDocument();
    expect(screen.getByText('Sadegh')).toBeInTheDocument();
    expect(screen.getByText('On air')).toBeInTheDocument();
    expect(screen.getByTestId('visualizer').children).toHaveLength(64);
    expect(await screen.findByText('Lyrics aren’t available for this track')).toBeInTheDocument();
    expect(screen.queryByLabelText('Lyrics')).not.toBeInTheDocument(); // no lines list
  });

  it('shows the synchronized lyrics with the line being sung active, found by the browser (no per-line polling)', async () => {
    world.lyrics = { trackId: 't1', status: 'READY', lines: [{ start: 0, end: 5, text: 'first' }, { start: 28, end: 34, text: 'second' }] }; // the track started 30 s ago: the browser finds 'second' itself
    render(<Player />);
    expect(await screen.findByText('second')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('second')).toHaveClass('active'));
    expect(screen.getByText('first')).not.toHaveClass('active');
    expect(screen.getAllByText('• • •')).toHaveLength(2); // instrumental rows: the 23 s between the lines and the rest of the 200 s track
    expect(screen.getByTestId('lyrics-card')).toHaveTextContent('Hamkharabeh — Sadegh');
    expect(screen.getByTestId('visualizer')).toBeInTheDocument();
    const polls = (): number => calls.filter((c) => c.url.includes('/current/lyrics/active')).length;
    const before = polls();
    await new Promise((r) => setTimeout(r, 1200));
    expect(polls()).toBe(before); // once the lines are known there is no per-line polling (the 500 ms poll would have fired twice)
  });

  it('plain (unsynchronized) lyrics are shown as text', async () => {
    world.lyrics = { trackId: 't1', status: 'PLAIN', plain: ['line one', 'line two'] };
    render(<Player />);
    expect(await screen.findByText('line one')).toBeInTheDocument();
    expect(screen.getByTestId('lyrics-card')).toHaveTextContent('Text only');
  });

  it('the Lyrics button hides and shows the card, and the choice is remembered', async () => {
    world.lyrics = { trackId: 't1', status: 'PLAIN', plain: ['line one'] };
    const { unmount } = render(<Player />);
    const btn = await screen.findByRole('button', { name: /Lyrics/ });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(screen.queryByTestId('lyrics-card')).not.toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    unmount();
    render(<Player />);
    await screen.findByText('Hamkharabeh');
    expect(screen.queryByTestId('lyrics-card')).not.toBeInTheDocument();
  });

  it('the volume slider sets the audio volume (default 70) and is remembered', async () => {
    render(<Player />);
    const slider = await screen.findByRole('slider', { name: 'Volume' });
    const audio = document.querySelector('audio') as HTMLAudioElement;
    expect(slider).toHaveValue('70');
    expect(audio.volume).toBeCloseTo(0.7, 5);
    fireEvent.change(slider, { target: { value: '25' } });
    expect(audio.volume).toBeCloseTo(0.25, 5);
    expect(localStorage.getItem('rr_volume')).toBe('25');
  });

  it('a stream that drops by itself reconnects (Reconnecting… instead of ON AIR) until it plays again', async () => {
    render(<Player />);
    const btn = await screen.findByRole('button', { name: 'Listen live' });
    await waitFor(() => expect(btn).toBeEnabled());
    await act(async () => fireEvent.click(btn));
    const audio = document.querySelector('audio') as HTMLAudioElement;
    const first = audio.getAttribute('src');
    await new Promise((r) => setTimeout(r, 5));
    act(() => void audio.dispatchEvent(new Event('error')));
    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument(); // still wants to listen
    await waitFor(() => expect(audio.getAttribute('src')).not.toBe(first), { timeout: 2500 }); // retried on a fresh live URL
    act(() => void audio.dispatchEvent(new Event('playing')));
    expect(await screen.findByText('On air')).toBeInTheDocument();
  });

  it('plays the station stream on the first tap and pauses on the second', async () => {
    render(<Player />);
    const btn = await screen.findByRole('button', { name: 'Listen live' });
    await waitFor(() => expect(btn).toBeEnabled());
    await act(async () => fireEvent.click(btn));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument());
    expect(document.querySelector('audio')?.getAttribute('src')).toMatch(/^\/radio\/chan\/stream\?ts=\d+$/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pause' })));
    expect(screen.getByRole('button', { name: 'Listen live' })).toBeInTheDocument();
    expect(document.querySelector('audio')?.getAttribute('src')).toBeNull(); // dropped: playing again joins the live edge
  });

  it('shows the ad on air: artwork, sponsored label and a safe call-to-action link', async () => {
    world.current = { status: 'AD', serverTime: new Date().toISOString(), ad: { id: 'a1', name: 'Coffee shop', startedAt: new Date().toISOString(), duration: 15, linkUrl: '/radio/go/ad/a1', ctaLabel: 'Order', imageUrl: '/radio/ads/a1/image' } };
    render(<Player />);
    const card = await screen.findByTestId('ad-card');
    expect(card).toHaveTextContent('Sponsored message');
    expect(card).toHaveTextContent('Coffee shop');
    const cta = screen.getByRole('link', { name: 'Order' });
    expect(cta).toHaveAttribute('href', '/radio/go/ad/a1');
    expect(cta).toHaveAttribute('target', '_blank');
    expect(cta.getAttribute('rel')).toContain('noopener');
    expect(card.querySelector('img')).toHaveAttribute('src', '/radio/ads/a1/image');
    expect(screen.queryByText('Hamkharabeh')).not.toBeInTheDocument();
  });

  it('lets the listener vote for a tag; the choice is sent once and shown', async () => {
    world.vote = { status: 'OPEN', serverTime: new Date().toISOString(), myVote: null, poll: { id: 'p1', closesAt: new Date(Date.now() + 120_000).toISOString(), totalVotes: 2, options: [{ hashtag: 'rock', votes: 1 }, { hashtag: 'jazz', votes: 1 }] } };
    render(<Player />);
    const card = await screen.findByTestId('vote-open');
    expect(card).toHaveTextContent('What plays next?');
    expect(screen.getByRole('button', { name: /#rock/ })).toHaveTextContent('50% · 1 vote');
    expect(card).toHaveTextContent('Tap a tag to cast your vote.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /#jazz/ })));
    await waitFor(() => expect(screen.getByRole('button', { name: /#jazz/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(card).toHaveTextContent('Vote counted — results update live.');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/radio/chan/vote');
    expect(post?.body).toMatchObject({ hashtag: 'jazz' });
    expect((post?.body as { voterId: string }).voterId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('announces the winning tag while it plays', async () => {
    world.vote = { status: 'PLAYING', winner: 'jazz', playUntil: new Date(Date.now() + 600_000).toISOString(), serverTime: new Date().toISOString() };
    render(<Player />);
    expect(await screen.findByTestId('vote-playing')).toHaveTextContent('Now playing #jazz');
  });

  it('shows a sponsor with a button that opens the tracked link in a new tab', async () => {
    world.sponsors = [{ id: 's1', name: 'Acme', tagline: 'Best coffee', ctaLabel: 'Buy now', weight: 1, logoUrl: '/radio/sponsors/s1/logo', url: '/radio/go/sponsor/s1' }];
    render(<Player />);
    const card = await screen.findByTestId('sponsor');
    expect(card).toHaveTextContent('Acme');
    expect(card).toHaveTextContent('Best coffee');
    const link = screen.getByRole('link', { name: 'Buy now' });
    expect(link).toHaveAttribute('href', '/radio/go/sponsor/s1');
    expect(link.getAttribute('rel')).toMatch(/sponsored/);
  });

  it('does not render the vote or sponsor areas when there is nothing to show', async () => {
    render(<Player />);
    await screen.findByText('Hamkharabeh');
    expect(screen.queryByTestId('vote-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sponsor')).not.toBeInTheDocument();
  });
});
