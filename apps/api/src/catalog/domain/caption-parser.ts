export interface ParsedHashtag {
  /** As written, without '#'. */
  value: string;
  normalized: string;
}

export interface AudioAttributes {
  title?: string;
  performer?: string;
  fileName?: string;
}

export interface ParsedCaption {
  title: string;
  artist?: string;
  album?: string;
  lyricsUrl?: string;
  hashtags: ParsedHashtag[];
}

const TELEGRAPH_HOSTS = new Set(['telegra.ph', 'te.legra.ph', 'graph.org']);
const URL_RE = /(?<![\w.\-/@])(?:https?:\/\/)?(?:telegra\.ph|te\.legra\.ph|graph\.org)\/[^\s<>"'\])}]+/giu;
const ANY_URL_RE = /https?:\/\/[^\s<>"'\])}]+/giu;
const HASHTAG_RE = /(?:^|[\s(])#([\p{L}\p{N}_‌]+)/gu;
const TRAILING_PUNCT = /[.,;:!?…»)\]}]+$/u;

export function normalizeHashtag(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/‌/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function extractHashtags(text: string): ParsedHashtag[] {
  const seen = new Map<string, ParsedHashtag>();
  for (const m of text.matchAll(HASHTAG_RE)) {
    const value = (m[1] ?? '').replace(/^_+|_+$/g, '');
    const normalized = normalizeHashtag(value);
    if (normalized.length === 0 || /^\d+$/.test(normalized)) continue; // "#1" is not a tag
    if (!seen.has(normalized)) seen.set(normalized, { value, normalized });
  }
  return [...seen.values()];
}

/** Returns a canonical https Telegraph URL, or undefined if `raw` is not a Telegraph link. */
export function toTelegraphUrl(raw: string): string | undefined {
  const cleaned = raw.trim().replace(TRAILING_PUNCT, '');
  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  try {
    const u = new URL(withScheme);
    if (!TELEGRAPH_HOSTS.has(u.hostname.toLowerCase())) return undefined;
    if (u.pathname.length <= 1) return undefined;
    return `https://${u.hostname.toLowerCase()}${u.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Robust Telegraph lyrics URL extraction. `entityUrls` are hidden links from message entities
 * (text-url entities) which are checked first because a visible "Lyrics" label may hide the real link.
 */
export function extractLyricsUrl(text: string, entityUrls: readonly string[] = []): string | undefined {
  for (const u of entityUrls) {
    const t = toTelegraphUrl(u);
    if (t) return t;
  }
  for (const m of text.matchAll(URL_RE)) {
    const t = toTelegraphUrl(m[0]);
    if (t) return t;
  }
  for (const m of text.matchAll(ANY_URL_RE)) {
    const t = toTelegraphUrl(m[0]);
    if (t) return t;
  }
  return undefined;
}

const LABEL_RE = /^\s*(album|lyrics?|artist|title|track)\s*[:：]\s*(.*)$/iu;

function isNoiseLine(line: string): boolean {
  const l = line.trim();
  if (l.length === 0) return true;
  if (/^(?:#[\p{L}\p{N}_‌]+\s*)+$/u.test(l)) return true; // only hashtags
  if (/^(?:https?:\/\/\S+|(?:telegra\.ph|graph\.org)\/\S+)$/iu.test(l)) return true;
  const label = LABEL_RE.exec(l);
  return label !== null; // labelled metadata lines are not the title line
}

function stripFileExt(name: string): string {
  return name.replace(/\.(mp3|m4a|flac|ogg|opus|wav|aac|wma)$/i, '');
}

function splitArtistTitle(line: string): { artist?: string; title: string } {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(line.trim());
  if (m && m[1] && m[2]) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: line.trim() };
}

function cleanLine(line: string): string {
  return line.replace(/#[\p{L}\p{N}_‌]+/gu, '').replace(/\s+/g, ' ').trim();
}

export function parseCaption(
  caption: string | undefined,
  attrs: AudioAttributes = {},
  entityUrls: readonly string[] = [],
): ParsedCaption {
  const text = caption ?? '';
  const lines = text.split(/\r?\n/);

  let album: string | undefined;
  for (const line of lines) {
    const m = LABEL_RE.exec(line);
    if (m && /^album$/i.test(m[1] ?? '') && (m[2] ?? '').trim()) {
      album = cleanLine(m[2] ?? '');
      break;
    }
  }

  let title = attrs.title?.trim();
  let artist = attrs.performer?.trim() || undefined;

  if (!title) {
    const first = lines.find((l) => !isNoiseLine(l));
    if (first) {
      const split = splitArtistTitle(cleanLine(first));
      title = split.title;
      artist = artist ?? split.artist;
    }
  }
  if (!artist) {
    const labelled = lines.map((l) => LABEL_RE.exec(l)).find((m) => m && /^artist$/i.test(m[1] ?? ''));
    if (labelled?.[2]) artist = cleanLine(labelled[2]);
  }
  if (!title && attrs.fileName) {
    const split = splitArtistTitle(stripFileExt(attrs.fileName).replace(/_/g, ' '));
    title = split.title;
    artist = artist ?? split.artist;
  }

  return {
    title: title && title.length > 0 ? title : 'Unknown title',
    artist: artist && artist.length > 0 ? artist : undefined,
    album: album && album.length > 0 ? album : undefined,
    lyricsUrl: extractLyricsUrl(text, entityUrls),
    hashtags: extractHashtags(text),
  };
}
