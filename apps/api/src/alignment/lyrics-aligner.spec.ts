import { alignLyrics } from './lyrics-aligner';
import { normalizeText, parseLyricLines } from './normalize';
import { Transcript, TranscriptWord } from '../transcription/transcription.types';

const seg = (start: number, end: number, text: string) => ({ start, end, text });
const tr = (segments: Transcript['segments'], words?: TranscriptWord[]): Transcript => ({
  segments,
  words,
  provider: 't',
  model: 't',
});

describe('normalize', () => {
  it('handles punctuation, case, apostrophes, whitespace', () => {
    expect(normalizeText("  Don't   STOP,  believin'! ")).toBe('dont stop believin');
  });
  it('unifies Arabic/Persian letter variants and ZWNJ', () => {
    expect(normalizeText('كتاب‌ي')).toBe(normalizeText('کتاب ی'));
  });
  it('drops section markers and blank lines', () => {
    const lines = parseLyricLines('[Chorus]\nHello there\n\n(x2)\nSecond line');
    expect(lines.map((l) => l.text)).toEqual(['Hello there', 'Second line']);
  });
});

describe('alignLyrics', () => {
  const lyrics = 'Hello my friend\nWelcome to the night\nWe are walking home';

  it('aligns one line per segment', () => {
    const r = alignLyrics(
      lyrics,
      tr([seg(1.2, 4.8, 'hello my friend'), seg(5.1, 8.9, 'welcome to the night'), seg(9.2, 13.4, 'we are walking home')]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => l.text)).toEqual(['Hello my friend', 'Welcome to the night', 'We are walking home']);
    expect(r.lines[0]?.start).toBeCloseTo(1.2, 1);
    expect(r.lines[1]?.start).toBeCloseTo(5.1, 1);
    expect(r.lines[2]?.end).toBeCloseTo(13.4, 1);
    expect(r.quality).toBe(1);
  });

  it('is robust to punctuation/case differences and minor ASR errors', () => {
    const r = alignLyrics(
      "Hello, my friend!\nWelcome to the night...\nWe're walking home",
      tr([seg(1, 4, 'Hallo my frend'), seg(5, 9, 'welcome too the night'), seg(9, 13, 'were walkin home')]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[1]?.start).toBeGreaterThanOrEqual(4.9);
    expect(r.lines[2]?.start).toBeGreaterThanOrEqual(8.9);
  });

  it('splits several lyric lines inside one segment (degraded mode, no word timestamps)', () => {
    const r = alignLyrics('aaa bbb\nccc ddd', tr([seg(0, 8, 'aaa bbb ccc ddd')]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[0]?.start).toBeCloseTo(0, 1);
    expect(r.lines[0]?.end).toBeCloseTo(4, 1);
    expect(r.lines[1]?.start).toBeCloseTo(4, 1);
  });

  it('uses word timestamps when available', () => {
    const words: TranscriptWord[] = [
      { start: 10, end: 10.5, text: 'hello' },
      { start: 10.6, end: 11, text: 'world' },
      { start: 20, end: 20.5, text: 'again' },
      { start: 20.6, end: 21, text: 'friend' },
    ];
    const r = alignLyrics('hello world\nagain friend', tr([seg(10, 21, 'hello world again friend')], words));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[0]).toMatchObject({ start: 10, end: 11 });
    expect(r.lines[1]).toMatchObject({ start: 20, end: 21 });
  });

  it('maps repeated chorus onto successive occurrences in time', () => {
    const sheet = 'la la love you\nverse one here\nla la love you\nverse two here\nla la love you';
    const r = alignLyrics(
      sheet,
      tr([
        seg(0, 4, 'la la love you'),
        seg(5, 9, 'verse one here'),
        seg(10, 14, 'la la love you'),
        seg(15, 19, 'verse two here'),
        seg(20, 24, 'la la love you'),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => Math.round(l.start))).toEqual([0, 5, 10, 15, 20]);
  });

  it('interpolates lines missing from the transcript', () => {
    const r = alignLyrics(
      'first line here\nmissing words entirely xyzzy\nlast line there',
      tr([seg(0, 4, 'first line here'), seg(12, 16, 'last line there')]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mid = r.lines[1];
    expect(mid?.start).toBeGreaterThanOrEqual(4);
    expect(mid?.end).toBeLessThanOrEqual(12);
    expect(mid?.confidence).toBeLessThan(0.5);
  });

  it('ignores hallucinated / ad-lib ASR words', () => {
    const r = alignLyrics(
      'sun goes down\nmoon comes up',
      tr([seg(0, 2, 'ooh yeah'), seg(2, 5, 'sun goes down'), seg(5, 6, 'yeah yeah'), seg(6, 9, 'moon comes up')]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[0]?.start).toBeCloseTo(2, 1);
    expect(r.lines[1]?.start).toBeCloseTo(6, 1);
  });

  it('fails with LOW_COVERAGE when transcript is unrelated', () => {
    const r = alignLyrics(lyrics, tr([seg(0, 5, 'completely different text about cars')]));
    expect(r).toMatchObject({ ok: false, reason: 'LOW_COVERAGE' });
  });

  it('fails clearly on empty inputs', () => {
    expect(alignLyrics('  \n [Chorus] ', tr([seg(0, 1, 'a b')]))).toMatchObject({ ok: false, reason: 'EMPTY_LYRICS' });
    expect(alignLyrics('hello', tr([]))).toMatchObject({ ok: false, reason: 'EMPTY_TRANSCRIPT' });
  });

  it('aligns Persian lyrics', () => {
    const r = alignLyrics('شب بارونی بود\nتو رفتی از پیشم', tr([seg(1, 4, 'شب بارونی بود'), seg(5, 8, 'تو رفتی از پیشم')]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[1]?.start).toBeCloseTo(5, 1);
  });

  it('is deterministic and monotonic', () => {
    const t = tr([seg(0, 4, 'hello my friend'), seg(5, 9, 'welcome to the night'), seg(9, 13, 'we are walking home')]);
    const a = alignLyrics(lyrics, t);
    const b = alignLyrics(lyrics, t);
    expect(a).toEqual(b);
    if (!a.ok) throw new Error('unexpected');
    for (let i = 1; i < a.lines.length; i++) {
      expect(a.lines[i]!.start).toBeGreaterThanOrEqual(a.lines[i - 1]!.end);
    }
  });
});

import { detectLanguage, whisperLanguage } from '../language/language-detect';
import { lexiconFrom } from '../language/lexicon';

describe('language detection', () => {
  it('detects Persian, English, mixed and unknown', () => {
    expect(detectLanguage('شب بارونی بود تو رفتی از پیشم')).toBe('fa');
    expect(detectLanguage('Hello my friend welcome to the night')).toBe('en');
    expect(detectLanguage('دوستت دارم my love forever و همیشه')).toBe('mixed');
    expect(detectLanguage('la la')).toBe('unknown');
    expect(whisperLanguage('fa')).toBe('fa');
    expect(whisperLanguage('mixed')).toBeUndefined();
  });
});

describe('trainable lexicon', () => {
  const t = tr([seg(0, 3, 'stay with me cuz you are here'), seg(3, 6, 'hold me close tonight')]);
  const lyricsText = 'stay with me because you are here\nhold me close tonight';

  it('learns single-word substitutions between anchors (what it will use next time)', () => {
    const r = alignLyrics(lyricsText, t);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.learned).toContainEqual({ asr: 'cuz', lyric: 'because' });
    expect(r.quality).toBeLessThan(1);
  });

  it('a trusted lexicon entry makes the variant count as a match (higher quality, nothing left to learn)', () => {
    const lex = lexiconFrom(new Map([['cuz', new Set(['because'])]]));
    const r = alignLyrics(lyricsText, t, {}, lex);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quality).toBe(1);
    expect(r.lines[0]?.confidence).toBeGreaterThan(0.9);
  });

  it('does not learn from poor alignments (no garbage in the lexicon)', () => {
    const r = alignLyrics('aaa bbb ccc ddd eee', tr([seg(0, 3, 'aaa xxx ccc zzz eee qqq www')]), { minCoverage: 0.1 });
    if (r.ok) expect(r.quality < 0.6 ? r.learned : []).toEqual([]);
  });
});
