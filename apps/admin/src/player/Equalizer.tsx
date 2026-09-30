import { useEffect, useRef } from 'react';
import { barLevels } from './helpers';

/** Animated equalizer: real spectrum from the Web Audio analyser while music plays, a calm synthetic wave otherwise. */
export function Equalizer({ analyser, playing, bars = 36 }: { analyser: AnalyserNode | null; playing: boolean; bars?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const bytes = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    let raf = 0;
    let phase = 0;
    let smooth: number[] = new Array<number>(bars).fill(0.1);

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (analyser && bytes && playing) analyser.getByteFrequencyData(bytes);
      const target = playing ? barLevels(analyser && playing ? bytes : null, bars, phase) : barLevels(null, bars, 0).map((v) => v * 0.45);
      smooth = smooth.map((v, i) => v + ((target[i] ?? 0) - v) * 0.35);
      const gap = 4;
      const bw = Math.max(2, (w - gap * (bars - 1)) / bars);
      const style = getComputedStyle(el);
      const c1 = style.getPropertyValue('--pl-a').trim() || '#7aa2ff';
      const c2 = style.getPropertyValue('--pl-b').trim() || '#c77dff';
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);
      ctx.fillStyle = grad;
      smooth.forEach((v, i) => {
        const bh = Math.max(3, v * h);
        const x = i * (bw + gap);
        const r = Math.min(bw / 2, 4);
        ctx.beginPath();
        ctx.roundRect(x, h - bh, bw, bh, [r, r, 0, 0]);
        ctx.fill();
      });
      phase += 0.06;
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser, playing, bars]);

  return <canvas ref={canvas} className="pl-eq" role="img" aria-label="equalizer" />;
}
