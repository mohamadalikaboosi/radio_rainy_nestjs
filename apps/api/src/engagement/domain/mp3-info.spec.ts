import { inspectMp3 } from './mp3-info';

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
