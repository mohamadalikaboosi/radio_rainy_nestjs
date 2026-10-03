import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { VoteView } from '../api';
import { useAsync } from '../hooks';
import type { SponsorView } from './helpers';
import { voterId } from './helpers';
import { useRealtime } from './useRealtime';

export interface Station {
  slug: string;
  title: string;
  live: boolean;
  transport?: 'HTTP' | 'WEBSOCKET';
  /** The station offers a lighter data-saver stream (`?quality=low`). */
  lowQuality?: boolean;
}

export interface AdOnAir {
  id: string;
  name: string;
  startedAt: string | null;
  duration: number | null;
  linkUrl: string | null;
  ctaLabel: string | null;
  imageUrl: string | null;
}

export interface Current {
  status: string;
  trackId?: string;
  title?: string;
  artist?: string | null;
  album?: string | null;
  startedAt?: string;
  duration?: number | null;
  position?: number;
  serverTime?: string;
  ad?: AdOnAir;
}

export interface LyricLine {
  start: number;
  end: number;
  text: string;
}
export interface Lyrics {
  trackId: string;
  status: string;
  lines?: LyricLine[];
  plain?: string[];
}
export interface ActiveLine {
  index: number;
  text: string | null;
  status: string;
  trackId?: string;
}

/** All public-API state of one station: what is on air, lyrics, the vote and sponsors. Nothing here needs a login. */
export function useRadio(lockedSlug?: string) {
  const stations = useAsync(() => api<Station[]>('/radio/stations'), [], 10_000);
  const [picked, setPicked] = useState<string | null>(null);
  // a direct station link (/s/:slug) is locked to that one station: nothing can switch it
  const slug = lockedSlug ?? picked ?? stations.data?.find((s) => s.live)?.slug ?? stations.data?.[0]?.slug ?? null;
  const base = slug ? `/radio/${slug}` : null;

  // The live socket pushes everything; polling only runs as a safety net (slowly while connected, every second without a socket).
  const rt = useRealtime(slug);
  const current = useAsync(() => (base ? api<Current>(`${base}/current`) : Promise.resolve(null)), [base, rt.connected], rt.connected ? 15_000 : 1000);
  const fetchedAt = useRef(Date.now());
  useEffect(() => {
    if (current.data) fetchedAt.current = Date.now();
  }, [current.data]);
  const pushed = rt.connected && rt.current !== null;
  const currentData = pushed ? rt.current : current.data;
  if (pushed) fetchedAt.current = Math.max(fetchedAt.current, rt.currentAt);

  const trackId = currentData?.trackId;
  const lyrics = useAsync(() => (base && trackId ? api<Lyrics>(`${base}/current/lyrics`) : Promise.resolve(null)), [base, trackId]);
  // With synchronized lines the browser finds the active line itself; the server is only asked when there are none.
  const hasLines = (lyrics.data?.lines?.length ?? 0) > 0;
  const active = useAsync(() => (base && trackId && !hasLines ? api<ActiveLine>(`${base}/current/lyrics/active`) : Promise.resolve(null)), [base, trackId, hasLines], hasLines ? undefined : 500);
  const sponsors = useAsync(() => (base ? api<SponsorView[]>(`${base}/sponsors`) : Promise.resolve([])), [base], 60_000);

  const me = useRef(voterId());
  const vote = useAsync(() => (base ? api<VoteView>(`${base}/vote`, { query: { voterId: me.current } }) : Promise.resolve(null)), [base, rt.connected], rt.connected ? 20_000 : 4000);
  const [localVote, setLocalVote] = useState<VoteView | null>(null);
  useEffect(() => setLocalVote(null), [vote.data]);
  const cast = useCallback(
    async (hashtag: string): Promise<void> => {
      if (!base) return;
      setLocalVote(await api<VoteView>(`${base}/vote`, { method: 'POST', body: { voterId: me.current, hashtag } }));
    },
    [base],
  );

  // The socket's vote has no "my vote" (the server does not know who I am): keep mine from the REST answers for the same poll.
  const shared = rt.connected && rt.vote ? rt.vote : vote.data;
  const mine = localVote?.myVote ?? vote.data?.myVote ?? null;
  const minePoll = localVote?.poll?.id ?? vote.data?.poll?.id;
  // Connected: the pushed tally is the freshest (my own POST is broadcast too). Otherwise the REST answers are all there is.
  const merged: VoteView | null = rt.connected && rt.vote && shared ? { ...shared, myVote: shared.poll && shared.poll.id === minePoll ? mine : null } : (localVote ?? shared ?? null);

  return { stations: stations.data, slug, pick: lockedSlug ? () => undefined : setPicked, base, current: currentData, fetchedAt, lyrics: lyrics.data, active: active.data, sponsors: sponsors.data ?? [], vote: merged, cast, realtime: rt };
}
