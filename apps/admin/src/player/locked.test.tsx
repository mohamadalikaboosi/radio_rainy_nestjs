import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { DirectLink } from './DirectLink';
import { Player } from './Player';

const json = (data: unknown): Response => ({ ok: true, status: 200, json: async () => data }) as Response;

describe('a station\'s own page (/s/:slug) plays only that station', () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0] ?? '';
      calls.push(url);
      if (url === '/radio/stations')
        return json([
          { slug: 'alpha', title: 'Alpha FM', live: true, transport: 'HTTP' },
          { slug: 'beta', title: 'Beta FM', live: true, transport: 'HTTP' },
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
  const wrap = (ui: React.ReactElement) => render(<MemoryRouter><I18nProvider>{ui}</I18nProvider></MemoryRouter>);

  it('shows the station name, has no station picker and never touches another station', async () => {
    wrap(<Player lockedSlug="beta" />);
    expect(await screen.findByText(/Beta FM/)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c === '/radio/beta/current')).toBe(true));
    expect(screen.queryByLabelText('Station')).toBeNull();
    expect(calls.some((c) => c.startsWith('/radio/alpha/'))).toBe(false);
  });

  it('the normal page still offers the picker', async () => {
    wrap(<Player />);
    expect(await screen.findByLabelText('Station')).toBeInTheDocument();
  });

  it('an unknown station says so instead of playing another one', async () => {
    wrap(<Player lockedSlug="nope" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not exist/i);
    expect(calls.some((c) => c.startsWith('/radio/alpha/') || c.startsWith('/radio/beta/'))).toBe(false);
  });

  it('DirectLink shows the /s/<slug> address', () => {
    wrap(<DirectLink slug="alpha" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/s/alpha');
    expect(screen.getByText(`${window.location.origin}/s/alpha`)).toBeInTheDocument();
  });
});
