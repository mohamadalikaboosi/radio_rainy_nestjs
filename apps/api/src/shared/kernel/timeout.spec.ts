import { TimeoutError, withTimeout } from './timeout';

describe('withTimeout', () => {
  it('passes through results and errors', async () => {
    await expect(withTimeout(Promise.resolve(5), 100, 'x')).resolves.toBe(5);
    await expect(withTimeout(Promise.reject(new Error('boom')), 100, 'x')).rejects.toThrow('boom');
  });
  it('rejects with TimeoutError when the work hangs', async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, 'telegram connect')).rejects.toBeInstanceOf(TimeoutError);
  });
});
