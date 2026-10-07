import { useEffect, useRef } from 'react';
import { vizLevels } from './helpers';

/**
 * 64 bars under the hero: the real spectrum of the stream (Web Audio analyser) while it plays, a low idle wave when paused.
 * Bars are updated straight on the DOM from requestAnimationFrame (~30 fps), so React never re-renders per frame.
 */
export function Visualizer({ analyser, playing, bars = 64 }: { analyser: AnalyserNode | null; playing: boolean; bars?: number }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const items = Array.from(el.children) as HTMLElement[];
    const bytes = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animate = typeof requestAnimationFrame === 'function' && !reduced;
    let raf = 0;
    let last = 0;
    const draw = (t: number): void => {
      if (t - last >= 33) {
        last = t;
        if (analyser && bytes && playing) analyser.getByteFrequencyData(bytes);
        vizLevels(playing ? bytes : null, bars, playing, t).forEach((v, i) => {
          const bar = items[i];
          if (!bar) return;
          bar.style.height = `${Math.max(3, v * 100).toFixed(1)}%`;
          bar.style.opacity = (0.35 + v * 0.65).toFixed(2);
        });
      }
      if (animate) raf = requestAnimationFrame(draw);
    };
    draw(performance.now());
    return () => cancelAnimationFrame(raf);
  }, [analyser, playing, bars]);

  return (
    <div ref={box} className="pl-viz" data-testid="visualizer" aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}
