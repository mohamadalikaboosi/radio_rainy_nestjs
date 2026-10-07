import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { DirectLink } from './DirectLink';
import { Player } from './Player';
import { StationPage } from './StationPage';

const json = (data: unknown): Response => ({ ok: true, status: 200, json: async () => data }) as Response;
const ALPHA = '0a1b2c3d-0000-4000-8000-00000000000a';
const BETA = '0a1b2c3d-0000-4000-8000-00000000000b';

describe("a station's own page (/<uuid>) plays only that station", () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0] ?? '';
      calls.push(url);
      if (url === '/radio/stations')
        return json([
          { publicId: ALPHA, slug: 'alpha', title: 'Alpha FM', live: true, transport: 'HTTP' },
          { publicId: BETA, slug: 'beta', title: 'Beta FM', live: true, transport: 'HTTP' },
        ]);
      if (url.endsWith('/current')) return json({ status: 'PLAYING', trackId: 't', title: 'Song', artist: 'A', duration: 240, startedAt: new Date().toISOString(), serverTime: new Date().toISOString() });
      if (url.endsWith('/sponsors')) return json([]);
      return json({ status: 'NONE', serverTime: new Date().toISOString() });
    }) as typeof fetch);
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const at = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider>
          <Routes>
            <Route path="/" element={<p>landing</p>} />
            <Route path="/:publicId" element={<StationPage />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

  it('the UUID resolves to its station: its name, no station picker, never touches another station', async () => {
    at(`/${BETA}`);
    expect((await screen.findAllByText('Beta FM')).length).toBeGreaterThan(0); // header + the record label
    await waitFor(() => expect(calls).toContain('/radio/beta/current'));
    expect(screen.queryByLabelText('Station')).toBeNull();
    expect(calls.some((c) => c.startsWith('/radio/alpha/'))).toBe(false);
  });

  it('an unknown UUID says so and plays nothing', async () => {
    at('/0a1b2c3d-0000-4000-8000-0000000000ff');
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not exist/i);
    expect(calls.some((c) => c.startsWith('/radio/alpha/') || c.startsWith('/radio/beta/'))).toBe(false);
  });

  it('something that is not a UUID is not a station address: back to the landing page', async () => {
    at('/rainy-postrock');
    expect(await screen.findByText('landing')).toBeInTheDocument();
  });

  it('the normal player still offers the picker', async () => {
    render(<MemoryRouter><I18nProvider><Player /></I18nProvider></MemoryRouter>);
    expect(await screen.findByLabelText('Station')).toBeInTheDocument();
  });

  it('DirectLink shows the permanent /<uuid> address', () => {
    render(<I18nProvider><DirectLink publicId={ALPHA} /></I18nProvider>);
    expect(screen.getByRole('link')).toHaveAttribute('href', `/${ALPHA}`);
    expect(screen.getByText(`${window.location.origin}/${ALPHA}`)).toBeInTheDocument();
  });
});
