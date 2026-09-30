import { ApiError, UNAUTHORIZED_EVENT, api, authStore } from './api';

const mockFetch = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status, ok: status < 400, json: async () => body } as Response);

describe('api client', () => {
  beforeEach(() => authStore.clear());
  afterEach(() => vi.restoreAllMocks());

  it('sends the bearer token and JSON body', async () => {
    authStore.set('tok');
    const f = mockFetch(200, { ok: true });
    await api('/admin/x', { method: 'POST', body: { a: 1 }, query: { q: 'hi', empty: '' } });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/admin/x?q=hi');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.body).toBe('{"a":1}');
  });

  it('clears the token and notifies on 401 (except the login call)', async () => {
    authStore.set('tok');
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);
    mockFetch(401, { message: 'Invalid or expired token' });
    await expect(api('/admin/dashboard')).rejects.toBeInstanceOf(ApiError);
    expect(authStore.get()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    authStore.set('tok');
    await expect(api('/admin/auth/login', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(authStore.get()).toBe('tok');
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  });

  it('surfaces server error bodies', async () => {
    mockFetch(409, { message: 'Radio configuration was changed by someone else', currentVersion: 4 });
    await expect(api('/admin/radio/config', { method: 'PUT', body: {} })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('changed by someone else') });
  });

  it('works even if localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    authStore.set('mem');
    expect(authStore.get()).toBe('mem');
  });
});
