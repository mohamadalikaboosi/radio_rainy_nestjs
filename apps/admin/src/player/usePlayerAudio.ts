import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSetting, QualityPref, saveSetting, slowConnection, stallTracker, withQuery } from './helpers';
import { WsAudioPlayer, wsAudioSupported } from './ws-audio';

interface WebkitWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

const VOLUME_KEY = 'rr_volume';
const MAX_RETRY_MS = 15_000;

/**
 * The <audio> element of the radio + a Web Audio analyser for the visualizer.
 * Pausing drops the source so that playing again joins the live edge instead of resuming stale buffered audio.
 * A stream that drops by itself (network loss, server restart) is reconnected with back-off until it plays again or the listener pauses.
 */
export function usePlayerAudio(streamUrl: string | null, opts: { transport?: 'HTTP' | 'WEBSOCKET' | null; audioSocketUrl?: string | null; quality?: QualityPref; lowAvailable?: boolean } = {}) {
  const audio = useRef<HTMLAudioElement>(null);
  /** The listener wants audio (stays true while buffering / reconnecting). */
  const [playing, setPlaying] = useState(false);
  /** Started but no sound yet (connecting, buffering, reconnecting). */
  const [buffering, setBuffering] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const wanted = useRef(false);
  const attempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [volume, setVolumeState] = useState(() => Math.min(100, Math.max(0, Number(loadSetting(VOLUME_KEY, '70')) || 0)));
  /** What is actually delivering the audio right now (WEBSOCKET falls back to HTTP by itself when the browser/server can't do it). */
  const [active, setActive] = useState<'HTTP' | 'WEBSOCKET'>('HTTP');
  const wsPlayer = useRef<WsAudioPlayer | null>(null);
  const wsBroken = useRef(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const [error, setError] = useState(false);
  /** Auto mode gave up on the normal stream (repeated stalls) for this session. */
  const [autoLow, setAutoLow] = useState(false);
  const pref = opts.quality ?? 'auto';
  const lowOk = opts.lowAvailable ?? false;
  const quality: 'high' | 'low' = lowOk && (pref === 'low' || (pref === 'auto' && (autoLow || slowConnection()))) ? 'low' : 'high';
  const lowParam = quality === 'low' ? { quality: 'low' } : null;

  const ensureAnalyser = useCallback((el: HTMLAudioElement): void => {
    if (ctx.current) {
      void ctx.current.resume();
      return;
    }
    try {
      const AC = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (!AC) return;
      const c = new AC();
      const source = c.createMediaElementSource(el);
      const node = c.createAnalyser();
      node.fftSize = 1024; // 512 bins: enough resolution for 64 log-spaced bars
      node.smoothingTimeConstant = 0.82;
      source.connect(node);
      node.connect(c.destination);
      ctx.current = c;
      setAnalyser(node);
    } catch {
      /* no analyser: the equalizer falls back to its synthetic animation and the audio still plays */
    }
  }, []);

  const stop = useCallback((): void => {
    const el = audio.current;
    if (!el) return;
    wanted.current = false;
    clearTimeout(retryTimer.current);
    wsPlayer.current?.stop();
    wsPlayer.current = null;
    el.pause();
    el.removeAttribute('src');
    el.load();
    setPlaying(false);
    setBuffering(false);
    setReconnecting(false);
  }, []);

  const sounding = useCallback((): void => {
    attempts.current = 0;
    setBuffering(false);
    setReconnecting(false);
  }, []);

  const playHttp = useCallback((el: HTMLAudioElement): void => {
    if (!streamUrl) return;
    setActive('HTTP');
    el.src = withQuery(streamUrl, { ...lowParam, ts: String(Date.now()) });
    void el.play().then(() => {
      setPlaying(true);
      sounding();
    }).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'AbortError') return; // the source was replaced (quality switch, reconnect)
      // refused (e.g. autoplay policy): only a tap can start it again
      wanted.current = false;
      setPlaying(false);
      setBuffering(false);
      setReconnecting(false);
      setError(true);
    });
  }, [streamUrl, lowParam?.quality, sounding]);

  const play = useCallback((): void => {
    const el = audio.current;
    if (!el || !streamUrl) return;
    wanted.current = true;
    clearTimeout(retryTimer.current);
    setError(false);
    setBuffering(true);
    ensureAnalyser(el);
    if (opts.transport === 'WEBSOCKET' && opts.audioSocketUrl && !wsBroken.current && wsAudioSupported()) {
      setActive('WEBSOCKET');
      const p = new WsAudioPlayer(el, lowParam ? withQuery(opts.audioSocketUrl, lowParam) : opts.audioSocketUrl, () => {
        // not supported / closed / failed: keep listening over plain HTTP instead (and don't retry WebSocket this session)
        wsBroken.current = true;
        wsPlayer.current = null;
        playHttp(el);
      });
      wsPlayer.current = p;
      void p.start().then(() => {
        if (wsPlayer.current === p) setPlaying(true);
      });
      return;
    }
    playHttp(el);
  }, [streamUrl, opts.transport, opts.audioSocketUrl, lowParam?.quality, ensureAnalyser, playHttp]);

  const toggle = useCallback((): void => (playing ? stop() : play()), [playing, play, stop]);
  const playRef = useRef(play);
  playRef.current = play;

  const setVolume = useCallback((v: number): void => {
    setVolumeState(v);
    saveSetting(VOLUME_KEY, String(v));
  }, []);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume / 100;
  }, [volume]);

  // a live stream that stops by itself (network drop, server restart) is reconnected with back-off while the listener still wants it
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const onLost = (): void => {
      if (!el.getAttribute('src') || !wanted.current) return;
      setReconnecting(true);
      setBuffering(true);
      const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** attempts.current);
      attempts.current++;
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => {
        if (wanted.current) playRef.current();
      }, delay);
    };
    const onWaiting = (): void => {
      if (wanted.current) setBuffering(true);
    };
    el.addEventListener('ended', onLost);
    el.addEventListener('error', onLost);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('playing', sounding);
    return () => {
      el.removeEventListener('ended', onLost);
      el.removeEventListener('error', onLost);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('playing', sounding);
      clearTimeout(retryTimer.current);
    };
  }, [sounding]);

  // quality changed while listening (selector, or auto mode gave up): rejoin the live edge on the other stream
  const lastQuality = useRef(quality);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useEffect(() => {
    if (lastQuality.current === quality) return;
    lastQuality.current = quality;
    if (!playingRef.current) return;
    wsPlayer.current?.stop();
    wsPlayer.current = null;
    playRef.current();
  }, [quality]);

  // auto mode: repeated stalls = the connection can't keep up -> switch to the light stream
  useEffect(() => {
    const el = audio.current;
    if (!el || pref !== 'auto' || !lowOk || quality === 'low') return;
    const stalled = stallTracker();
    const onStall = (): void => {
      if (playingRef.current && stalled()) setAutoLow(true);
    };
    el.addEventListener('waiting', onStall);
    el.addEventListener('stalled', onStall);
    return () => {
      el.removeEventListener('waiting', onStall);
      el.removeEventListener('stalled', onStall);
    };
  }, [pref, lowOk, quality]);

  useEffect(() => () => void ctx.current?.close().catch(() => undefined), []);

  return { audio, playing, buffering, reconnecting, analyser, error, toggle, stop, play, active, quality, autoSwitched: autoLow, volume, setVolume };
}

/** Lock-screen / headset controls and metadata (Media Session API). */
export function useMediaSession(meta: { title: string; artist: string; album: string } | null, playing: boolean, onPlay: () => void, onStop: () => void): void {
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (meta && typeof MediaMetadata !== 'undefined') {
      ms.metadata = new MediaMetadata({ title: meta.title, artist: meta.artist, album: meta.album, artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
    }
    ms.playbackState = playing ? 'playing' : 'paused';
    ms.setActionHandler('play', onPlay);
    ms.setActionHandler('pause', onStop);
    ms.setActionHandler('stop', onStop);
    return () => {
      ms.setActionHandler('play', null);
      ms.setActionHandler('pause', null);
      ms.setActionHandler('stop', null);
    };
  }, [meta?.title, meta?.artist, meta?.album, playing, onPlay, onStop]);
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** "Add to home screen": the browser's install prompt, offered by a button when the app is installable. */
export function useInstallPrompt(): { canInstall: boolean; install: () => void } {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event): void => {
      e.preventDefault();
      setEvent(e as InstallPromptEvent);
    };
    const onInstalled = (): void => setEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  return {
    canInstall: event !== null,
    install: () => {
      void event?.prompt().then(() => setEvent(null));
    },
  };
}
