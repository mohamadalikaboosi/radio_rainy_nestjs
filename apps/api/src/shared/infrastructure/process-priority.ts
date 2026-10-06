import { setPriority } from 'node:os';

/**
 * Background ffmpeg processes (the Telegram live encoder, slide rendering, Whisper conversions) must never starve the Node process that
 * feeds the listeners: they run at a lower CPU priority ("nice"). Best effort: ignored where the OS does not allow it.
 */
export function lowerPriority(proc: { pid?: number }, nice = 10): void {
  try {
    if (proc.pid) setPriority(proc.pid, nice);
  } catch {
    /* not permitted / process already gone: harmless */
  }
}
