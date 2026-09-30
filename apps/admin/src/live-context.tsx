import { ReactNode, createContext, useContext, useMemo } from 'react';
import { LiveStation, api } from './api';
import { useAsync } from './hooks';

interface LiveCtx {
  stations: LiveStation[];
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export const LiveContext = createContext<LiveCtx>({ stations: [], error: null, loading: false, refresh: () => undefined });

/** One shared 1.5 s poll of what is on air: feeds the Live control page and the top bar. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const live = useAsync(() => api<{ stations: LiveStation[] }>('/admin/live'), [], 1500);
  const value = useMemo(() => ({ stations: live.data?.stations ?? [], error: live.error, loading: live.loading && !live.data, refresh: live.reload }), [live.data, live.error, live.loading, live.reload]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = (): LiveCtx => useContext(LiveContext);
