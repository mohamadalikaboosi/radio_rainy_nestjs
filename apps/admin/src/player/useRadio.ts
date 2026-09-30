import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { VoteView } from '../api';
import { useAsync } from '../hooks';
import type { SponsorView } from './helpers';
import { voterId } from './helpers';

export interface Station {
  slug: string;
  title: string;
  live: boolean;
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
export function useRadio() {
  const stations = useAsync(() => api<Station[]>('/radio/stations'), [], 10_000);
  const [picked, setPicked] = useState<string | null>(null);
  const slug = picked ?? stations.data?.find((s) => s.live)?.slug ?? stations.data?.[0]?.slug ?? null;
  const base = slug ? `/radio/${slug}` : null;

  const current = useAsync(() => (base ? api<Current>(`${base}/current`) : Promise.resolve(null)), [base], 1000);
  const fetchedAt = useRef(Date.now());
  useEffect(() => {
    if (current.data) fetchedAt.current = Date.now();
  }, [current.data]);

  const trackId = current.data?.trackId;
  const lyrics = useAsync(() => (base && trackId ? api<Lyrics>(`${base}/current/lyrics`) : Promise.resolve(null)), [base, trackId]);
  const active = useAsync(() => (base && trackId ? api<ActiveLine>(`${base}/current/lyrics/active`) : Promise.resolve(null)), [base, trackId], 500);
  const sponsors = useAsync(() => (base ? api<SponsorView[]>(`${base}/sponsors`) : Promise.resolve([])), [base], 60_000);

  const me = useRef(voterId());
  const vote = useAsync(() => (base ? api<VoteView>(`${base}/vote`, { query: { voterId: me.current } }) : Promise.resolve(null)), [base], 4000);
  const [localVote, setLocalVote] = useState<VoteView | null>(null);
  useEffect(() => setLocalVote(null), [vote.data]);
  const cast = useCallback(
    async (hashtag: string): Promise<void> => {
      if (!base) return;
      setLocalVote(await api<VoteView>(`${base}/vote`, { method: 'POST', body: { voterId: me.current, hashtag } }));
    },
    [base],
  );

  return { stations: stations.data, slug, pick: setPicked, base, current: current.data, fetchedAt, lyrics: lyrics.data, active: active.data, sponsors: sponsors.data ?? [], vote: localVote ?? vote.data, cast };
}
