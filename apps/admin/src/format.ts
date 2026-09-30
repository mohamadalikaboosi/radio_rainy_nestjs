export function mmss(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return '--:--';
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function normalizeTag(input: string): string {
  return input.trim().replace(/^#/, '').toLowerCase();
}

export const LYRICS_LABEL: Record<string, string> = {
  LYRICS_NONE: 'None',
  LYRICS_PENDING: 'Pending',
  LYRICS_PROCESSING: 'Processing',
  LYRICS_READY: 'Ready',
  LYRICS_FAILED: 'Failed',
};
