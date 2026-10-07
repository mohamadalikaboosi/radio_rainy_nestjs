/**
 * Real MP3 framing for tests: MPEG-1 Layer III at 48 kHz, where a frame is exactly 3 * kbps bytes and 24 ms long
 * (320 kbps = 960 B per frame = 40000 B/s), so expected rates and durations are exact.
 */
const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
export const FRAME_SECONDS = 1152 / 48000;

export function frameHeader(kbps: number): Buffer {
  const idx = MPEG1_L3_KBPS.indexOf(kbps);
  if (idx <= 0) throw new Error(`no MPEG-1 Layer III bitrate ${kbps}`);
  return Buffer.from([0xff, 0xfb, (idx << 4) | (1 << 2), 0x00]); // 48 kHz, no padding, stereo
}

/** One complete frame (header + `fill` bytes). */
export function mp3Frame(kbps: number, fill = 0x55): Buffer {
  const frame = Buffer.alloc(3 * kbps, fill);
  frameHeader(kbps).copy(frame, 0);
  return frame;
}

/** `seconds` of constant-bitrate audio. */
export function mp3Cbr(kbps: number, seconds: number, fill = 0x55): Buffer {
  return Buffer.concat(Array.from({ length: Math.round(seconds / FRAME_SECONDS) }, () => mp3Frame(kbps, fill)));
}

/** A leading ID3v2 tag of `bytes` in total, like the cover art most music files carry. */
export function id3Tag(bytes: number): Buffer {
  const tag = Buffer.alloc(bytes, 0);
  tag.write('ID3', 0, 'latin1');
  tag[3] = 3;
  const size = bytes - 10;
  tag[6] = (size >> 21) & 0x7f;
  tag[7] = (size >> 14) & 0x7f;
  tag[8] = (size >> 7) & 0x7f;
  tag[9] = size & 0x7f;
  return tag;
}

/** A first frame carrying a Xing (VBR) header: frame count and, optionally, the byte count of the whole stream. */
export function xingFrame(kbps: number, frames: number, bytes?: number, tag: 'Xing' | 'Info' = 'Xing'): Buffer {
  const frame = mp3Frame(kbps, 0);
  const x = 4 + 32; // MPEG-1 stereo side info
  frame.write(tag, x, 'latin1');
  frame.writeUInt32BE(bytes === undefined ? 1 : 3, x + 4);
  frame.writeUInt32BE(frames, x + 8);
  if (bytes !== undefined) frame.writeUInt32BE(bytes, x + 12);
  return frame;
}
