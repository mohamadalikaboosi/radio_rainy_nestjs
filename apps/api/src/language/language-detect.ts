export type LyricsLanguage = 'fa' | 'en' | 'mixed' | 'unknown';

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/gu;
const LATIN = /[A-Za-z]/g;

/**
 * Script-based language detection for lyrics: Persian (Arabic script) vs English (Latin). Deterministic and instant,
 * used to pick the Whisper language per track and to keep the learned lexicon separate per language.
 */
export function detectLanguage(text: string): LyricsLanguage {
  const fa = (text.match(ARABIC_SCRIPT) ?? []).length;
  const en = (text.match(LATIN) ?? []).length;
  const total = fa + en;
  if (total < 8) return 'unknown';
  const faShare = fa / total;
  if (faShare >= 0.85) return 'fa';
  if (faShare <= 0.15) return 'en';
  return 'mixed';
}

/** Whisper language hint for a detected language; `undefined` lets Whisper auto-detect (mixed/unknown). */
export function whisperLanguage(lang: LyricsLanguage | null | undefined): 'fa' | 'en' | undefined {
  return lang === 'fa' || lang === 'en' ? lang : undefined;
}
