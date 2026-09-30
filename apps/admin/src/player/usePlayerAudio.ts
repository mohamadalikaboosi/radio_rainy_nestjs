import { useCallback, useEffect, useRef, useState } from 'react';

interface WebkitWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * The <audio> element of the radio + a Web Audio analyser for the equalizer.
 * Pausing drops the source so that playing again joins the live edge instead of resuming stale buffered audio.
 */
export function usePlayerAudio(streamUrl: string | null) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const [error, setError] = useState(false);

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
    el.pause();
    el.removeAttribute('src');
    el.load();
    setPlaying(false);
  }, []);

  const play = useCallback((): void => {
    const el = audio.current;
    if (!el || !streamUrl) return;
    setError(false);
    ensureAnalyser(el);
    el.src = `${streamUrl}?ts=${Date.now()}`;
    void el.play().then(() => setPlaying(true)).catch(() => {
      setPlaying(false);
      setError(true);
    });
  }, [streamUrl, ensureAnalyser]);

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

  useEffect(() => () => void ctx.current?.close().catch(() => undefined), []);

  return { audio, playing, analyser, error, toggle, stop, play };
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
