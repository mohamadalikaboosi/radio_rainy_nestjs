import { extractHashtags, extractLyricsUrl, normalizeHashtag, parseCaption } from './caption-parser';

describe('parseCaption', () => {
  it('parses the canonical example', () => {
    const p = parseCaption('Artist - Song Name\n\nAlbum: Example Album\n\nLyrics:\nhttps://telegra.ph/example-song-lyrics');
    expect(p).toMatchObject({
      title: 'Song Name',
      artist: 'Artist',
      album: 'Example Album',
      lyricsUrl: 'https://telegra.ph/example-song-lyrics',
    });
  });

  it('prefers audio attributes for title/artist', () => {
    const p = parseCaption('whatever\n#rain', { title: 'T', performer: 'P' });
    expect(p).toMatchObject({ title: 'T', artist: 'P' });
  });

  it('falls back to file name, then Unknown title', () => {
    expect(parseCaption(undefined, { fileName: 'Some Artist - Some Song.mp3' })).toMatchObject({ artist: 'Some Artist', title: 'Some Song' });
    expect(parseCaption('', {}).title).toBe('Unknown title');
  });

  it('ignores hashtag-only and url-only lines when picking the title line', () => {
    const p = parseCaption('#rain #night\nhttps://telegra.ph/x-01\nBand — Track');
    expect(p).toMatchObject({ artist: 'Band', title: 'Track' });
  });
});

describe('extractLyricsUrl', () => {
  it.each([
    ['see https://telegra.ph/Song-09-30 now', 'https://telegra.ph/Song-09-30'],
    ['Lyrics: telegra.ph/Song-09-30.', 'https://telegra.ph/Song-09-30'],
    ['(https://telegra.ph/Song-09-30)', 'https://telegra.ph/Song-09-30'],
    ['HTTP://TELEGRA.PH/Song', 'https://telegra.ph/Song'],
    ['https://graph.org/Song-1', 'https://graph.org/Song-1'],
    ['https://telegra.ph/Song?x=1#frag', 'https://telegra.ph/Song'],
  ])('%s', (text, expected) => {
    expect(extractLyricsUrl(text)).toBe(expected);
  });

  it('ignores non-Telegraph links and the bare host', () => {
    expect(extractLyricsUrl('https://example.com/a https://telegra.ph/')).toBeUndefined();
    expect(extractLyricsUrl('no links here')).toBeUndefined();
    expect(extractLyricsUrl('https://evil.com/telegra.ph/x')).toBeUndefined();
  });

  it('uses hidden entity URLs first', () => {
    expect(extractLyricsUrl('Lyrics', ['https://telegra.ph/hidden-1'])).toBe('https://telegra.ph/hidden-1');
  });
});

describe('hashtags', () => {
  it('extracts, dedupes case-insensitively and keeps display value', () => {
    const tags = extractHashtags('Song\n\n#Rain\n#night #RAIN #chill.\n#1 #');
    expect(tags.map((t) => t.normalized)).toEqual(['rain', 'night', 'chill']);
    expect(tags[0]?.value).toBe('Rain');
  });
  it('supports Persian hashtags and normalizes variants', () => {
    expect(extractHashtags('#باران #شب_بارانی')).toHaveLength(2);
    expect(normalizeHashtag('كتاب')).toBe(normalizeHashtag('کتاب'));
  });
  it('does not treat url fragments as hashtags', () => {
    expect(extractHashtags('https://telegra.ph/x#frag')).toEqual([]);
  });
});
