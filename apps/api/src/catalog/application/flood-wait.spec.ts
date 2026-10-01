import { floodSeconds, withFloodWait } from './flood-wait';
import { TelegramFloodWaitError } from './ports/telegram.types';

const noSleep = { sleep: async () => undefined };

describe('withFloodWait', () => {
  it('parses flood errors', () => {
    expect(floodSeconds(new Error('A wait of 12 seconds is required (FLOOD_WAIT_12)'))).toBe(12);
    expect(floodSeconds(new Error('boom'))).toBeUndefined();
  });
  it('sleeps and retries short waits', async () => {
    let n = 0;
    const sleep = jest.fn(async () => undefined);
    const r = await withFloodWait(
      'x',
      async () => {
        if (++n < 2) throw new Error('FLOOD_WAIT_3');
        return 'ok';
      },
      { sleep },
    );
    expect(r).toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it('surfaces long waits to the caller instead of blocking', async () => {
    await expect(withFloodWait('x', async () => Promise.reject(new Error('FLOOD_WAIT_500')), noSleep)).rejects.toMatchObject({
      retryAfterSeconds: 500,
    });
  });
  it('gives up after max attempts and passes other errors through', async () => {
    await expect(withFloodWait('x', async () => Promise.reject(new Error('FLOOD_WAIT_1')), noSleep)).rejects.toBeInstanceOf(TelegramFloodWaitError);
    await expect(withFloodWait('x', async () => Promise.reject(new Error('other')), noSleep)).rejects.toThrow('other');
  });
});
