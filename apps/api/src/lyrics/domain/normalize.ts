/**
 * Normalizes text for fuzzy lyric matching: case, punctuation, apostrophes,
 * diacritics, Arabic/Persian letter variants and whitespace.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ي/g, 'ی') // Arabic yeh -> Persian yeh
    .replace(/ك/g, 'ک') // Arabic kaf -> Persian kaf
    .replace(/[​-‏‪-‮]/g, ' ') // zero-width / bidi marks split words
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // combining marks / harakat
    .replace(/['’‘`´ʼ]/g, '') // don't -> dont
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  const n = normalizeText(input);
  return n.length === 0 ? [] : n.split(' ');
}

const SECTION_MARKER = /^\s*[[(].*[\])]\s*:?\s*$/;

export interface LyricLine {
  /** Original display text (trimmed). */
  text: string;
  tokens: string[];
}

/** Splits raw lyrics into displayable lines; blank lines and pure section markers ([Chorus], (x2)) are dropped. */
export function parseLyricLines(raw: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const text = rawLine.trim();
    if (text.length === 0 || SECTION_MARKER.test(text)) continue;
    const tokens = tokenize(text);
    if (tokens.length === 0) continue;
    lines.push({ text, tokens });
  }
  return lines;
}
