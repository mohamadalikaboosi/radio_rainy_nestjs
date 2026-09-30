import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WhisperFetch, WhisperTranscriptionProvider } from './whisper-transcription.provider';

const dir = mkdtempSync(join(tmpdir(), 'whisper-'));
const file = join(dir, 'a.wav');
writeFileSync(file, Buffer.from('RIFFfake'));

const make = (fetchFn: WhisperFetch) =>
  new WhisperTranscriptionProvider({ url: 'http://w/v1/audio/transcriptions', model: 'm', apiKey: 'SECRET', timeoutMs: 1000 }, fetchFn);
const ok = (obj: unknown): ReturnType<WhisperFetch> => Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(obj) });

describe('WhisperTranscriptionProvider', () => {
  it('parses words and segments and sends auth + timestamp granularities', async () => {
    let seen: { headers: Record<string, string>; body: FormData } | undefined;
    const p = make((_u, init) => {
      seen = { headers: init.headers, body: init.body };
      return ok({
        language: 'en',
        segments: [{ start: 0, end: 2, text: ' hello world ' }],
        words: [
          { word: 'hello', start: 0, end: 1 },
          { word: 'world', start: 1, end: 2 },
        ],
      });
    });
    const t = await p.transcribe({ trackId: 't1', filePath: file });
    expect(t.segments[0]?.text).toBe('hello world');
    expect(t.words).toHaveLength(2);
    expect(seen?.headers.Authorization).toBe('Bearer SECRET');
    expect(seen?.body.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    expect(seen?.body.get('file')).toBeInstanceOf(Blob);
  });

  it('accepts words nested in segments (faster-whisper style)', async () => {
    const p = make(() => ok({ segments: [{ start: 0, end: 1, text: 'a', words: [{ word: 'a', start: 0, end: 1 }] }] }));
    expect((await p.transcribe({ trackId: 't', filePath: file })).words).toHaveLength(1);
  });

  it('classifies errors: 5xx/429/network retryable, 4xx and bad bodies not', async () => {
    const status = (s: number) => make(async () => ({ ok: false, status: s, text: async () => 'err' }));
    await expect(status(503).transcribe({ trackId: 't', filePath: file })).rejects.toMatchObject({ retryable: true });
    await expect(status(429).transcribe({ trackId: 't', filePath: file })).rejects.toMatchObject({ retryable: true });
    await expect(status(400).transcribe({ trackId: 't', filePath: file })).rejects.toMatchObject({ retryable: false });
    await expect(make(async () => Promise.reject(new Error('ECONNREFUSED'))).transcribe({ trackId: 't', filePath: file })).rejects.toMatchObject({ retryable: true });
    await expect(make(() => ok({ text: 'only text' })).transcribe({ trackId: 't', filePath: file })).rejects.toMatchObject({ retryable: false });
    await expect(make(async () => ({ ok: true, status: 200, text: async () => 'not json' })).transcribe({ trackId: 't', filePath: file })).rejects.toMatchObject({ retryable: false });
  });
});
