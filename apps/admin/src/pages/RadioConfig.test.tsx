import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChannelItem, ConfigView } from '../api';
import { ChannelContext } from '../channel-context';
import { RadioConfig, draftFrom, toUpdateBody } from './RadioConfig';

const config: ConfigView = {
  version: 7, mode: 'GLOBAL_RANDOM', hashtagMatchMode: 'ANY', recentTrackWindow: 10, fallbackToGlobal: true, enabled: true, hashtags: [], rules: [],
};
const tags = { items: [{ hashtagId: '1', value: 'Rain', normalized: 'rain', trackCount: 3, playableCount: 3, failedLyricsCount: 0, plays: 0, lastPlayedAt: null, createdAt: '' }, { hashtagId: '2', value: 'night', normalized: 'night', trackCount: 2, playableCount: 2, failedLyricsCount: 0, plays: 0, lastPlayedAt: null, createdAt: '' }] };

function mockApi(handlers: Record<string, (init: RequestInit) => unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
    const h = handlers[key];
    if (!h) return { status: 404, ok: false, json: async () => ({ message: `unmocked ${key}` }) } as Response;
    const body = h(init ?? {});
    const status = typeof body === 'object' && body !== null && '__status' in body ? (body as { __status: number }).__status : 200;
    return { status, ok: status < 400, json: async () => body } as Response;
  });
}

const channel: ChannelItem = { id: '1001', reference: '@chan', title: 'Chan', username: 'chan', slug: 'chan', started: true, telegramLiveEnabled: false, liveStatus: 'OFF', liveError: null, liveRtmpUrl: null, liveRtmpKeySet: false, liveTargetRev: 0 };
const withChannel = (ui: React.ReactElement) => (
  <MemoryRouter>
    <ChannelContext.Provider value={{ channels: [channel], selected: channel, loading: false, select: () => undefined, reload: () => undefined }}>{ui}</ChannelContext.Provider>
  </MemoryRouter>
);

describe('toUpdateBody', () => {
  it('serializes the draft; selection stays server-side', () => {
    const d = { ...draftFrom(config), mode: 'HASHTAG_RANDOM' as const, selected: ['rain', 'night'], weights: { rain: 50 } };
    expect(toUpdateBody(d, 7, 'IMMEDIATE')).toMatchObject({
      mode: 'HASHTAG_RANDOM', expectedVersion: 7, apply: 'IMMEDIATE', hashtags: [{ hashtag: 'rain', weight: 50 }, { hashtag: 'night', weight: 1 }],
    });
  });
});

describe('<RadioConfig />', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows hashtags for Hashtag Random and saves with the current version for the next track', async () => {
    let put: Record<string, unknown> | null = null;
    mockApi({
      'GET /admin/channels/1001/radio/config': () => config,
      'GET /admin/hashtags': () => tags,
      'PUT /admin/channels/1001/radio/config': (init) => { put = JSON.parse(String(init.body)); return { ...config, version: 8 }; },
    });
    render(withChannel(<RadioConfig />));
    fireEvent.click(await screen.findByLabelText(/Hashtag Random/));
    fireEvent.click(await screen.findByLabelText(/#Rain/));
    fireEvent.click(screen.getByLabelText(/ALL selected hashtags/));
    fireEvent.click(screen.getByText('Apply for next track'));
    await waitFor(() => expect(put).not.toBeNull());
    expect(put).toMatchObject({ mode: 'HASHTAG_RANDOM', hashtagMatchMode: 'ALL', expectedVersion: 7, apply: 'NEXT_TRACK', hashtags: [{ hashtag: 'rain', weight: 1 }] });
    expect(await screen.findByText(/Saved as version 8/)).toBeInTheDocument();
  });

  it('"Apply immediately" asks for confirmation first', async () => {
    const put = vi.fn(() => ({ ...config, version: 8 }));
    mockApi({ 'GET /admin/channels/1001/radio/config': () => config, 'GET /admin/hashtags': () => tags, 'PUT /admin/channels/1001/radio/config': put });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(withChannel(<RadioConfig />));
    fireEvent.click(await screen.findByText('Apply immediately'));
    expect(confirm).toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('Apply immediately'));
    await waitFor(() => expect(put).toHaveBeenCalled());
  });

  it('shows a conflict banner when another admin changed the config (409)', async () => {
    mockApi({
      'GET /admin/channels/1001/radio/config': () => config,
      'GET /admin/hashtags': () => tags,
      'PUT /admin/channels/1001/radio/config': () => ({ __status: 409, message: 'Radio configuration was changed by someone else' }),
    });
    render(withChannel(<RadioConfig />));
    fireEvent.click(await screen.findByText('Apply for next track'));
    expect(await screen.findByText(/Another admin changed the configuration/)).toBeInTheDocument();
  });

  it('preview calls the backend engine with the draft (no client-side selection)', async () => {
    let body: Record<string, unknown> | null = null;
    mockApi({
      'GET /admin/channels/1001/radio/config': () => config,
      'GET /admin/hashtags': () => tags,
      'POST /admin/channels/1001/radio/preview': (init) => { body = JSON.parse(String(init.body)); return { seed: 42, mode: 'GLOBAL_RANDOM', eligibleCount: 5, tracks: [{ id: 'a', title: 'Song A', artist: 'X', hashtags: ['rain'], reason: 'GLOBAL_RANDOM' }] }; },
    });
    render(withChannel(<RadioConfig />));
    fireEvent.click(await screen.findByText('Preview selection'));
    expect(await screen.findByText(/Song A/)).toBeInTheDocument();
    expect(body).toMatchObject({ mode: 'GLOBAL_RANDOM', limit: 10 });
    expect(screen.getByText(/eligible tracks/)).toHaveTextContent('5');
  });
});
