import { freshDb } from '../../../test/test-db';
import { LyricsAlignmentService } from './lyrics-alignment.service';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { LyricsRepository } from './ports/lyrics.repository';
import { PgLyricsRepository } from '../infrastructure/lyrics.repository';
import { TrackRepository } from '../../catalog/application/ports/track.repository';
import { PgTrackRepository } from '../../catalog/infrastructure/persistence/track.repository';
import { LanguageService, parseReview } from './language.service';
import { LexiconRepository } from './lexicon';
import { LlmNotConfiguredError, OpenAiCompatibleLlm } from '../infrastructure/llm-client';

describe('parseReview', () => {
  it('extracts the JSON array even when the LLM adds prose or code fences', () => {
    const m = parseReview('Here you go:\n```json\n[{"id":1,"same":true},{"id":2,"same":false},{"id":"x","same":true},{"id":3}]\n```');
    expect([...m.entries()]).toEqual([[1, true], [2, false]]);
    expect(parseReview('no json here').size).toBe(0);
    expect(parseReview('[broken').size).toBe(0);
  });
});

describe('OpenAiCompatibleLlm', () => {
  const settings = (v: { enabled: true; url: string; model: string; apiKey?: string } | null) => ({ llm: async () => (v ? { ...v, apiKey: v.apiKey } : null) });
  it('calls {url}/chat/completions with model + bearer key and returns the content', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
    const llm = new OpenAiCompatibleLlm(settings({ enabled: true, url: 'http://localhost:11434/v1/', model: 'qwen', apiKey: 'K' }), async (url, init) => {
      seen = { url, headers: init.headers, body: init.body };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) };
    });
    expect(await llm.chat([{ role: 'user', content: 'x' }])).toBe('hi');
    expect(seen?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(seen?.headers.Authorization).toBe('Bearer K');
    expect(JSON.parse(seen?.body ?? '{}')).toMatchObject({ model: 'qwen', temperature: 0 });
  });
  it('is off when not configured, and surfaces HTTP errors', async () => {
    await expect(new OpenAiCompatibleLlm(settings(null)).chat([])).rejects.toBeInstanceOf(LlmNotConfiguredError);
    const bad = new OpenAiCompatibleLlm(settings({ enabled: true, url: 'http://x', model: '' }), async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(bad.chat([])).rejects.toThrow(/LLM HTTP 500/);
  });
});

describe('language learning end to end (real DB)', () => {
  let db: DatabaseService;
  let lyrics: LyricsRepository;
  let tracks: TrackRepository;
  let lexicon: LexiconRepository;
  let align: LyricsAlignmentService;

  beforeEach(async () => {
    db = await freshDb();
    lyrics = new PgLyricsRepository(db);
    tracks = new PgTrackRepository(db);
    lexicon = new LexiconRepository(db);
    align = new LyricsAlignmentService(lyrics, lexicon, tracks);
  });
  afterEach(() => db.onModuleDestroy());

  async function song(n: number, raw: string, asrText: string): Promise<{ trackId: string; transcriptId: string }> {
    const t = await db.query<{ id: string }>(`INSERT INTO tracks (telegram_channel_id, telegram_message_id, title, telegram_file_reference) VALUES (1001, $1, $2, 'r') RETURNING id`, [n, `S${n}`]);
    const trackId = t.rows[0]?.id ?? '';
    await lyrics.saveFetched(trackId, `https://telegra.ph/s-${n}`, raw, 3600);
    await tracks.setLyricsLanguage(trackId, 'en');
    const words = asrText.split(' ');
    const transcriptId = await lyrics.saveTranscript(trackId, `h${n}`, {
      provider: 'fake', model: 'm',
      segments: [{ start: 0, end: words.length, text: asrText }],
    });
    return { trackId, transcriptId };
  }

  it('learns a spelling variant from songs, trusts it after 2 observations, and it improves the next alignment', async () => {
    const a = await song(1, 'stay with me because you are here tonight', 'stay with me cuz you are here tonight');
    const first = await align.alignTrack(a.trackId, a.transcriptId);
    expect(first.kind === 'ALIGNED' && first.learned).toBeGreaterThan(0);
    // one observation is not trusted yet
    expect((await lexicon.list({ lang: 'en', limit: 10, offset: 0 })).items[0]).toMatchObject({ asrWord: 'cuz', lyricWord: 'because', count: 1, status: 'LEARNED' });
    expect((await lexicon.lexicon('en')).equivalent('cuz', 'because')).toBe(false);

    // re-running the SAME alignment must not inflate the count
    await align.alignTrack(a.trackId, a.transcriptId);
    expect((await lexicon.list({ lang: 'en', limit: 10, offset: 0 })).items[0]?.count).toBe(1);

    // a second song with the same variant -> trusted
    const b = await song(2, 'hold me close because you are mine forever', 'hold me close cuz you are mine forever');
    await align.alignTrack(b.trackId, b.transcriptId);
    expect((await lexicon.list({ lang: 'en', limit: 10, offset: 0 })).items[0]?.count).toBe(2);
    expect((await lexicon.lexicon('en')).equivalent('cuz', 'because')).toBe(true);

    // a third song now aligns fully thanks to what was learned
    const c = await song(3, 'run away because the night is young', 'run away cuz the night is young');
    const out = await align.alignTrack(c.trackId, c.transcriptId);
    expect(out.kind).toBe('ALIGNED');
    expect(out.kind === 'ALIGNED' && out.synced.quality).toBe(1);
  });

  it('rejected entries are never used; approved entries are trusted immediately', async () => {
    await lexicon.learn('en', [{ asr: 'gonna', lyric: 'goingto' }]);
    expect((await lexicon.lexicon('en')).equivalent('gonna', 'goingto')).toBe(false);
    await lexicon.setStatus('en', 'gonna', 'goingto', 'APPROVED');
    expect((await lexicon.lexicon('en')).equivalent('gonna', 'goingto')).toBe(true);
    await lexicon.setStatus('en', 'gonna', 'goingto', 'REJECTED');
    expect((await lexicon.lexicon('en')).equivalent('gonna', 'goingto')).toBe(false);
  });

  it('retrain re-aligns transcribed songs with the current lexicon without calling Whisper', async () => {
    const a = await song(1, 'stay with me because you are here tonight', 'stay with me cuz you are here tonight');
    await align.alignTrack(a.trackId, a.transcriptId, { learn: false });
    await lexicon.learn('en', [{ asr: 'cuz', lyric: 'because' }]);
    await lexicon.setStatus('en', 'cuz', 'because', 'APPROVED');
    const svc = new LanguageService(db, lexicon, align, { chat: async () => '[]' });
    const r = await svc.retrain(50, 0);
    expect(r).toMatchObject({ processed: 1, improved: 1, total: 1 });
    expect((await lyrics.getLatestSynced(a.trackId))?.version).toBe(2);
  });
});
