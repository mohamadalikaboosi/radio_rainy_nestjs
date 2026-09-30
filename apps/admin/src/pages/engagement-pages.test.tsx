import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChannelItem } from '../api';
import { ChannelProvider } from '../channel-context';
import { Ads } from './Ads';
import { Engagement } from './Engagement';
import { LiveTarget } from './LiveTarget';
import { Sponsors } from './Sponsors';

const channel: ChannelItem = { id: '1001', reference: '@chan', title: 'Chan', username: 'chan', slug: 'chan', started: true, telegramLiveEnabled: true, liveStatus: 'LIVE', liveError: null, liveRtmpUrl: null, liveRtmpKeySet: false, liveTargetRev: 0 };
const calls: { url: string; method: string; body?: unknown; contentType?: string }[] = [];
const json = (data: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => data }) as Response;

const ad = { id: 'a1', channelId: null, name: 'Coffee', weight: 2, enabled: true, linkUrl: null, ctaLabel: null, hasAudio: false, audioMime: null, audioSize: null, durationSeconds: null, hasImage: false, plays: 3, clicks: 1, lastPlayedAt: null, createdAt: new Date().toISOString() };
const settings = { adsEveryNTracks: 3, tagVoteEnabled: true, tagVoteIntervalMinutes: 60, tagVotePollMinutes: 3, tagVotePlayMinutes: 20, tagVoteOptions: 3, tagVoteAllowlist: ['rock'] };

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method: init?.method ?? 'GET', body, contentType: headers['Content-Type'] });
    if (url.startsWith('/admin/channels') && !url.includes('/engagement') && !url.includes('/tag-votes') && !url.includes('live-target')) return json([channel]);
    if (url.includes('/engagement')) return json(settings);
    if (url.includes('/tag-votes')) return json({ current: { status: 'NONE', serverTime: new Date().toISOString() }, history: [] });
    if (url.startsWith('/admin/ads') && (init?.method ?? 'GET') === 'GET') return json([ad]);
    if (url.startsWith('/admin/sponsors') && (init?.method ?? 'GET') === 'GET') return json([]);
    return json({ ...ad });
  }) as typeof fetch);
});
afterEach(() => vi.restoreAllMocks());

const wrap = (ui: React.ReactNode) => render(<MemoryRouter><ChannelProvider>{ui}</ChannelProvider></MemoryRouter>);

describe('LiveTarget (manual Telegram link + key)', () => {
  it('saves the link and key, and never shows the key', async () => {
    const changed = vi.fn();
    render(<LiveTarget channel={channel} onChanged={changed} />);
    expect(screen.getByText(/Automatic/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use link + key' }));
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'rtmps://dc4-1.rtmp.t.me/s/' } });
    const key = screen.getByLabelText('Stream key');
    expect(key).toHaveAttribute('type', 'password');
    fireEvent.change(key, { target: { value: '123:SECRET' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/admin/channels/1001/live-target', body: { url: 'rtmps://dc4-1.rtmp.t.me/s/', key: '123:SECRET' } });
  });

  it('shows the saved link (without the key) and can go back to automatic', async () => {
    const changed = vi.fn();
    render(<LiveTarget channel={{ ...channel, liveRtmpUrl: 'rtmps://dc4-1.rtmp.t.me/s/', liveRtmpKeySet: true }} onChanged={changed} />);
    expect(screen.getByText('rtmps://dc4-1.rtmp.t.me/s/')).toBeInTheDocument();
    expect(screen.getByText(/key saved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to automatic' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/admin/channels/1001/live-target')).toBe(true));
  });

  it('shows the server error inline', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => json({ message: 'The link must start with rtmp://' }, 400));
    render(<LiveTarget channel={channel} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use link + key' }));
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://x.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The link must start with rtmp://');
  });
});

describe('Ads page', () => {
  it('creates an ad and uploads its audio as a raw body with the file type', async () => {
    wrap(<Ads />);
    expect(await screen.findByText('Coffee')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New ad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/admin/ads')?.body).toMatchObject({ name: 'New ad', channelId: null, weight: 1 }));

    const input = screen.getAllByTestId('file-input')[0] as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'spot.mp3', { type: 'audio/mpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/admin/ads/a1/audio', contentType: 'audio/mpeg' }));
  });

  it('toggles an ad off with a PATCH', async () => {
    wrap(<Ads />);
    await screen.findByText('Coffee');
    fireEvent.click(screen.getByLabelText('Enabled Coffee'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/admin/ads/a1', body: { enabled: false } }));
  });
});

describe('Sponsors page', () => {
  it('adds a sponsor with a link, button text and optional dates', async () => {
    wrap(<Sponsors />);
    await screen.findByText('No sponsors yet.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Link'), { target: { value: 'https://acme.example' } });
    fireEvent.change(screen.getByLabelText('Button text'), { target: { value: 'Shop now' } });
    fireEvent.change(screen.getByLabelText('Until'), { target: { value: '2030-01-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ name: 'Acme', url: 'https://acme.example', ctaLabel: 'Shop now', channelId: null }));
    const body = calls.find((c) => c.method === 'POST')?.body as { endsAt: string; startsAt: string | null };
    expect(new Date(body.endsAt).getFullYear()).toBe(2030);
    expect(body.startsAt).toBeNull();
  });
});

describe('Engagement page', () => {
  it('loads the settings, saves changes (allow-list split into tags) and can start a vote', async () => {
    wrap(<Engagement />);
    const every = await screen.findByLabelText(/Play an ad after every N tracks/);
    expect(every).toHaveValue(3);
    fireEvent.change(every, { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/Only offer these tags/), { target: { value: 'rock, #jazz  chill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ adsEveryNTracks: 5, tagVoteEnabled: true, tagVoteAllowlist: ['rock', '#jazz', 'chill'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start a vote now' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/tag-votes/start'))).toBe(true));
  });
});
