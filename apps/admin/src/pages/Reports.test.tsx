import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChannelItem } from '../api';
import { ChannelContext } from '../channel-context';
import { Reports } from './Reports';

const channel: ChannelItem = { id: '1001', publicId: '11111111-1111-4111-8111-111111111111', reference: '@c', title: 'Chan', username: 'c', slug: 'chan', started: true, telegramLiveEnabled: false, liveStatus: 'OFF', liveError: null, liveRtmpUrl: null, liveRtmpKeySet: false, liveTargetRev: 0, ownerAccountId: null };
const report = (plays = 41) => ({
  range: '7d', channel: null, generatedAt: new Date().toISOString(),
  summary: { plays, uniqueTracks: 12, airtimeSeconds: 7200, skipRate: 0.25, errorRate: 0.05, outcomes: { finished: 28, skipped: 10, admin: 0, errors: 2 }, audience: { averageListeners: 4.5, peakListeners: 11, listenerMinutes: 900 } },
  timeseries: { bucket: 'hour', points: [{ t: '2026-01-01T10:00:00Z', plays: 3, errors: 0, averageListeners: 2, peakListeners: 3 }, { t: '2026-01-01T11:00:00Z', plays: 5, errors: 1, averageListeners: 4, peakListeners: 8 }] },
  top: { tracks: [{ id: 'a', title: 'Song A', artist: 'Luna', plays: 9, skips: 2 }], artists: [{ artist: 'Luna', plays: 9 }], hashtags: [{ hashtag: 'rain', plays: 7 }] },
  lyrics: { byStatus: [{ status: 'LYRICS_READY', tracks: 8 }], byLanguage: [{ language: 'fa', tracks: 5 }], failureReasons: [{ reason: 'NOT_FOUND', tracks: 2 }], quality: { average: 0.82, distribution: [{ bucket: '<50%', tracks: 0 }, { bucket: '50-70%', tracks: 1 }, { bucket: '70-90%', tracks: 4 }, { bucket: '90-100%', tracks: 3 }] }, coverage: { withUrl: 10, synced: 8 } },
  library: { channels: [{ id: '1001', title: 'Chan', tracks: 20, playable: 18, disabled: 1, failed: 1, unavailable: 0, totalSeconds: 4000, neverPlayed: 3, plays: 40 }], problemTracks: [{ id: 'p1', title: 'Broken', artist: null, status: 'FAILED', consecutiveFailures: 3, lyricsStatus: 'LYRICS_FAILED', lyricsError: 'NOT_FOUND' }], recentErrors: [{ at: new Date().toISOString(), trackId: 'p1', title: 'Broken', artist: null }] },
});
const health = { process: { uptimeSeconds: 3700, node: 'v22', memoryMb: 120 }, database: { ok: true, latencyMs: 3, sizeMb: 12 }, telegram: { state: 'READY', accountLabel: '+98***' }, queues: { 'lyrics-fetch': { waiting: 1, active: 0, delayed: 0, failed: 2 } }, integrations: { whisper: true, llm: false, audioCache: true }, audioCache: { configured: true, objects: 10, bytes: 5_242_880 }, stations: [{ id: '1001', title: 'Chan', running: true, listeners: 2, live: { enabled: true, status: 'LIVE' } }] };

function setup() {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    urls.push(url);
    const body = url.startsWith('/admin/reports/system') ? health : url.startsWith('/admin/reports') ? report(url.includes('range=30d') ? 99 : 41) : {};
    return { status: 200, ok: true, json: async () => body } as Response;
  });
  render(<MemoryRouter><ChannelContext.Provider value={{ channels: [channel], selected: channel, loading: false, select: () => undefined, reload: () => undefined }}><Reports /></ChannelContext.Provider></MemoryRouter>);
  return urls;
}

describe('<Reports />', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders KPIs, charts, rankings, lyrics quality, library health and system health from the API', async () => {
    setup();
    expect(await screen.findByText('41')).toBeInTheDocument(); // plays
    expect(screen.getByText('2h 0m')).toBeInTheDocument(); // airtime
    expect(screen.getByText('25%')).toBeInTheDocument(); // skip rate
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Plays per period' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Listeners over time' })).toBeInTheDocument();
    expect(screen.getByText(/✕ Failed — 2/)).toBeInTheDocument();
    expect(screen.getByText('#rain')).toBeInTheDocument();
    expect(screen.getByText('Persian')).toBeInTheDocument();
    expect(screen.getByText(/Average quality: 82%/)).toBeInTheDocument();
    expect(screen.getAllByText('✕ NOT_FOUND').length).toBeGreaterThanOrEqual(2); // failure reasons chart + problem tracks table
    expect(await screen.findByText('Database')).toBeInTheDocument();
    expect(screen.getByText(/lyrics-fetch: 1 waiting/)).toBeInTheDocument();
    expect(screen.getByText(/Audio cache: 10 tracks · 5 MB/)).toBeInTheDocument();
  });

  it('changing the period or channel re-queries the server (no client-side filtering)', async () => {
    const urls = setup();
    await screen.findByText('41');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    expect(await screen.findByText('99')).toBeInTheDocument();
    expect(urls.some((u) => u.includes('/admin/reports?range=30d'))).toBe(true);
    fireEvent.change(screen.getByLabelText('report channel'), { target: { value: '1001' } });
    await waitFor(() => expect(urls.some((u) => u.includes('range=30d') && u.includes('channel=1001'))).toBe(true));
  });

  it('every chart has a table alternative', async () => {
    setup();
    await screen.findByText('41');
    expect(screen.getAllByText('View as table').length).toBeGreaterThanOrEqual(3);
  });
});
