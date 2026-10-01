import { Logger } from '@nestjs/common';
import { TelegramFloodWaitError } from './ports/telegram.types';

const logger = new Logger('FloodWait');

/** Extracts N from GramJS FloodWaitError (`.seconds`) or a "FLOOD_WAIT_N" message; undefined if not a flood error. */
export function floodSeconds(err: unknown): number | undefined {
  if (err instanceof TelegramFloodWaitError) return err.retryAfterSeconds;
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { seconds?: unknown; errorMessage?: unknown; message?: unknown };
  if (typeof e.seconds === 'number' && /FloodWait/i.test(String((err as { constructor?: { name?: string } }).constructor?.name))) return e.seconds;
  const text = `${String(e.errorMessage ?? '')} ${String(e.message ?? '')}`;
  const m = /FLOOD_WAIT_?(\d+)/i.exec(text) ?? /wait of (\d+) seconds/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

export interface FloodWaitOptions {
  /** Waits up to this many seconds inline; longer waits are surfaced as TelegramFloodWaitError for the job queue to delay. */
  maxInlineSeconds: number;
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
}

const defaults: FloodWaitOptions = {
  maxInlineSeconds: 30,
  maxAttempts: 3,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function withFloodWait<T>(op: string, fn: () => Promise<T>, options: Partial<FloodWaitOptions> = {}): Promise<T> {
  const opt = { ...defaults, ...options };
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const secs = floodSeconds(err);
      if (secs === undefined) throw err;
      if (secs > opt.maxInlineSeconds || attempt >= opt.maxAttempts) throw new TelegramFloodWaitError(secs);
      logger.warn({ msg: 'telegram flood wait', op, seconds: secs, attempt });
      await opt.sleep((secs + 1) * 1000 + Math.floor(Math.random() * 500));
    }
  }
}
