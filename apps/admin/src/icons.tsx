import { ReactNode } from 'react';

const P: Record<string, ReactNode> = {
  live: <><circle cx="12" cy="12" r="3" /><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4" /></>,
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>,
  channels: <><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" /><circle cx="5" cy="19" r="1" /></>,
  radio: <><rect x="3" y="8" width="18" height="12" rx="2" /><path d="M7 8l10-4M8 14h4M16 14h.01" /></>,
  rules: <><path d="M4 6h16M4 12h10M4 18h6" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  tracks: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  hashtags: <><path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16" /></>,
  lyrics: <><path d="M4 6h16M4 10h16M4 14h10M4 18h7" /></>,
  reports: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  language: <><path d="M4 5h9M8 3v2M6 5c0 4 3 7 6 8M12 5c-1 4-4 7-8 8M14 21l4-10 4 10M15.5 18h5" /></>,
  telegram: <><path d="M21 4L3 11l6 2 2 6 3-4 5 4z" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.2-.8.2-1.2z" /></>,
  audit: <><path d="M9 3h6l4 4v14H5V3zM14 3v5h5M9 13h6M9 17h6" /></>,
  external: <><path d="M14 4h6v6M10 14L20 4M18 14v6H4V6h6" /></>,
  next: <><path d="M5 4l10 8-10 8zM19 5v14" /></>,
  play: <><path d="M6 4l14 8-14 8z" /></>,
  queue: <><path d="M3 6h13M3 12h13M3 18h8M18 15v6M15 18h6" /></>,
};

export function Icon({ name }: { name: keyof typeof P | string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {P[name] ?? null}
    </svg>
  );
}
