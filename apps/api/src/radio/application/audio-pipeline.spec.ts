import { audioMsg, FakeTelegramGateway } from '../../../test/fake-telegram';
import { id3Tag, mp3Cbr } from '../../../test/mp3';
import { Track } from '../../catalog/domain/track.types';
import { metadataBytesPerSec, TrackAudioPipeline } from './audio-pipeline';

const track = (messageId: number, fileSize: number | null, duration: number | null): Track => ({
  id: `t${messageId}`,
  telegramChannelId: '1001',
  telegramMessageId: messageId,
  title: 'Song',
  artist: null,
  album: null,
  duration,
  mimeType: 'audio/mpeg',
  fileSize,
  telegramPostUrl: null,
  lyricsUrl: null,
  status: 'READY',
  lyricsStatus: 'LYRICS_NONE',
  enabled: true,
  playCount: 0,
  lastPlayedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const drain = async (it: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const out: Uint8Array[] = [];
  for await (const c of it) out.push(c);
  return Buffer.concat(out);
};

const chunked = (file: Buffer, size: number): Buffer[] => Array.from({ length: Math.ceil(file.length / size) }, (_, i) => file.subarray(i * size, (i + 1) * size));

describe('TrackAudioPipeline: real-time rate of MP3 tracks', () => {
  const open = (file: Buffer, messageId: number, duration: number) => {
    const gw = new FakeTelegramGateway();
    gw.add(audioMsg(messageId, 'Artist - Song', { size: file.length, duration }), chunked(file, 64 * 1024));
    return new TrackAudioPipeline(gw, null, 128).open(track(messageId, file.length, duration), new AbortController().signal);
  };

  it('a 320 kbps file with cover art is paced at 320 kbps, never at the 128 kbps default (that played it at 0.4x real time)', async () => {
    // like the track in the logs: the size includes the ID3 tag and Telegram rounds the duration down, so the metadata reads > 320 kbps
    const file = Buffer.concat([id3Tag(58_000), mp3Cbr(320, 20.4)]);
    const opened = open(file, 1, 20);
    expect(file.length / 20).toBeGreaterThan(40_000);
    expect(opened.bytesPerSec).toBe(40_000); // the first guess is capped at 320 kbps instead of being thrown away
    const out = await drain(opened.bytes);
    expect(out.length).toBe(file.length - 58_000); // the tag never goes on air
    expect(opened.bytesPerSec).toBe(40_000);
  });

  it('a 128 kbps file with a big cover: the metadata reads 288 kbps (2.25x too fast), the audio itself says 128 kbps', async () => {
    const file = Buffer.concat([id3Tag(600_000), mp3Cbr(128, 30)]);
    const opened = open(file, 2, 30);
    expect(opened.bytesPerSec).toBeCloseTo(36_000, 0);
    await drain(opened.bytes);
    expect(opened.bytesPerSec).toBe(16_000);
  });

  it('the real rate is known after the first 16 KiB of audio, long before the track goes on air', async () => {
    const gw = new FakeTelegramGateway();
    const file = Buffer.concat([id3Tag(20_000), mp3Cbr(128, 10)]);
    gw.add(audioMsg(3, 'Artist - Song', { size: file.length, duration: 10 }), chunked(file, 8192));
    const opened = new TrackAudioPipeline(gw, null, 128).open(track(3, file.length, 10), new AbortController().signal);
    expect(opened.bytesPerSec).toBe(file.length / 10); // ~144 kbps: the tag counted as audio
    const it = opened.bytes[Symbol.asyncIterator]();
    let got = 0;
    while (got < 16 * 1024) {
      const r = await it.next();
      if (r.done) throw new Error('ended early');
      got += r.value.length;
    }
    expect(opened.bytesPerSec).toBe(16_000);
    await it.return?.(undefined);
  });

  it('data without MP3 frames keeps the metadata rate (minus the tag), as before', async () => {
    const file = Buffer.concat([id3Tag(1000), Buffer.alloc(20_000, 3)]);
    const opened = open(file, 4, 1);
    await drain(opened.bytes);
    expect(opened.bytesPerSec).toBe(20_000);
  });
});

describe('metadataBytesPerSec', () => {
  it('caps at 320 kbps, rejects impossible rates and missing data', () => {
    expect(metadataBytesPerSec(16_476_304, 410)).toBe(40_000); // "Derakht": 321 kbps by metadata (cover art + rounded duration)
    expect(metadataBytesPerSec(4_784_128, 297)).toBeCloseTo(16_108, 0);
    expect(metadataBytesPerSec(1000, 600)).toBeNull(); // 13 B/s: the duration is wrong
    expect(metadataBytesPerSec(null, 100)).toBeNull();
    expect(metadataBytesPerSec(1000, 0)).toBeNull();
  });
});
