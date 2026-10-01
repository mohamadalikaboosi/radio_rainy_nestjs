import { parseLyricLines, tokenize } from './normalize';
import { similarity } from './similarity';
import { EMPTY_LEXICON, LearnedPair, Lexicon } from '../application/lexicon';
import { Transcript, TranscriptWord } from './transcription.types';

export const ALIGNMENT_ALGORITHM_VERSION = 'dp-word-v2-lexicon';

export interface AlignedLine {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export type AlignmentFailureReason = 'EMPTY_LYRICS' | 'EMPTY_TRANSCRIPT' | 'LOW_COVERAGE' | 'TOO_LARGE';

export type AlignmentResult =
  | { ok: true; lines: AlignedLine[]; quality: number; learned: LearnedPair[] }
  | { ok: false; reason: AlignmentFailureReason; quality: number };

export interface AlignerOptions {
  /** Min similarity for two words to be considered the same word. */
  matchThreshold: number;
  /** Min fraction of lyric words matched to accept the alignment. */
  minCoverage: number;
  gapLyric: number;
  gapAsr: number;
  /** Estimated seconds per word for lines placed outside the anchored range. */
  fallbackWordSeconds: number;
  maxCells: number;
}

export const DEFAULT_ALIGNER_OPTIONS: AlignerOptions = {
  matchThreshold: 0.6,
  minCoverage: 0.35,
  gapLyric: -0.3,
  gapAsr: -0.05,
  fallbackWordSeconds: 0.4,
  maxCells: 25_000_000,
};

interface AsrWord {
  norm: string;
  start: number;
  end: number;
}

/** Uses provider word timestamps when present; otherwise spreads each segment's words linearly (degraded mode). */
export function buildAsrWords(transcript: Transcript): AsrWord[] {
  const out: AsrWord[] = [];
  const fromWords = (words: TranscriptWord[]): void => {
    for (const w of words) {
      for (const t of tokenize(w.text)) out.push({ norm: t, start: w.start, end: w.end });
    }
  };
  if (transcript.words && transcript.words.length > 0) {
    fromWords(transcript.words);
    return out;
  }
  for (const seg of transcript.segments) {
    const tokens = tokenize(seg.text);
    if (tokens.length === 0) continue;
    const totalChars = tokens.reduce((s, t) => s + t.length, 0);
    const dur = Math.max(0, seg.end - seg.start);
    let cursor = seg.start;
    for (const t of tokens) {
      const span = totalChars === 0 ? 0 : (dur * t.length) / totalChars;
      out.push({ norm: t, start: cursor, end: cursor + span });
      cursor += span;
    }
  }
  return out;
}

function wordScore(a: string, b: string, threshold: number, lexicon: Lexicon): number {
  if (a === b) return 1.5;
  // learned spelling variant (trusted): as good as a match. equivalent(asrWord, lyricWord): `a` is the lyric word, `b` the ASR word.
  if (lexicon.equivalent(b, a)) return 1.4;
  if (a.length <= 2 || b.length <= 2) return Number.NEGATIVE_INFINITY;
  const sim = similarity(a, b);
  return sim >= threshold ? 0.5 + sim : Number.NEGATIVE_INFINITY;
}

const DIAG = 1;
const UP = 2; // skip lyric word
const LEFT = 3; // skip ASR word

/**
 * Monotonic global word alignment (Needleman-Wunsch variant): lyrics are consumed in order,
 * ASR words may be skipped freely at the start/end (intro/outro) and cheaply inside.
 * Monotonicity maps repeated choruses onto successive occurrences instead of the first one.
 */
export function alignLyrics(
  rawLyrics: string,
  transcript: Transcript,
  overrides: Partial<AlignerOptions> = {},
  lexicon: Lexicon = EMPTY_LEXICON,
): AlignmentResult {
  const opt: AlignerOptions = { ...DEFAULT_ALIGNER_OPTIONS, ...overrides };
  const lines = parseLyricLines(rawLyrics);
  if (lines.length === 0) return { ok: false, reason: 'EMPTY_LYRICS', quality: 0 };

  const asr = buildAsrWords(transcript);
  if (asr.length === 0) return { ok: false, reason: 'EMPTY_TRANSCRIPT', quality: 0 };

  const lyricWords: { lineIdx: number; norm: string }[] = [];
  lines.forEach((l, lineIdx) => l.tokens.forEach((norm) => lyricWords.push({ lineIdx, norm })));

  const n = lyricWords.length;
  const m = asr.length;
  if ((n + 1) * (m + 1) > opt.maxCells) return { ok: false, reason: 'TOO_LARGE', quality: 0 };

  const w = m + 1;
  const score = new Float32Array((n + 1) * w);
  const trace = new Uint8Array((n + 1) * w);
  // Row 0: free ASR prefix. Column 0: skipping lyric words costs gapLyric each.
  for (let i = 1; i <= n; i++) {
    score[i * w] = i * opt.gapLyric;
    trace[i * w] = UP;
  }
  for (let j = 1; j <= m; j++) trace[j] = LEFT;

  for (let i = 1; i <= n; i++) {
    const lw = lyricWords[i - 1]?.norm ?? '';
    for (let j = 1; j <= m; j++) {
      const aw = asr[j - 1]?.norm ?? '';
      let best = (score[(i - 1) * w + j] ?? 0) + opt.gapLyric;
      let dir = UP;
      const left = (score[i * w + j - 1] ?? 0) + opt.gapAsr;
      if (left > best) {
        best = left;
        dir = LEFT;
      }
      const s = wordScore(lw, aw, opt.matchThreshold, lexicon);
      if (s > Number.NEGATIVE_INFINITY) {
        const diag = (score[(i - 1) * w + j - 1] ?? 0) + s;
        if (diag >= best) {
          best = diag;
          dir = DIAG;
        }
      }
      score[i * w + j] = best;
      trace[i * w + j] = dir;
    }
  }

  // Free ASR suffix: pick best end column on the last row.
  let endJ = 0;
  let endScore = Number.NEGATIVE_INFINITY;
  for (let j = 0; j <= m; j++) {
    const v = score[n * w + j] ?? 0; // ASR suffix is free
    if (v > endScore) {
      endScore = v;
      endJ = j;
    }
  }

  // Backtrack.
  const matchOfLyric = new Array<number>(n).fill(-1);
  let i = n;
  let j = endJ;
  while (i > 0) {
    const dir = trace[i * w + j];
    if (dir === DIAG) {
      matchOfLyric[i - 1] = j - 1;
      i--;
      j--;
    } else if (dir === LEFT && j > 0) {
      j--;
    } else {
      i--;
    }
  }

  const result = buildLines(lines, lyricWords, asr, matchOfLyric, opt);
  if (!result.ok) return result;
  // Spelling differences between what was sung (ASR) and the official lyrics: material for the trainable lexicon.
  const learned: LearnedPair[] = [];
  if (result.quality >= LEARN_MIN_QUALITY) {
    const anchors: { i: number; j: number }[] = [];
    matchOfLyric.forEach((j, i) => {
      if (j >= 0) anchors.push({ i, j });
    });
    // (a) near-miss spellings that were matched by similarity
    for (const { i, j } of anchors) {
      const a = asr[j];
      const l = lyricWords[i];
      if (a && l && a.norm !== l.norm) learned.push({ asr: a.norm, lyric: l.norm });
    }
    // (b) a single lyric word and a single ASR word sitting between the same two anchors: a real substitution
    // (e.g. sung "cuz" vs written "because"). This is what lets the lexicon fix alignments similarity alone cannot.
    for (let k = 0; k + 1 < anchors.length; k++) {
      const p = anchors[k];
      const n = anchors[k + 1];
      if (!p || !n || n.i - p.i !== 2 || n.j - p.j !== 2) continue;
      const a = asr[p.j + 1];
      const l = lyricWords[p.i + 1];
      if (a && l && a.norm !== l.norm) learned.push({ asr: a.norm, lyric: l.norm });
    }
  }
  return { ...result, learned };
}

/** Only well-aligned songs teach the lexicon (poor alignments would teach garbage). */
const LEARN_MIN_QUALITY = 0.6;

function buildLines(
  lines: { text: string; tokens: string[] }[],
  lyricWords: { lineIdx: number; norm: string }[],
  asr: AsrWord[],
  matchOfLyric: number[],
  opt: AlignerOptions,
): AlignmentResult {
  const matched = matchOfLyric.filter((x) => x >= 0).length;
  const quality = lyricWords.length === 0 ? 0 : matched / lyricWords.length;
  if (quality < opt.minCoverage) return { ok: false, reason: 'LOW_COVERAGE', quality };

  interface Anchor {
    start: number;
    end: number;
    confidence: number;
  }
  const anchors: (Anchor | null)[] = lines.map(() => null);
  const lineWordCount = lines.map((l) => l.tokens.length);
  const lineMatched = lines.map(() => 0);
  const lineSimSum = lines.map(() => 0);

  lyricWords.forEach((lw, idx) => {
    const j = matchOfLyric[idx] ?? -1;
    const a = j >= 0 ? asr[j] : undefined;
    if (!a) return;
    const li = lw.lineIdx;
    lineMatched[li] = (lineMatched[li] ?? 0) + 1;
    lineSimSum[li] = (lineSimSum[li] ?? 0) + similarity(lw.norm, a.norm);
    const cur = anchors[li];
    anchors[li] = cur
      ? { start: cur.start, end: Math.max(cur.end, a.end), confidence: 0 }
      : { start: a.start, end: a.end, confidence: 0 };
  });

  const result: AlignedLine[] = new Array<AlignedLine>(lines.length);
  const conf = (li: number): number => {
    const words = lineWordCount[li] ?? 1;
    const mt = lineMatched[li] ?? 0;
    return mt === 0 ? 0.1 : ((lineSimSum[li] ?? 0) / words) * 0.9 + 0.1 * (mt / words);
  };

  let idx = 0;
  while (idx < lines.length) {
    const a = anchors[idx];
    if (a) {
      result[idx] = { start: a.start, end: a.end, text: lines[idx]?.text ?? '', confidence: round(conf(idx)) };
      idx++;
      continue;
    }
    // Gap run [idx, runEnd) of unanchored lines.
    let runEnd = idx;
    while (runEnd < lines.length && !anchors[runEnd]) runEnd++;
    const prev = idx > 0 ? result[idx - 1] : undefined;
    const next = runEnd < lines.length ? anchors[runEnd] : null;
    const words = lineWordCount.slice(idx, runEnd).reduce((s, x) => s + x, 0);
    let from: number;
    let to: number;
    if (prev && next) {
      from = prev.end;
      to = Math.max(from, next.start);
    } else if (next) {
      to = next.start;
      from = Math.max(0, to - words * opt.fallbackWordSeconds);
    } else if (prev) {
      from = prev.end;
      to = from + words * opt.fallbackWordSeconds;
    } else {
      from = 0;
      to = words * opt.fallbackWordSeconds;
    }
    let cursor = from;
    for (let k = idx; k < runEnd; k++) {
      const share = words === 0 ? 0 : ((lineWordCount[k] ?? 0) / words) * (to - from);
      result[k] = { start: round(cursor), end: round(cursor + share), text: lines[k]?.text ?? '', confidence: round(conf(k)) };
      cursor += share;
    }
    idx = runEnd;
  }

  // Enforce non-decreasing, non-overlapping timings.
  let lastEnd = 0;
  for (const l of result) {
    if (l.start < lastEnd) l.start = lastEnd;
    if (l.end < l.start) l.end = l.start;
    l.start = round(l.start);
    l.end = round(l.end);
    lastEnd = l.end;
  }
  return { ok: true, lines: result, quality: round(quality), learned: [] };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
