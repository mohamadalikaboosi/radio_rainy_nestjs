import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { portalStore } from '../api';
import { CampaignReview } from '../pages/CampaignReview';
import { Platform } from '../pages/Platform';
import { PortalApp } from './PortalApp';

const calls: { url: string; method: string; body?: unknown; auth?: string }[] = [];
const json = (data: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => data }) as Response;
const free = { billingEnabled: false, selfSignupEnabled: true, campaignApprovalRequired: true, pricePerPlayCents: 500, pricePerClickCents: 2000, currency: 'IRT' };
let platform = { ...free };
let campaigns: Record<string, unknown>[] = [];

const campaign = (over: Record<string, unknown> = {}) => ({ id: 'c1', channelId: null, accountId: 'a1', status: 'DRAFT', reviewNote: null, startsAt: null, endsAt: null, maxPlays: null, name: 'Spring', weight: 1, enabled: true, linkUrl: null, ctaLabel: null, hasAudio: true, audioMime: 'audio/mpeg', audioSize: 1000, durationSeconds: 15, hasImage: false, plays: 4, clicks: 1, lastPlayedAt: null, createdAt: new Date().toISOString(), ...over });

beforeEach(() => {
  calls.length = 0;
  platform = { ...free };
  campaigns = [campaign()];
  localStorage.clear();
  portalStore.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split('?')[0] ?? '';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, auth: headers.Authorization });
    if (url === '/portal/auth/config') return json(platform);
    if (url === '/portal/auth/login') return json({ token: 'portal-token', email: 'a@b.co' });
    if (url === '/portal/auth/signup') return json({ token: 'portal-token', email: 'a@b.co' });
    if (url === '/portal/me') return json({ account: { id: 'a1', name: 'Acme', status: 'ACTIVE', creditCents: 100 }, email: 'a@b.co', platform });
    if (url === '/portal/stations/public') return json([{ id: '1001', slug: 'chan', title: 'Chan' }]);
    if (url === '/portal/campaigns' && method === 'GET') return json(campaigns);
    if (url === '/admin/platform' && method === 'GET') return json({ ...platform, maxCampaignsPerAccount: 0 });
    if (url === '/admin/campaigns' && method === 'GET') return json([{ ...campaign({ status: 'PENDING' }), accountName: 'Acme' }]);
    return json({ ok: true });
  }) as typeof fetch);
});
afterEach(() => vi.restoreAllMocks());

describe('customer portal', () => {
  it('shows the FREE note, lets a new customer sign up, and keeps the token in its own store', async () => {
    render(<MemoryRouter initialEntries={['/portal']}><Routes><Route path="/portal/*" element={<PortalApp />} /></Routes></MemoryRouter>);
    expect(await screen.findByText(/Free during launch/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Sign up' }));
    fireEvent.change(screen.getByLabelText('Company / account name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'long-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Campaigns', { selector: 'a' })).toBeInTheDocument();
    expect(portalStore.get()).toBe('portal-token');
    expect(localStorage.getItem('rr_admin_token')).toBeNull(); // never mixed with the operator session
    expect(calls.find((c) => c.url === '/portal/auth/signup')?.body).toEqual({ accountName: 'Acme', email: 'a@b.co', password: 'long-password-1' });
  });

  it('hides sign-up when the operator closed it', async () => {
    platform = { ...free, selfSignupEnabled: false };
    render(<MemoryRouter><PortalApp /></MemoryRouter>);
    await screen.findByRole('tab', { name: 'Sign in' });
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Sign up' })).not.toBeInTheDocument());
  });

  describe('signed in', () => {
    beforeEach(() => portalStore.set('portal-token'));

    it('lists campaigns with their status, stats and the actions that fit the status; sends the portal token', async () => {
      render(<MemoryRouter initialEntries={['/portal']}><Routes><Route path="/portal/*" element={<PortalApp />} /></Routes></MemoryRouter>);
      expect(await screen.findByText('Spring')).toBeInTheDocument();
      expect(screen.getByText('draft')).toBeInTheDocument();
      expect(screen.getByText(/4 plays/)).toBeInTheDocument();
      expect(calls.find((c) => c.url === '/portal/campaigns')?.auth).toBe('Bearer portal-token');
      fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
      await waitFor(() => expect(calls.some((c) => c.url === '/portal/campaigns/c1/submit' && c.method === 'POST')).toBe(true));
    });

    it('shows the reviewer\'s reason for a rejected campaign, and that an approved one needs credit when billing is on', async () => {
      platform = { ...free, billingEnabled: true, pricePerPlayCents: 500 }; // credit is 100 < 500
      campaigns = [campaign({ id: 'r', name: 'Bad', status: 'REJECTED', reviewNote: 'Audio too loud' }), campaign({ id: 'p', name: 'Good', status: 'APPROVED' })];
      render(<MemoryRouter initialEntries={['/portal']}><Routes><Route path="/portal/*" element={<PortalApp />} /></Routes></MemoryRouter>);
      expect(await screen.findByText('Audio too loud')).toBeInTheDocument();
      expect(await screen.findByText('Not airing: add credit')).toBeInTheDocument();
      expect(screen.getByText(/pay-per-use/)).toBeInTheDocument();
    });

    it('creates a campaign aimed at a station, with dates and a play cap', async () => {
      render(<MemoryRouter initialEntries={['/portal']}><Routes><Route path="/portal/*" element={<PortalApp />} /></Routes></MemoryRouter>);
      await screen.findByText('Spring');
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Summer' } });
      await screen.findByRole('option', { name: 'Chan' });
      fireEvent.change(screen.getByLabelText('Station'), { target: { value: '1001' } });
      fireEvent.change(screen.getByLabelText('Max plays'), { target: { value: '50' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/portal/campaigns')?.body).toMatchObject({ name: 'Summer', channelId: '1001', maxPlays: 50, linkUrl: null }));
    });
  });
});

describe('operator pages', () => {
  it('Platform: billing is OFF by default and can be switched on with prices', async () => {
    render(<Platform />);
    expect(await screen.findByText('Free mode (billing OFF)')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Enable billing/));
    fireEvent.change(screen.getByLabelText('Price per ad play'), { target: { value: '750' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT' && c.url === '/admin/platform')?.body).toMatchObject({ billingEnabled: true, pricePerPlayCents: 750, selfSignupEnabled: true }));
  });

  it('Campaign review: approve, and reject only with a reason', async () => {
    render(<CampaignReview />);
    expect(await screen.findByText('Spring')).toBeInTheDocument();
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Too loud' } });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);
    await waitFor(() => expect(calls.find((c) => c.url === '/admin/campaigns/c1/reject')?.body).toEqual({ note: 'Too loud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/admin/campaigns/c1/approve')).toBe(true));
  });
});
