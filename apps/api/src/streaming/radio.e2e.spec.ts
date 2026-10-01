import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet, IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { audioMsg, FakeTelegramGateway } from '../../test/fake-telegram';
import { buildHarness, Harness, waitFor } from '../../test/engine-harness';
import { createRadioApp } from '../../test/radio-app';
import { freshDb } from '../../test/test-db';
import { DatabaseService } from '../database/database.service';
import { LowQualityStream, DEFAULT_LOW } from './low-quality-stream';
import { LyricsRepository } from '../lyrics/lyrics.repository';
import { TelegramTrackDiscovery } from '../telegram/track-discovery';
import { TrackRepository } from '../track/track.repository';

describe('public radio API (e2e, real HTTP)', () => {
  let db: DatabaseService;
  let gw: FakeTelegramGateway;
  let h: Harness;
  let app: INestApplication;
  let base: string;
  const open: IncomingMessage[] = [];

  beforeEach(async () => {
    db = await freshDb();
    gw = new FakeTelegramGateway();
    // real clock, tiny bursts: 1s tracks
    h = buildHarness(db, gw, { now: Date.now, sleep: async (ms, signal) => { await new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }); } });
    for (const i of [1, 2]) gw.add(audioMsg(i, `Artist - Song ${i}\nLyrics: https://telegra.ph/s-${i}`, { size: 20000, duration: 1 }), [Buffer.alloc(20000, i)]);
    await new TelegramTrackDiscovery(gw, new TrackRepository(db)).sync('1001');
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

  const listener = (): Promise<{ res: IncomingMessage; bytes: () => number }> =>
    new Promise((resolve, reject) => {
      const req = httpGet(`${base}/radio/stream`, (res) => {
        let n = 0;
        res.on('data', (d: Buffer) => (n += d.length));
        open.push(res);
        resolve({ res, bytes: () => n });
      });
      req.on('error', reject);
    });

  const withLow = async (ffmpegPath: string): Promise<LowQualityStream> => {
    await app.close();
    const low = new LowQualityStream(h.broadcaster, { ...DEFAULT_LOW, ffmpegPath, restartMinMs: 20 });
    app = await createRadioApp(db, h, low);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    return low;
  };
  const lowListener = (): Promise<{ res: IncomingMessage; bytes: () => number }> =>
    new Promise((resolve, reject) => {
      const req = httpGet(`${base}/radio/stream?quality=low`, (res) => {
        let n = 0;
        res.on('data', (d: Buffer) => (n += d.length));
        open.push(res);
        resolve({ res, bytes: () => n });
      });
      req.on('error', reject);
    });

  it('?quality=low is served by the shared data-saver encoder, ONE feed for many listeners', async () => {
    const cat = join(tmpdir(), `cat-${process.pid}.js`);
    writeFileSync(cat, "#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout);\n");
    chmodSync(cat, 0o755);
    const low = await withLow(cat);
    h.engine.start();
    const [a, b] = await Promise.all([lowListener(), lowListener()]);
    expect(a.res.headers['x-audio-quality']).toBe('low');
    await waitFor(() => a.bytes() > 0 && b.bytes() > 0);
    expect(low.listenerCount).toBe(2);
    expect(h.broadcaster.listenerCount).toBe(1);
    a.res.destroy();
    b.res.destroy();
    await waitFor(() => low.listenerCount === 0 && h.broadcaster.listenerCount === 0);
    expect(low.running).toBe(false);
    const list = await request(base).get('/radio/stations');
    expect(list.status).toBe(200);
  });

  it('falls back to the normal stream when the data-saver encoder is unavailable', async () => {
    const low = await withLow('/nonexistent/ffmpeg');
    h.engine.start();
    const first = await lowListener(); // ffmpeg fails to start -> becomes unavailable
    await waitFor(() => !low.available);
    first.res.destroy();
    const second = await lowListener();
    expect(second.res.headers['x-audio-quality']).toBeUndefined();
    await waitFor(() => second.bytes() > 0);
    expect(h.broadcaster.listenerCount).toBe(1);
  });

  it('503 while the engine is not running', async () => {
    await request(base).get('/radio/stream').expect(503);
  });

  it('streams audio/mpeg to multiple concurrent listeners and cleans up on disconnect', async () => {
    h.engine.start();
    const [a, b] = await Promise.all([listener(), listener()]);
    expect(a.res.headers['content-type']).toBe('audio/mpeg');
    expect(a.res.headers['cache-control']).toContain('no-store');
    await waitFor(() => a.bytes() > 0 && b.bytes() > 0);
    expect(h.broadcaster.listenerCount).toBe(2);
    a.res.destroy();
    await waitFor(() => h.broadcaster.listenerCount === 1);
    b.res.destroy();
    await waitFor(() => h.broadcaster.listenerCount === 0);
  });

  it('/radio/current reports the playing track with a live position', async () => {
    h.engine.start();
    await waitFor(async () => (await request(base).get('/radio/current')).body.status === 'PLAYING');
    const r = await request(base).get('/radio/current').expect(200);
    expect(r.body).toMatchObject({ status: 'PLAYING', duration: 1 });
    expect(r.body.title).toMatch(/Song/);
    expect(typeof r.body.trackId).toBe('string');
    expect(r.body.position).toBeGreaterThanOrEqual(0);
    expect(r.body.position).toBeLessThanOrEqual(1);
    // nothing internal leaks
    expect(JSON.stringify(r.body)).not.toMatch(/telegram|file|hash|session/i);
  });

  it('exposes synchronized lyrics and the active line for the current track', async () => {
    const lyricsRepo = new LyricsRepository(db);
    const rows = (await db.query<{ id: string }>('SELECT id FROM tracks')).rows;
    for (const r of rows) {
      await lyricsRepo.saveSynced(r.id, [
        { start: 0, end: 0.4, text: 'Hello my friend', confidence: 1 },
        { start: 0.5, end: 0.9, text: 'Welcome to the night', confidence: 1 },
      ], 1, 'test', null);
      await db.query(`UPDATE tracks SET lyrics_status = 'LYRICS_READY' WHERE id = $1`, [r.id]);
    }
    h.engine.start();
    await waitFor(async () => (await request(base).get('/radio/current')).body.status === 'PLAYING');
    const l = await request(base).get('/radio/current/lyrics').expect(200);
    expect(l.body.status).toBe('READY');
    expect(l.body.lines).toHaveLength(2);
    const a = await request(base).get('/radio/current/lyrics/active').expect(200);
    expect(a.body).toHaveProperty('index');
    expect(a.body.status).toBe('READY');
    expect(typeof a.body.position).toBe('number');
  });

  it('idle radio: meaningful state instead of errors', async () => {
    await db.query('DELETE FROM tracks');
    h.engine.start();
    await waitFor(async () => (await request(base).get('/radio/current')).body.status === 'IDLE');
    const l = await request(base).get('/radio/current/lyrics').expect(200);
    expect(l.body.status).toBe('NONE');
    const a = await request(base).get('/radio/current/lyrics/active').expect(200);
    expect(a.body.index).toBe(-1);
  });

  it('a track without synced lyrics degrades to PLAIN / PENDING / FAILED without affecting playback', async () => {
    const ids = (await db.query<{ id: string; telegram_message_id: number }>('SELECT id, telegram_message_id FROM tracks')).rows;
    for (const r of ids) await db.query(`UPDATE tracks SET lyrics_status = 'LYRICS_FAILED' WHERE id = $1`, [r.id]);
    h.engine.start();
    await waitFor(async () => (await request(base).get('/radio/current')).body.status === 'PLAYING');
    expect((await request(base).get('/radio/current/lyrics')).body.status).toBe('FAILED');
  });
});
