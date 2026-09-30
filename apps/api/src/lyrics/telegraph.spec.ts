import { LyricsError } from './lyrics.errors';
import { FetchFn, TelegraphLyricsSource, telegraphPathFromUrl } from './telegraph-lyrics-source';
import { htmlToText, nodesToText } from './telegraph-parser';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const html = (body: string, status = 200) => ({ ok: status < 400, status, json: async () => ({}), text: async () => body });

describe('nodesToText', () => {
  it('keeps <br> line breaks and separates paragraphs with a blank line', () => {
    const text = nodesToText([
      { tag: 'p', children: ['Line one', { tag: 'br' }, 'Line two'] },
      { tag: 'p', children: ['Line ', { tag: 'em', children: ['three'] }] },
    ]);
    expect(text).toBe('Line one\nLine two\n\nLine three');
  });
  it('skips images/figures and decodes nbsp', () => {
    expect(nodesToText([{ tag: 'figure', children: [{ tag: 'img' }] }, { tag: 'p', children: ['a b'] }])).toBe('a b');
  });
  it('returns empty for empty content', () => {
    expect(nodesToText([])).toBe('');
    expect(nodesToText([{ tag: 'p', children: ['  '] }])).toBe('');
  });
});

describe('htmlToText', () => {
  it('extracts lyrics without depending on class names, dropping title and author', () => {
    const page = `<html><body><header><h1>Song Title</h1><address>Author</address></header>
      <article id="_tl_editor" class="whatever-changed"><h1>Song Title</h1><address><a>Author</a></address>
      <p>Hello my friend<br>Welcome to the night</p><p>We are walking home</p></article><footer>Edit</footer></body></html>`;
    expect(htmlToText(page)).toBe('Hello my friend\nWelcome to the night\n\nWe are walking home');
  });
  it('works with a completely different structure', () => {
    expect(htmlToText('<div><div>only text</div></div>')).toBe('only text');
  });
});

describe('telegraphPathFromUrl', () => {
  it('accepts telegraph URLs and rejects others (SSRF safe)', () => {
    expect(telegraphPathFromUrl('https://telegra.ph/Song-09-30')).toBe('Song-09-30');
    for (const bad of ['http://telegra.ph/x', 'https://evil.com/x', 'nonsense', 'https://telegra.ph/']) {
      expect(() => telegraphPathFromUrl(bad)).toThrow(LyricsError);
    }
  });
});

describe('TelegraphLyricsSource', () => {
  const url = 'https://telegra.ph/Song-09-30';
  it('uses the JSON API', async () => {
    const f: FetchFn = async () => json({ ok: true, result: { content: [{ tag: 'p', children: ['Hi', { tag: 'br' }, 'there'] }] } });
    expect(await new TelegraphLyricsSource(f).fetch(url)).toBe('Hi\nthere');
  });
  it('maps missing page to NOT_FOUND without HTML fallback', async () => {
    const calls: string[] = [];
    const f: FetchFn = async (u) => {
      calls.push(u);
      return json({ ok: false, error: 'PAGE_NOT_FOUND' });
    };
    await expect(new TelegraphLyricsSource(f).fetch(url)).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(calls).toHaveLength(1);
  });
  it('falls back to HTML when the API breaks', async () => {
    const f: FetchFn = async (u) => (u.startsWith('https://api.') ? json('garbage-not-ok', 500) : html('<article><p>fallback text</p></article>'));
    const src = new TelegraphLyricsSource(async (u, i) => {
      const r = await f(u, i);
      if (u.startsWith('https://api.')) return { ...r, json: async () => { throw new Error('bad json'); } };
      return r;
    });
    expect(await src.fetch(url)).toBe('fallback text');
  });
  it('network errors are retryable', async () => {
    const f: FetchFn = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(new TelegraphLyricsSource(f).fetch(url)).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
  });
  it('empty pages raise EMPTY', async () => {
    const f: FetchFn = async () => json({ ok: true, result: { content: [{ tag: 'p', children: [' '] }] } });
    await expect(new TelegraphLyricsSource(f).fetch(url)).rejects.toMatchObject({ code: 'EMPTY' });
  });
  it('invalid URL is rejected before any request', async () => {
    const f = jest.fn();
    await expect(new TelegraphLyricsSource(f as unknown as FetchFn).fetch('https://evil.com/x')).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(f).not.toHaveBeenCalled();
  });
});
