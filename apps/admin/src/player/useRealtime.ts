import { useEffect, useRef, useState } from 'react';
import type { VoteView } from '../api';
import type { Current } from './useRadio';

export interface LiveMessage {
  id: string;
  channelId: string;
  text: string;
  level: 'INFO' | 'WARN';
  createdAt: string;
  expiresAt: string;
}

export interface Realtime {
  /** The socket is open: pushed data is fresh, polling can relax. */
  connected: boolean;
  transport: 'HTTP' | 'WEBSOCKET' | null;
  listeners: number | null;
  clients: number | null;
  current: Current | null;
  /** When `current` was received (the clock reference for the server time it carries). */
  currentAt: number;
  vote: VoteView | null;
  messages: LiveMessage[];
}

type ServerMessage =
  | { type: 'hello'; current: Current; vote: VoteView; messages: LiveMessage[]; listeners: number; clients: number; transport: 'HTTP' | 'WEBSOCKET' }
  | { type: 'current'; current: Current }
  | { type: 'vote'; vote: VoteView }
  | { type: 'messages'; messages: LiveMessage[] }
  | { type: 'counts'; listeners: number; clients: number }
  | { type: 'pong' };

const EMPTY: Realtime = { connected: false, transport: null, listeners: null, clients: null, current: null, currentAt: 0, vote: null, messages: [] };

export function wsUrl(path: string): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${path}`;
}

/**
 * The live channel of a station: what is on air, the vote, announcements and the counts are PUSHED by the server (fed by Redis pub/sub),
 * so the page does not have to poll. Reconnects with backoff; while it is down the caller's polling keeps everything working.
 */
export function useRealtime(slug: string | null): Realtime {
  const [state, setState] = useState<Realtime>(EMPTY);
  const retry = useRef(0);

  useEffect(() => {
    setState(EMPTY);
    if (!slug || typeof WebSocket === 'undefined') return;
    let closed = false;
    let ws: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const open = (): void => {
      if (closed) return;
      ws = new WebSocket(wsUrl(`/radio/${slug}/ws`));
      ws.onopen = () => {
        retry.current = 0;
        pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: ServerMessage;
        try {
          m = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        const now = Date.now();
        setState((s) => {
          switch (m.type) {
            case 'hello':
              return { connected: true, transport: m.transport, listeners: m.listeners, clients: m.clients, current: m.current, currentAt: now, vote: m.vote, messages: m.messages };
            case 'current':
              return { ...s, current: m.current, currentAt: now };
            case 'vote':
              return { ...s, vote: m.vote };
            case 'messages':
              return { ...s, messages: m.messages };
            case 'counts':
              return { ...s, listeners: m.listeners, clients: m.clients };
            default:
              return s;
          }
        });
      };
      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        setState((s) => ({ ...s, connected: false }));
        if (closed) return;
        const wait = Math.min(30_000, 1000 * 2 ** retry.current++);
        retryTimer = setTimeout(open, wait);
      };
      ws.onerror = () => ws?.close();
    };
    open();
    return () => {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [slug]);

  return state;
}
