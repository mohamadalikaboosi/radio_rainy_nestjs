import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the Telegram live video shows: the title (big) and the artist (small) of the music on air. */
export interface NowPlayingOverlay {
  titleFile: string;
  artistFile: string;
  fontFile?: string;
}

const FONT_CANDIDATES = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'];

const clip = (s: string, max: number): string => {
  const t = s.replace(/[\r\n]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Two small text files that ffmpeg's `drawtext` re-reads every frame (`reload=1`). They are replaced atomically (write + rename), so
 * ffmpeg never reads a half-written file, and changing the track never restarts the stream.
 */
export class NowPlayingText {
  readonly overlay: NowPlayingOverlay;

  constructor(dir: string, channelId: string, fallbackTitle: string) {
    mkdirSync(dir, { recursive: true });
    const fontFile = FONT_CANDIDATES.find((f) => existsSync(f));
    this.overlay = { titleFile: join(dir, `np-${channelId}-title.txt`), artistFile: join(dir, `np-${channelId}-artist.txt`), ...(fontFile ? { fontFile } : {}) };
    this.set(fallbackTitle, '');
  }

  set(title: string, artist: string | null): void {
    this.write(this.overlay.titleFile, clip(title, 44));
    this.write(this.overlay.artistFile, clip(artist ?? '', 52));
  }

  private write(file: string, text: string): void {
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, text || ' ');
      renameSync(tmp, file);
    } catch {
      /* the overlay is decoration: never let it affect playback */
    }
  }
}

/** Escapes a value for use inside an ffmpeg filter option. */
export const filterEscape = (s: string): string => s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** The `-vf` chain that draws the two text files centred on the video. */
export function drawtextFilter(o: NowPlayingOverlay): string {
  const font = o.fontFile ? `fontfile='${filterEscape(o.fontFile)}':` : '';
  const common = `${font}reload=1:fontcolor=white:x=(w-text_w)/2:borderw=2:bordercolor=black@0.6`;
  return [`drawtext=textfile='${filterEscape(o.titleFile)}':${common}:fontsize=56:y=(h/2)-70`, `drawtext=textfile='${filterEscape(o.artistFile)}':${common.replace('fontcolor=white', 'fontcolor=0xc8d0dc')}:fontsize=38:y=(h/2)+20`].join(',');
}
