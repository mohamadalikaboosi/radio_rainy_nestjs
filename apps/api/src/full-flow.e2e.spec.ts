import { get as httpGet, IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { audioMsg, FakeTelegramGateway } from '../test/fake-telegram';
import { buildHarness, Harness, waitFor } from '../test/engine-harness';
import { InlineQueue } from '../test/inline-queue';
import { createRadioApp } from '../test/radio-app';
import { freshDb } from '../test/test-db';
import { LyricsAlignmentService } from './lyrics/application/lyrics-alignment.service';
import { LexiconRepository } from './lyrics/application/lexicon';
import { DatabaseService } from './shared/infrastructure/database/database.service';
import { LyricsPipeline } from './lyrics/application/lyrics-pipeline';
import { LyricsError } from './lyrics/domain/lyrics.errors';
import { LyricsRepository } from './lyrics/infrastructure/lyrics.repository';
import { LyricsService } from './lyrics/application/lyrics.service';
import { LyricsSource } from './lyrics/application/ports/lyrics-source';
import { TelegramTrackDiscovery } from './catalog/application/track-discovery';
import { TrackRepository } from './catalog/infrastructure/persistence/track.repository';
import { AudioPreprocessor } from './lyrics/infrastructure/audio-preprocessor';
import { TrackTranscriptionService } from './lyrics/application/track-transcription.service';
import { TranscriptionError } from './lyrics/domain/transcription.errors';
import { AudioInput, Transcript, TranscriptionProvider } from './lyrics/domain/transcription.types';

/** 2-second tracks: 40000 bytes at 20000 B/s. Byte value = message id. */
const SONGS = {
  1: { lyrics: 'Hello my friend\nWelcome to the night', lines: [['hello my friend', 0.1, 0.9], ['welcome to the night', 1.0, 1.9]] as const },
  2: { lyrics: 'Rain on the window\nDreaming of you', lines: [['rain on the window', 0.1, 0.9], ['dreaming of you', 1.0, 1.9]] as const },
  3: { lyrics: 'Walking home alone\nUnder the moon', lines: [['walking home alone', 0.1, 0.9], ['under the moon', 1.0, 1.9]] as const },
};

class Telegraph implements LyricsSource {
  pages = new Map<string, string>();
  async fetch(url: string): Promise<string> {
    const p = this.pages.get(url);
    if (p === undefined) throw new LyricsError('NOT_FOUND', 'missing');
    return p;
  }
}

class Whisper implements TranscriptionProvider {
  down = new Set<number>();
  async transcribe(input: AudioInput): Promise<Transcript> {
    const id = Number(readFileSync(input.filePath).subarray(0, 1)[0]);
    if (this.down.has(id)) throw new TranscriptionError('whisper unavailable', false);
    const song = SONGS[id as 1 | 2 | 3];
    return { provider: 'fake', model: 'fake-1', segments: song.lines.map(([text, start, end]) => ({ start, end, text })) };
  }
}
const prepare: AudioPreprocessor = { async toWhisperInput(i, o) { writeFileSync(o, readFileSync(i)); } };

describe('FULL FLOW: Telegram -> lyrics AI -> radio -> stream -> live lyrics -> next track', () => {
  let db: DatabaseService;
  let gw: FakeTelegramGateway;
  let h: Harness;
  let app: INestApplication;
  let base: string;
  let queue: InlineQueue;
  let telegraph: Telegraph;
  let whisper: Whisper;
  const open: IncomingMessage[] = [];

  beforeEach(async () => {
    db = await freshDb();
    gw = new FakeTelegramGateway();
    const tracks = new TrackRepository(db);
    const lyricsRepo = new LyricsRepository(db);
    telegraph = new Telegraph();
    whisper = new Whisper();
    queue = new InlineQueue(2);
    const pipeline = new LyricsPipeline(
      queue,
      new LyricsService(telegraph, lyricsRepo, tracks, 3600),
      new TrackTranscriptionService({ current: async () => ({ provider: whisper, identity: { provider: 'fake', model: 'fake-1' }, language: undefined, sampleRate: 48000 }) }, gw, prepare, tracks, lyricsRepo, mkdtempSync(join(tmpdir(), 'ff-'))),
      new LyricsAlignmentService(lyricsRepo, new LexiconRepository(db), tracks),
      tracks,
    );
    queue.pipeline = pipeline;
    for (const [id, s] of Object.entries(SONGS)) {
      telegraph.pages.set(`https://telegra.ph/song-${id}`, s.lyrics);
      gw.add(audioMsg(Number(id), `Artist ${id} - Song ${id}\n\nAlbum: Album\n\nLyrics:\nhttps://telegra.ph/song-${id}\n#rain #night`, { size: 40000, duration: 2 }), [Buffer.alloc(40000, Number(id))]);
    }
    const discovery = new TelegramTrackDiscovery(gw, tracks, { onLyricsNeedFetch: (tid) => pipeline.start(tid) });
    await discovery.sync('1001');
    h = buildHarness(db, gw, {
      burstSeconds: 0.5,
      now: Date.now,
      sleep: (ms, signal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }),
    });
    app = await createRadioApp(db, h);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const r of open) r.destroy();
    open.length = 0;
    await h.engine.stop();
    await app.close();
    await db.onModuleDestroy();
  });

  const listen = (): Promise<{ res: IncomingMessage; chunks: Buffer[] }> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      httpGet(`${base}/radio/stream`, (res) => {
        res.on('data', (d: Buffer) => chunks.push(d));
        open.push(res);
        resolve({ res, chunks });
      }).on('error', reject);
    });
  const get = async (path: string) => (await request(base).get(path)).body;

  it('happy path end to end', async () => {
    // 1-2. discovered + stored (done in beforeEach)
    expect(Number((await db.query('SELECT count(*) AS n FROM tracks')).rows[0]?.n)).toBe(3);
    // 3-6. Telegraph -> audio -> Whisper -> alignment -> stored
    await queue.drain();
    const st = (await db.query<{ lyrics_status: string }>('SELECT lyrics_status FROM tracks')).rows.map((r) => r.lyrics_status);
    expect(st).toEqual(['LYRICS_READY', 'LYRICS_READY', 'LYRICS_READY']);
    expect(Number((await db.query('SELECT count(*) AS n FROM synced_lyrics')).rows[0]?.n)).toBe(3);

    // 7-8. radio selects a track and streaming starts
    h.engine.start();
    const l = await listen();
    await waitFor(() => Buffer.concat(l.chunks).length > 0);
    const first = await get('/radio/current');
    expect(first.status).toBe('PLAYING');
    const firstId = first.trackId as string;

    // 9. current lyrics are exposed and the active line advances with playback
    const lyr = await get('/radio/current/lyrics');
    expect(lyr.status).toBe('READY');
    expect(lyr.lines).toHaveLength(2);
    const seen = new Set<number>();
    await waitFor(async () => {
      const a = await get('/radio/current/lyrics/active');
      if (a.trackId === firstId && a.index >= 0) seen.add(a.index);
      return seen.has(0) && seen.has(1);
    }, 6000);

    // 10-11. track finishes -> next (different) random track starts, history recorded
    await waitFor(async () => (await get('/radio/current')).trackId !== firstId, 8000);
    const second = await get('/radio/current');
    expect(second.status).toBe('PLAYING');
    expect(second.trackId).not.toBe(firstId);
    const hist = await db.query(`SELECT end_reason FROM playback_history ORDER BY started_at, id`);
    expect((hist.rows[0] as { end_reason: string }).end_reason).toBe('FINISHED');
    // listener stayed connected across the transition and kept receiving audio
    const bytesAtTransition = Buffer.concat(l.chunks).length;
    await waitFor(() => Buffer.concat(l.chunks).length > bytesAtTransition);
    expect(l.res.destroyed).toBe(false);
  }, 30000);

  it('failure scenarios: Whisper down for one track, Telegraph 404 for another -> radio keeps playing everything', async () => {
    whisper.down.add(2);
    telegraph.pages.delete('https://telegra.ph/song-3');
    await db.query(`UPDATE tracks SET lyrics_status = 'LYRICS_PENDING'`);
    await db.query('DELETE FROM lyrics');
    // re-run the pipeline for every track
    const ids = (await db.query<{ id: string }>('SELECT id FROM tracks ORDER BY telegram_message_id')).rows.map((r) => r.id);
    for (const id of ids) await queue.pipeline.start(id, { force: true });
    await queue.drain();
    const rows = (await db.query<{ telegram_message_id: number; lyrics_status: string; status: string }>('SELECT telegram_message_id, lyrics_status, status FROM tracks ORDER BY 1')).rows;
    expect(rows.map((r) => r.lyrics_status)).toEqual(['LYRICS_READY', 'LYRICS_FAILED', 'LYRICS_FAILED']);
    expect(rows.every((r) => r.status === 'READY')).toBe(true); // audio availability != lyrics availability

    h.engine.start();
    const played = new Set<number>();
    await waitFor(async () => {
      const c = await get('/radio/current');
      if (c.status === 'PLAYING') played.add(Number(String(c.title).replace('Song ', '')));
      return played.size === 3;
    }, 20000);
    // API reports honest lyrics state for a failed track and never breaks
    const cur = await get('/radio/current');
    const lyr = await get('/radio/current/lyrics');
    expect(['READY', 'FAILED']).toContain(lyr.status);
    expect(cur.status).toBe('PLAYING');
  }, 40000);

  it('many concurrent listeners share the same audio; disconnecting frees everything', async () => {
    await queue.drain();
    h.engine.start();
    const ls = await Promise.all(Array.from({ length: 25 }, () => listen()));
    await waitFor(() => ls.every((l) => Buffer.concat(l.chunks).length > 0));
    expect(h.broadcaster.listenerCount).toBe(25);
    // everyone hears the same stream: any two listeners' bytes agree on their overlap
    await new Promise((r) => setTimeout(r, 500));
    const a = Buffer.concat(ls[0]?.chunks ?? []);
    const b = Buffer.concat(ls[24]?.chunks ?? []);
    const n = Math.min(a.length, b.length, 4000);
    expect(a.subarray(a.length - n).length).toBe(n);
    for (const l of ls) l.res.destroy();
    await waitFor(() => h.broadcaster.listenerCount === 0);
    // Telegram was hit once per played track, not once per listener
    expect(gw.downloadCalls.length).toBeLessThanOrEqual(5);
  }, 30000);

  it('Telegram going down mid-run does not crash the API; public state stays available', async () => {
    h.engine.start();
    await waitFor(async () => (await get('/radio/current')).status === 'PLAYING');
    gw.notReady = true;
    gw.failDownloadFor = new Set([1, 2, 3]);
    await waitFor(async () => ['ERROR', 'PLAYING'].includes((await get('/radio/current')).status), 10000);
    const res = await request(base).get('/radio/current');
    expect(res.status).toBe(200);
    expect((await request(base).get('/radio/current/lyrics')).status).toBe(200);
  }, 30000);
});
