import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ChannelItem, api } from './api';
import { useAsync } from './hooks';

const KEY = 'rr_selected_channel';

interface ChannelCtx {
  channels: ChannelItem[];
  selected: ChannelItem | null;
  loading: boolean;
  select: (id: string) => void;
  reload: () => void;
}

export const ChannelContext = createContext<ChannelCtx>({ channels: [], selected: null, loading: false, select: () => undefined, reload: () => undefined });

function readSaved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Every station-specific page (config, rules, history, dashboard) works on the channel chosen in the top bar. */
export function ChannelProvider({ children }: { children: ReactNode }) {
  const list = useAsync(() => api<ChannelItem[]>('/admin/channels'), [], 5000);
  const [savedId, setSaved] = useState<string | null>(readSaved);
  const channels = list.data ?? [];
  const selected = channels.find((c) => c.id === savedId) ?? channels[0] ?? null;

  const select = useCallback((id: string) => {
    setSaved(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* selection still works for this session */
    }
  }, []);

  useEffect(() => {
    if (savedId && list.data && !list.data.some((c) => c.id === savedId)) setSaved(null);
  }, [list.data, savedId]);

  const value = useMemo(() => ({ channels, selected, loading: list.loading && !list.data, select, reload: list.reload }), [channels, selected, list.loading, list.data, select, list.reload]);
  return <ChannelContext.Provider value={value}>{children}</ChannelContext.Provider>;
}

export const useChannels = (): ChannelCtx => useContext(ChannelContext);

/** Path of a station-scoped radio endpoint, e.g. radioPath('1001', 'config'). */
export const radioPath = (channelId: string, tail: string): string => `/admin/channels/${channelId}/radio/${tail}`;

export function NeedChannel({ children }: { children: (channel: ChannelItem) => ReactNode }) {
  const { selected, loading } = useChannels();
  if (selected) return <>{children(selected)}</>;
  return <p className="muted">{loading ? 'Loading…' : 'No channel yet. Add one on the Channels page first.'}</p>;
}
