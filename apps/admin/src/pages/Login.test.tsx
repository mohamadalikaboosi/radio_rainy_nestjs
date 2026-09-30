import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { authStore } from '../api';
import { Login } from './Login';

describe('<Login />', () => {
  beforeEach(() => authStore.clear());
  afterEach(() => vi.restoreAllMocks());

  it('stores the token and calls back on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 200, ok: true, json: async () => ({ token: 'abc' }) } as Response);
    const done = vi.fn();
    render(<Login onLoggedIn={done} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(authStore.get()).toBe('abc');
  });

  it('shows the error and stores nothing on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ status: 401, ok: false, json: async () => ({ message: 'Invalid credentials' }) } as Response);
    render(<Login onLoggedIn={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
    expect(authStore.get()).toBeNull();
  });
});
