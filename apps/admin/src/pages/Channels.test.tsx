import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChannelItem } from '../api';
import { ChannelContext } from '../channel-context';
import { Channels } from './Channels';
import { Settings } from './Settings';

const ch = (over: Partial<ChannelItem> = {}): ChannelItem => ({ id: '1001', reference: '@chan', title: 'Chan', username: 'chan', slug: 'chan', started: false, telegramLiveEnabled: false, liveStatus: 'OFF', liveError: null, ...over });

function mock(handlers: Record<string, (init: RequestInit) => unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
    const h = handlers[key];
    if (!h) return { status: 404, ok: false, json: async () => ({ message: `unmocked ${key}` }) } as Response;
    const body = h(init ?? {});
    const status = typeof body === 'object' && body !== null && '__status' in body ? (body as { __status: number }).__status : 200;
    return { status, ok: status < 400, json: async () => body } as Response;
  });
}
const provide = (channels: ChannelItem[], reload = vi.fn(), select = vi.fn()) => (
  <ChannelContext.Provider value={{ channels, selected: channels[0] ?? null, loading: false, select, reload }}><Channels /></ChannelContext.Provider>
);

describe('<Channels />', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds a channel by reference and selects it', async () => {
    let body: unknown;
    const select = vi.fn();
    mock({ 'POST /admin/channels': (i) => { body = JSON.parse(String(i.body)); return ch({ id: '2002', title: 'Second' }); } });
    render(provide([], vi.fn(), select));
    fireEvent.change(screen.getByLabelText(/Channel \(@username/), { target: { value: '@second' } });
    fireEvent.click(screen.getByText('Add channel'));
    await waitFor(() => expect(select).toHaveBeenCalledWith('2002'));
    expect(body).toEqual({ reference: '@second' });
  });

  it('shows the server error when Telegram cannot resolve the channel', async () => {
    mock({ 'POST /admin/channels': () => ({ __status: 400, message: 'Telegram could not resolve this channel', telegramError: 'USERNAME_NOT_OCCUPIED' }) });
    render(provide([]));
    fireEvent.change(screen.getByLabelText(/Channel \(@username/), { target: { value: '@nope' } });
    fireEvent.click(screen.getByText('Add channel'));
    expect(await screen.findByRole('alert')).toHaveTextContent('USERNAME_NOT_OCCUPIED');
  });

  it('start/stop, live toggle and live errors are wired to the API', async () => {
    const calls: string[] = [];
    mock({
      'POST /admin/channels/1001/start': () => { calls.push('start'); return ch({ started: true }); },
      'PUT /admin/channels/1001/live': (i) => { calls.push(`live:${String(i.body)}`); return ch(); },
    });
    const reload = vi.fn();
    render(provide([ch({ telegramLiveEnabled: true, liveStatus: 'ERROR', liveError: 'CHAT_ADMIN_REQUIRED' })], reload));
    expect(screen.getByText('CHAT_ADMIN_REQUIRED')).toBeInTheDocument();
    fireEvent.click(screen.getByText('▶ Start'));
    await waitFor(() => expect(calls).toContain('start'));
    fireEvent.click(screen.getByLabelText('live in Telegram for Chan'));
    await waitFor(() => expect(calls).toContain('live:{"enabled":false}'));
  });

  it('removing a channel asks for confirmation and can delete its tracks', async () => {
    const del = vi.fn(() => ({}));
    mock({ 'DELETE /admin/channels/1001': del });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(provide([ch()]));
    fireEvent.click(screen.getByText('Remove'));
    expect(del).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(del).toHaveBeenCalled());
  });
});

describe('<Settings />', () => {
  afterEach(() => vi.restoreAllMocks());
  const view = { telegram: { apiId: null, apiHashSet: false, source: 'none' }, whisper: { url: '', model: 'whisper-1', language: '', sampleRate: 48000, timeoutSeconds: 900, apiKeySet: false, enabled: false, source: 'none' }, llm: { enabled: false, url: '', model: '', apiKeySet: false }, storage: { enabled: false, endpoint: '', port: 9000, useSsl: false, bucket: 'radio-rainy-audio', keysSet: false, active: false, source: 'none' } };

  it('saves Telegram API credentials (hash is write-only and cleared from the form)', async () => {
    let body: Record<string, unknown> | null = null;
    mock({ 'GET /admin/settings': () => view, 'PUT /admin/settings/telegram': (i) => { body = JSON.parse(String(i.body)); return view; } });
    render(<Settings />);
    fireEvent.change(await screen.findByLabelText('API ID'), { target: { value: '12345' } });
    const hash = screen.getByLabelText(/API hash/) as HTMLInputElement;
    fireEvent.change(hash, { target: { value: 'my-secret-hash-1234' } });
    fireEvent.click(screen.getAllByText('Save')[0] as HTMLElement);
    await waitFor(() => expect(body).toEqual({ apiId: 12345, apiHash: 'my-secret-hash-1234' }));
    await waitFor(() => expect(hash.value).toBe(''));
  });

  it('Whisper defaults to 48 kHz and an empty URL turns AI sync off', async () => {
    let body: Record<string, unknown> | null = null;
    mock({ 'GET /admin/settings': () => view, 'PUT /admin/settings/whisper': (i) => { body = JSON.parse(String(i.body)); return view; } });
    render(<Settings />);
    fireEvent.change(await screen.findByLabelText(/Endpoint URL/), { target: { value: 'http://localhost:8000/v1/audio/transcriptions' } });
    fireEvent.click(screen.getAllByText('Save')[2] as HTMLElement); // Telegram, Audio storage, Whisper
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ url: 'http://localhost:8000/v1/audio/transcriptions', sampleRate: 48000, model: 'whisper-1' });
    expect(body).not.toHaveProperty('apiKey');
  });

  it('audio storage: saves keys write-only and reports the connection test result', async () => {
    let body: Record<string, unknown> | null = null;
    mock({
      'GET /admin/settings': () => view,
      'PUT /admin/settings/storage': (i) => { body = JSON.parse(String(i.body)); return view; },
      'POST /admin/settings/storage/test': () => ({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:9000' }),
    });
    render(<Settings />);
    fireEvent.click(await screen.findByLabelText('Enable audio cache'));
    fireEvent.change(screen.getByLabelText(/Endpoint \(host/), { target: { value: 'localhost:9000' } });
    fireEvent.change(screen.getByLabelText(/Access key/), { target: { value: 'radiorainy' } });
    fireEvent.change(screen.getByLabelText(/Secret key/), { target: { value: 'radiorainy-secret' } });
    fireEvent.click(screen.getAllByText('Save')[1] as HTMLElement);
    await waitFor(() => expect(body).toMatchObject({ enabled: true, endpoint: 'localhost:9000', accessKey: 'radiorainy', secretKey: 'radiorainy-secret', bucket: 'radio-rainy-audio' }));
    fireEvent.click(screen.getByText('Test connection'));
    expect(await screen.findByRole('alert')).toHaveTextContent('ECONNREFUSED');
    expect((screen.getByLabelText(/Secret key/) as HTMLInputElement).value).toBe('');
  });
});
