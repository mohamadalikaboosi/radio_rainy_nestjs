import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Loads on mount and whenever `deps` change; optional polling. Ignores stale responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[], pollMs?: number): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const my = ++seq.current;
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const r = await fnRef.current();
        if (!cancelled && my === seq.current) {
          setData(r);
          setError(null);
        }
      } catch (e) {
        if (!cancelled && my === seq.current) setError(errorMessage(e));
      } finally {
        if (!cancelled && my === seq.current) setLoading(false);
      }
    };
    setLoading(true);
    void run();
    const timer = pollMs ? setInterval(() => void run(), pollMs) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { unknown?: string[]; telegramError?: string } | null;
    if (b?.unknown?.length) return `${e.message}: ${b.unknown.join(', ')}`;
    if (b?.telegramError) return `${e.message} (${b.telegramError})`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
