import { useCallback, useEffect, useRef, useState } from 'react';
import { QualityPref, slowConnection, stallTracker, withQuery } from './helpers';
import { WsAudioPlayer, wsAudioSupported } from './ws-audio';

interface WebkitWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * The <audio> element of the radio + a Web Audio analyser for the equalizer.
 * Pausing drops the source so that playing again joins the live edge instead of resuming stale buffered audio.
 */
export function usePlayerAudio(streamUrl: string | null, opts: { transport?: 'HTTP' | 'WEBSOCKET' | null; audioSocketUrl?: string | null; quality?: QualityPref; lowAvailable?: boolean } = {}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
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
      node.fftSize = 256;
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
    wsPlayer.current?.stop();
    wsPlayer.current = null;
    el.pause();
    el.removeAttribute('src');
    el.load();
    setPlaying(false);
  }, []);

  const playHttp = useCallback((el: HTMLAudioElement): void => {
    if (!streamUrl) return;
    setActive('HTTP');
    el.src = withQuery(streamUrl, { ...lowParam, ts: String(Date.now()) });
    void el.play().then(() => setPlaying(true)).catch(() => {
      setPlaying(false);
      setError(true);
    });
  }, [streamUrl, lowParam?.quality]);

  const play = useCallback((): void => {
    const el = audio.current;
    if (!el || !streamUrl) return;
    setError(false);
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

  // a live stream that stops by itself (network drop) must not leave the button saying "pause"
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const onEnded = (): void => setPlaying(false);
    const onError = (): void => {
      if (el.getAttribute('src')) {
        setPlaying(false);
        setError(true);
      }
    };
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    return () => {
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
    };
  }, []);

  // quality changed while listening (selector, or auto mode gave up): rejoin the live edge on the other stream
  const lastQuality = useRef(quality);
  const playRef = useRef(play);
  playRef.current = play;
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

  return { audio, playing, analyser, error, toggle, stop, play, active, quality, autoSwitched: autoLow };
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
