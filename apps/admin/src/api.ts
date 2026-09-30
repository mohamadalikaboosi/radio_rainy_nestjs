const TOKEN_KEY = 'rr_admin_token';

/** localStorage can throw (private mode / blocked): the app must still work for the session. */
let memoryToken: string | null = null;
export const authStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
    } catch {
      return memoryToken;
    }
  },
  set(token: string): void {
    memoryToken = token;
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* memory fallback already set */
    }
  },
  clear(): void {
    memoryToken = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown) {
    super(message);
  }
}

export const UNAUTHORIZED_EVENT = 'rr:unauthorized';

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Query;
}

export async function api<T>(path: string, opt: RequestOptions = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(opt.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const token = authStore.get();
  const res = await fetch(url.pathname + url.search, {
    method: opt.method ?? 'GET',
    headers: { ...(opt.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/admin/auth/login') {
      authStore.clear();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const msg = typeof data === 'object' && data !== null && 'message' in data ? String((data as { message: unknown }).message) : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

// ---- types (mirrors the backend responses) ----
export type RadioMode = 'GLOBAL_RANDOM' | 'HASHTAG_RANDOM' | 'HASHTAG_ROTATION' | 'CUSTOM_RULE';
export type LyricsStatus = 'LYRICS_NONE' | 'LYRICS_PENDING' | 'LYRICS_PROCESSING' | 'LYRICS_READY' | 'LYRICS_FAILED';

export interface TrackItem {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number | null;
  hashtags: string[];
  lyricsStatus: LyricsStatus;
  enabled: boolean;
  status: string;
  playCount: number;
  lastPlayedAt: string | null;
  channelId: string;
  telegramMessageId: number;
  telegramPostUrl: string | null;
  lyricsUrl: string | null;
}
export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}
export interface HashtagStat {
  hashtagId: string;
  value: string;
  normalized: string;
  trackCount: number;
  playableCount: number;
  failedLyricsCount: number;
  plays: number;
  lastPlayedAt: string | null;
  createdAt: string;
}
export interface RuleView {
  id: string;
  name: string;
  priority: number;
  matchMode: 'ANY' | 'ALL';
  weight: number;
  enabled: boolean;
  include: string[];
  exclude: string[];
}
export interface ConfigView {
  version: number;
  mode: RadioMode;
  hashtagMatchMode: 'ANY' | 'ALL';
  recentTrackWindow: number;
  fallbackToGlobal: boolean;
  enabled: boolean;
  hashtags: { hashtag: string; weight: number }[];
  rules: RuleView[];
}
export interface PreviewResult {
  seed: number;
  mode: string;
  eligibleCount: number;
  tracks: { id: string; title: string; artist: string | null; hashtags: string[]; reason: string }[];
}
export interface ChannelItem {
  id: string;
  reference: string;
  title: string;
  username: string | null;
  slug: string;
  started: boolean;
  telegramLiveEnabled: boolean;
  liveStatus: 'OFF' | 'STARTING' | 'LIVE' | 'ERROR';
  liveError: string | null;
  /** Manual Telegram live target (link + key); the key itself is never sent to the browser. */
  liveRtmpUrl: string | null;
  liveRtmpKeySet: boolean;
  liveTargetRev: number;
}
export interface TelegramStatus {
  state: 'NOT_CONFIGURED' | 'NOT_LOGGED_IN' | 'CONNECTING' | 'AWAITING_CODE' | 'AWAITING_PASSWORD' | 'READY' | 'DISCONNECTED' | 'ERROR';
  accountLabel: string | null;
  error?: string;
}

/** Downloads a file from an authenticated endpoint (browsers can't send the bearer token on a plain link). */
export async function downloadWithAuth(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${authStore.get() ?? ''}` } });
  if (!res.ok) throw new ApiError(res.status, `Download failed (HTTP ${res.status})`, null);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface LiveTrack { trackId: string; title: string; artist: string | null; album: string | null; duration: number | null }
export interface LiveStation {
  id: string;
  slug: string;
  title: string;
  started: boolean;
  running: boolean;
  status: 'PLAYING' | 'STOPPED' | 'IDLE' | 'ERROR';
  statusReason: string | null;
  transitionSeq: number;
  listeners: number;
  liveOnTelegram: { enabled: boolean; status: 'OFF' | 'STARTING' | 'LIVE' | 'ERROR'; error: string | null };
  streamUrl: string;
  nowPlaying: (LiveTrack & { startedAt: string; position: number; lyricsStatus: string; activeLine: string | null }) | null;
  upNext: (LiveTrack & { queued: boolean }) | null;
  recent: { trackId: string; title: string; artist: string | null; startedAt: string; endReason: string | null }[];
}

/** Uploads a file as the raw request body (Content-Type = the file's type), like `PUT /admin/ads/:id/audio`. */
export async function uploadFile<T>(path: string, file: Blob & { name?: string }, contentType?: string): Promise<T> {
  const token = authStore.get();
  const res = await fetch(path, { method: 'PUT', headers: { 'Content-Type': contentType ?? (file.type || 'application/octet-stream'), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: file });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) {
      authStore.clear();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const msg = typeof data === 'object' && data !== null && 'message' in data ? String((data as { message: unknown }).message) : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

// ---- ads, sponsors, engagement ----
export interface AdItem {
  id: string;
  channelId: string | null;
  name: string;
  weight: number;
  enabled: boolean;
  linkUrl: string | null;
  ctaLabel: string | null;
  hasAudio: boolean;
  audioMime: string | null;
  audioSize: number | null;
  durationSeconds: number | null;
  hasImage: boolean;
  plays: number;
  clicks: number;
  lastPlayedAt: string | null;
  createdAt: string;
}
export interface SponsorItem {
  id: string;
  channelId: string | null;
  name: string;
  tagline: string | null;
  url: string;
  ctaLabel: string;
  hasLogo: boolean;
  weight: number;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  impressions: number;
  clicks: number;
}
export interface EngagementSettings {
  adsEveryNTracks: number;
  tagVoteEnabled: boolean;
  tagVoteIntervalMinutes: number;
  tagVotePollMinutes: number;
  tagVotePlayMinutes: number;
  tagVoteOptions: number;
  tagVoteAllowlist: string[];
}
export interface VoteView {
  status: 'NONE' | 'OPEN' | 'PLAYING';
  poll?: { id: string; options: { hashtag: string; votes: number }[]; closesAt: string; totalVotes: number };
  winner?: string;
  playUntil?: string;
  myVote?: string | null;
  serverTime: string;
}
export interface PollHistoryItem {
  id: string;
  options: string[];
  opensAt: string;
  closesAt: string;
  status: 'OPEN' | 'CLOSED';
  winner: string | null;
  playUntil: string | null;
  tally: Record<string, number>;
}
