import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioMsg, FakeTelegramGateway } from '../../../test/fake-telegram';
import { InlineQueue } from '../../../test/inline-queue';
import { freshDb } from '../../../test/test-db';
import { LyricsAlignmentService } from './lyrics-alignment.service';
import { LexiconRepository } from './lexicon';
import { DatabaseService } from '../../shared/infrastructure/database/database.service';
import { LyricsError } from '../domain/lyrics.errors';
import { LyricsRepository } from '../infrastructure/lyrics.repository';
import { LyricsService } from './lyrics.service';
import { LyricsSource } from './ports/lyrics-source';
import { TelegramTrackDiscovery } from '../../catalog/application/track-discovery';
import { TrackRepository } from '../../catalog/infrastructure/persistence/track.repository';
import { AudioPreprocessor } from '../infrastructure/audio-preprocessor';
import { TrackTranscriptionService } from './track-transcription.service';
import { TranscriptionError } from '../domain/transcription.errors';
import { AudioInput, Transcript, TranscriptionProvider } from '../domain/transcription.types';
import { LyricsPipeline } from './lyrics-pipeline';

const LYRICS = 'Hello my friend\nWelcome to the night\nWe are walking home';
const GOOD: Transcript = {
  provider: 'fake',
  model: 'fake-1',
  segments: [
    { start: 1.2, end: 4.8, text: 'hello my friend' },
    { start: 5.1, end: 8.9, text: 'welcome to the night' },
    { start: 9.2, end: 13.4, text: 'we are walking home' },
  ],
};

class FakeSource implements LyricsSource {
  calls: string[] = [];
  pages = new Map<string, string | LyricsError>();
  async fetch(url: string): Promise<string> {
    this.calls.push(url);
    const p = this.pages.get(url);
    if (p instanceof Error) throw p;
    if (p === undefined) throw new LyricsError('NOT_FOUND', 'nope');
    return p;
  }
}

class FakeWhisper implements TranscriptionProvider {
  calls = 0;
  failures: Error[] = [];
  result: Transcript = GOOD;
  inputs: string[] = [];
  async transcribe(input: AudioInput): Promise<Transcript> {
    this.calls++;
    this.inputs.push(readFileSync(input.filePath, 'utf8'));
    const f = this.failures.shift();
    if (f) throw f;
    return this.result;
  }
}

const copyPre: AudioPreprocessor = {
  async toWhisperInput(i, o) {
    writeFileSync(o, `prepared:${readFileSync(i, 'utf8')}`);
  },
};

describe('lyrics pipeline', () => {
  let db: DatabaseService;
  let gw: FakeTelegramGateway;
  let src: FakeSource;
  let whisper: FakeWhisper;
  let queue: InlineQueue;
  let pipeline: LyricsPipeline;
  let tracks: TrackRepository;
  let lyricsRepo: LyricsRepository;
  let discovery: TelegramTrackDiscovery;

  async function setup(withWhisper = true): Promise<void> {
    db = await freshDb();
    tracks = new TrackRepository(db);
    lyricsRepo = new LyricsRepository(db);
    gw = new FakeTelegramGateway();
    src = new FakeSource();
    whisper = new FakeWhisper();
    queue = new InlineQueue(3);
    const transcription = new TrackTranscriptionService(
      { current: async () => (withWhisper ? { provider: whisper, identity: { provider: 'fake', model: 'fake-1' }, language: undefined, sampleRate: 48000 } : null) },
      gw,
      copyPre,
      tracks,
      lyricsRepo,
      mkdtempSync(join(tmpdir(), 'rr-')),
    );
    pipeline = new LyricsPipeline(queue, new LyricsService(src, lyricsRepo, tracks, 3600), transcription, new LyricsAlignmentService(lyricsRepo, new LexiconRepository(db), tracks), tracks);
    queue.pipeline = pipeline;
    discovery = new TelegramTrackDiscovery(gw, tracks, { onLyricsNeedFetch: (id) => pipeline.start(id) });
    gw.add(audioMsg(1, 'Artist - Song\nLyrics: https://telegra.ph/song-1\n#rain'), [Buffer.from('AUDIO-1')]);
  }
  afterEach(() => db.onModuleDestroy());

  const status = async (msg = 1) =>
    (await db.query<{ lyrics_status: string; lyrics_error: string | null; id: string }>(`SELECT id, lyrics_status, lyrics_error FROM tracks WHERE telegram_message_id = $1`, [msg])).rows[0];

  it('happy path: discover -> fetch -> transcribe -> align -> LYRICS_READY, audio streamed to Whisper', async () => {
    await setup();
    src.pages.set('https://telegra.ph/song-1', LYRICS);
    await discovery.sync('1001');
    expect((await status())?.lyrics_status).toBe('LYRICS_PENDING');
    await queue.drain();
    const t = await status();
    expect(t?.lyrics_status).toBe('LYRICS_READY');
    const synced = await lyricsRepo.getLatestSynced(t?.id ?? '');
    expect(synced?.version).toBe(1);
    expect(synced?.lines.map((l) => l.text)).toEqual(['Hello my friend', 'Welcome to the night', 'We are walking home']);
    expect(synced?.lines[1]?.start).toBeCloseTo(5.1, 1);
    expect(whisper.inputs[0]).toBe('prepared:AUDIO-1');
  });

  it('Telegraph 404 -> LYRICS_FAILED without retries; nothing else runs', async () => {
    await setup();
    await discovery.sync('1001');
    await queue.drain();
    expect(await status()).toMatchObject({ lyrics_status: 'LYRICS_FAILED', lyrics_error: 'NOT_FOUND' });
    expect(queue.history).toEqual(['fetch#1']);
    expect(whisper.calls).toBe(0);
  });

  it('Telegraph network errors are retried with attempts, then succeed', async () => {
    await setup();
    let n = 0;
    src.fetch = async () => {
      if (++n < 3) throw new LyricsError('NETWORK', 'down');
      return LYRICS;
    };
    await discovery.sync('1001');
    await queue.drain();
    expect(queue.history.filter((h) => h.startsWith('fetch'))).toEqual(['fetch#1', 'fetch#2', 'fetch#3']);
    expect((await status())?.lyrics_status).toBe('LYRICS_READY');
  });

  it('Whisper unavailable: retries, then LYRICS_FAILED; track stays playable', async () => {
    await setup();
    src.pages.set('https://telegra.ph/song-1', LYRICS);
    whisper.failures = [1, 2, 3].map(() => new TranscriptionError('503', true));
    await discovery.sync('1001');
    await queue.drain();
    expect((await status())?.lyrics_status).toBe('LYRICS_FAILED');
    expect(whisper.calls).toBe(3);
    expect((await db.query(`SELECT status FROM tracks`)).rows[0]).toEqual({ status: 'READY' });
  });

  it('non-retryable Whisper error fails immediately without retries', async () => {
    await setup();
    src.pages.set('https://telegra.ph/song-1', LYRICS);
    whisper.failures = [new TranscriptionError('400 bad audio', false)];
    await discovery.sync('1001');
    await queue.drain();
    expect(whisper.calls).toBe(1);
    expect((await status())?.lyrics_status).toBe('LYRICS_FAILED');
  });

  it('invalid lyrics (unrelated to audio) -> alignment LOW_COVERAGE -> LYRICS_FAILED', async () => {
    await setup();
    src.pages.set('https://telegra.ph/song-1', 'completely unrelated words here\nnothing matches at all');
    await discovery.sync('1001');
    await queue.drain();
    expect(await status()).toMatchObject({ lyrics_status: 'LYRICS_FAILED', lyrics_error: 'LOW_COVERAGE' });
  });

  it('Whisper not configured: raw lyrics fetched, no transcription, no error status', async () => {
    await setup(false);
    src.pages.set('https://telegra.ph/song-1', LYRICS);
    await discovery.sync('1001');
    await queue.drain();
    expect(await status()).toMatchObject({ lyrics_status: 'LYRICS_NONE', lyrics_error: 'SYNC_DISABLED' });
    expect((await lyricsRepo.getLyrics((await status())?.id ?? ''))?.rawText).toBe(LYRICS);
    expect(queue.history).toEqual(['fetch#1']);
  });

  it('reprocess is idempotent: cached Telegraph + transcript, no new synced version', async () => {
    await setup();
    src.pages.set('https://telegra.ph/song-1', LYRICS);
    await discovery.sync('1001');
    await queue.drain();
    const id = (await status())?.id ?? '';
    await pipeline.start(id);
    await queue.drain();
    expect(src.calls).toHaveLength(1);
    expect(whisper.calls).toBe(1);
    expect((await lyricsRepo.getLatestSynced(id))?.version).toBe(1);
    expect((await status())?.lyrics_status).toBe('LYRICS_READY');
  });

  it('force reprocess refetches and re-transcribes; changed result creates version 2', async () => {
    await setup();
    src.pages.set('https://telegra.ph/song-1', LYRICS);
    await discovery.sync('1001');
    await queue.drain();
    const id = (await status())?.id ?? '';
    whisper.result = { ...GOOD, segments: GOOD.segments.map((s) => ({ ...s, start: s.start + 1, end: s.end + 1 })) };
    await pipeline.start(id, { force: true });
    await queue.drain();
    expect(src.calls).toHaveLength(2);
    expect(whisper.calls).toBe(2);
    expect((await lyricsRepo.getLatestSynced(id))?.version).toBe(2);
  });

  it('two tracks sharing a Telegraph URL fetch it once', async () => {
    await setup();
    src.pages.set('https://telegra.ph/song-1', LYRICS);
    gw.add(audioMsg(2, 'Other - Song\nLyrics: https://telegra.ph/song-1'), [Buffer.from('AUDIO-2')]);
    await discovery.sync('1001');
    await queue.drain();
    expect(src.calls).toHaveLength(1);
    expect((await status(2))?.lyrics_status).toBe('LYRICS_READY');
  });
});
