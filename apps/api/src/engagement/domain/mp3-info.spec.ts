import { FRAME_SECONDS, mp3Cbr, mp3Frame, xingFrame } from '../../../test/mp3';
import { inspectMp3, mp3BytesPerSec, Mp3FrameCounter } from './mp3-info';

/** MPEG1 Layer III, 44.1 kHz, stereo frame headers. */
const header = (bitrateIdx: number): number[] => [0xff, 0xfb, (bitrateIdx << 4) | 0x00, 0x00];

describe('inspectMp3', () => {
  it('reads the CBR bitrate of the first frame', () => {
    const data = Buffer.concat([Buffer.from(header(9)), Buffer.alloc(16000 * 10 - 4)]); // 128 kbps => 16000 B/s
    const info = inspectMp3(data);
    expect(info?.bytesPerSec).toBe(16000);
    expect(info?.durationSeconds).toBeCloseTo(10, 5);
  });

  it('skips an ID3v2 tag before the first frame', () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...new Array<number>(10).fill(0)]); // 10 + 10 bytes
    const data = Buffer.concat([id3, Buffer.from(header(11)), Buffer.alloc(24000 * 5 - 4)]); // 192 kbps
    const info = inspectMp3(data);
    expect(info?.bytesPerSec).toBe(24000);
  });

  it('uses the exact duration of a Xing (VBR) header', () => {
    const frame = Buffer.alloc(417);
    Buffer.from(header(9)).copy(frame, 0);
    const x = 4 + 32;
    frame.write('Xing', x, 'ascii');
    frame.writeUInt32BE(1, x + 4); // flags: frames present
    frame.writeUInt32BE(1000, x + 8); // 1000 frames * 1152 / 44100 = 26.12 s
    const info = inspectMp3(Buffer.concat([frame, Buffer.alloc(100_000)]));
    expect(info?.durationSeconds).toBeCloseTo((1000 * 1152) / 44100, 3);
  });

  it('returns null for data that is not an MP3', () => {
    expect(inspectMp3(Buffer.from('RIFF....WAVEfmt '))).toBeNull();
    expect(inspectMp3(Buffer.alloc(0))).toBeNull();
  });
});

describe('mp3BytesPerSec (real-time rate of a track from its first bytes)', () => {
  it('CBR: the frame bitrate, whatever the metadata says (320 kbps = 40000 B/s, 128 kbps = 16000 B/s)', () => {
    expect(mp3BytesPerSec(mp3Cbr(320, 0.5), null)).toBe(40000);
    expect(mp3BytesPerSec(mp3Cbr(128, 0.5), 999)).toBe(16000);
  });

  it('VBR (Xing): bytes / exact duration, with the byte count of the header or else the audio size given', () => {
    const frames = 1000; // 24 s
    const withBytes = Buffer.concat([xingFrame(128, frames, 600_000), mp3Cbr(192, 0.2)]);
    expect(mp3BytesPerSec(withBytes, null)).toBeCloseTo(600_000 / (frames * FRAME_SECONDS), 6);
    const withoutBytes = Buffer.concat([xingFrame(128, frames), mp3Cbr(192, 0.2)]);
    expect(mp3BytesPerSec(withoutBytes, 480_000)).toBeCloseTo(20_000, 6);
    expect(mp3BytesPerSec(withoutBytes, null)).toBeNull(); // no way to know the average
  });

  it('an "Info" header marks a CBR file: the frame bitrate is exact', () => {
    expect(mp3BytesPerSec(Buffer.concat([xingFrame(320, 5000, 4_800_000, 'Info'), mp3Cbr(320, 0.2)]), null)).toBe(40000);
  });

  it('a stray sync word in garbage is not a frame (the next frame must follow); non-MP3 data gives null', () => {
    const garbage = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(5000, 1)]);
    expect(mp3BytesPerSec(garbage, null)).toBeNull();
    expect(mp3BytesPerSec(Buffer.concat([Buffer.alloc(300, 7), mp3Cbr(256, 0.2)]), null)).toBe(32000); // junk before the first frame
    expect(mp3BytesPerSec(Buffer.from('RIFF....WAVEfmt '), null)).toBeNull();
  });
});

describe('Mp3FrameCounter (media time of a running stream)', () => {
  it('counts frames across any chunking, including headers split between chunks', () => {
    const stream = Buffer.concat([mp3Cbr(320, 1.2), mp3Cbr(128, 0.48)]); // 50 + 20 frames
    for (const size of [1, 3, 500, 961, 1 << 20]) {
      const c = new Mp3FrameCounter();
      for (let i = 0; i < stream.length; i += size) c.push(stream.subarray(i, i + size));
      expect(c.seconds).toBeCloseTo(70 * FRAME_SECONDS, 9);
    }
  });

  it('resyncs after garbage between frames', () => {
    const c = new Mp3FrameCounter();
    c.push(Buffer.concat([mp3Frame(320), Buffer.alloc(37, 0), mp3Frame(320), mp3Frame(320)]));
    expect(c.seconds).toBeCloseTo(3 * FRAME_SECONDS, 9);
  });
});
