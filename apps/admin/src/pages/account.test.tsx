import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { authStore } from '../api';
import { ChangePasswordForm } from './Account';

const json = (data: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => data }) as Response;

describe('<ChangePasswordForm />', () => {
  beforeEach(() => authStore.set('old-token'));
  afterEach(() => {
    vi.restoreAllMocks();
    authStore.clear();
  });

  it('forced mode explains why, pre-fills the default password, and swaps the token when done', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ token: 'new-token', expiresIn: 3600 }));
    const done = vi.fn();
    render(<ChangePasswordForm forced onDone={done} />);
    expect(screen.getByText(/default password/)).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toHaveValue('admin');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-real-password' } });
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'a-real-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(authStore.get()).toBe('new-token');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/admin/auth/change-password');
    expect(JSON.parse(String(init.body))).toEqual({ currentPassword: 'admin', newPassword: 'a-real-password' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer old-token');
  });

  it('refuses mismatching passwords without calling the server', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<ChangePasswordForm />);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'whatever-1' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'first-password' } });
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'second-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authStore.get()).toBe('old-token');
  });

  it('shows the server message (wrong current password) and keeps the old token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ message: 'The current password is wrong' }, 400));
    render(<ChangePasswordForm />);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'nope-nope' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-real-password' } });
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'a-real-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The current password is wrong');
    expect(authStore.get()).toBe('old-token'); // a typo must never sign the admin out
  });
});
