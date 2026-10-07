/**
 * Shared schedule across consecutive tracks: track N+1 continues exactly where track N's audio ends for
 * listeners, so the client-side buffer never grows at transitions (no latency creep).
 */
export interface Timeline {
  /** wall-clock ms corresponding to sentSeconds = 0 */
  anchor: number;
  /** seconds of audio emitted since anchor */
  sentSeconds: number;
}

export function newTimeline(now: number): Timeline {
  return { anchor: now, sentSeconds: 0 };
}

export interface PaceOptions {
  /** Read for every slice, so a getter can refine it while the track plays. */
  readonly bytesPerSec: number;
  /** Seconds of audio sent ahead of real time (small = low latency, large = more resilient). */
  burstSeconds: number;
  sliceBytes: number;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  timeline?: Timeline;
  /** The source could not keep up with real time (the schedule had to be shifted): a buffer underrun. */
  onUnderrun?: () => void;
  /** Bytes received from the source and how long we waited for them (excluding pacing sleeps): download speed. */
  onSourceRead?: (bytes: number, waitedMs: number) => void;
}

export const realClock = {
  now: (): number => Date.now(),
  sleep: (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, ms);
      function done(): void {
        signal?.removeEventListener('abort', done);
        clearTimeout(t);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
};

/**
 * Turns a fast download into a real-time stream: emits small slices no faster than `bytesPerSec`
 * (plus `burstSeconds` of head start). If the source stalls, the schedule shifts instead of
 * flooding listeners with a huge catch-up burst afterwards.
 */
export async function* pace(source: AsyncIterable<Uint8Array>, opt: PaceOptions): AsyncGenerator<Buffer> {
  const tl = opt.timeline ?? newTimeline(opt.now());
  const burstMs = opt.burstSeconds * 1000;
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const askedAt = opt.now();
      const next = await it.next();
      if (next.done) return;
      const chunk = next.value;
      opt.onSourceRead?.(chunk.length, opt.now() - askedAt);
      for (let off = 0; off < chunk.length; off += opt.sliceBytes) {
        if (opt.signal?.aborted) return;
        const slice = Buffer.from(chunk.subarray(off, Math.min(chunk.length, off + opt.sliceBytes)));
        const due = tl.anchor + tl.sentSeconds * 1000 - burstMs;
        const wait = due - opt.now();
        if (wait > 0) {
          await opt.sleep(wait, opt.signal);
          if (opt.signal?.aborted) return;
        } else if (-wait > burstMs) {
          tl.anchor += -wait - burstMs; // we were starved (stall / idle): re-anchor instead of a catch-up flood
          opt.onUnderrun?.();
        }
        tl.sentSeconds += slice.length / opt.bytesPerSec;
        yield slice;
      }
    }
  } finally {
    await it.return?.(undefined);
  }
}
