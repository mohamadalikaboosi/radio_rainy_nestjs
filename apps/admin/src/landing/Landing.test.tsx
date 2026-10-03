import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { Landing } from './Landing';

const json = (data: unknown): Response => ({ ok: true, status: 200, json: async () => data }) as Response;

describe('<Landing />', () => {
  let stations: unknown[];
  beforeEach(() => {
    stations = [
      { slug: 'alpha', title: 'Alpha FM', live: true },
      { slug: 'beta', title: 'Beta FM', live: false },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0] ?? '';
      if (url === '/radio/stations') return json(stations);
      if (url === '/radio/alpha/current') return json({ status: 'PLAYING', title: 'Hamkharabeh', artist: 'Sadegh' });
      return json({ status: 'NONE' });
    }) as typeof fetch);
  });
  afterEach(() => vi.restoreAllMocks());
  const wrap = () => render(<I18nProvider><Landing /></I18nProvider>);

  it('sells the product and links to the player, the panel and the advertiser portal', async () => {
    wrap();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/real radio/i);
    expect(screen.getAllByRole('link', { name: /operator panel/i })[0]).toHaveAttribute('href', '/panel');
    expect(screen.getAllByRole('link', { name: /advertise/i })[0]).toHaveAttribute('href', '/partner');
    for (const f of ['Truly live', 'Live inside Telegram', 'Synchronized lyrics', 'Data saver']) expect(screen.getByText(f)).toBeInTheDocument();
  });

  it('lists only stations that are on air, with what they play now, and "Listen live" opens the first one', async () => {
    wrap();
    expect(await screen.findByText('Alpha FM')).toBeInTheDocument();
    expect(screen.queryByText('Beta FM')).toBeNull();
    expect(await screen.findByText('Hamkharabeh — Sadegh')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Alpha FM/ })).toHaveAttribute('href', '/s/alpha');
    await waitFor(() => expect(screen.getAllByRole('link', { name: /listen live/i })[0]).toHaveAttribute('href', '/s/alpha'));
  });

  it('with nothing on air it says so and "Listen live" goes to the player', async () => {
    stations = [];
    wrap();
    expect(await screen.findByText(/No station is on air yet/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /listen live/i })[0]).toHaveAttribute('href', '/listen');
  });
});
