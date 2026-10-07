/**
 * Minimal MP3 inspection: the bitrate of the first frame (CBR) or the exact duration from a Xing/Info/VBRI header (VBR), and a frame counter
 * for a running stream. The pacer needs the real rate of every track and ad (streaming at the wrong rate stalls or floods the listeners).
 */
export interface Mp3Info {
  bytesPerSec: number;
  durationSeconds: number;
}

/** One MPEG audio Layer III frame header. */
export interface Mp3FrameHeader {
  kbps: number;
  sampleRate: number;
  samplesPerFrame: number;
  /** Length of the whole frame (header included). */
  frameBytes: number;
  mpeg1: boolean;
  mono: boolean;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function id3Size(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  return 10 + (((b[6] ?? 0) & 0x7f) << 21) + (((b[7] ?? 0) & 0x7f) << 14) + (((b[8] ?? 0) & 0x7f) << 7) + ((b[9] ?? 0) & 0x7f);
}

/** The Layer III frame header at `i`, or null when there is none. */
export function frameHeaderAt(data: Uint8Array, i: number): Mp3FrameHeader | null {
  if (i < 0 || i + 4 > data.length) return null;
  const b1 = data[i + 1] ?? 0;
  if (data[i] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b1 >> 1) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const b2 = data[i + 2] ?? 0;
  const bitrateIdx = b2 >> 4;
  const rateIdx = (b2 >> 2) & 3;
  if (bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null;
  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx];
  const sampleRate = SAMPLE_RATES[version]?.[rateIdx];
  if (!kbps || !sampleRate) return null;
  const padding = (b2 >> 1) & 1;
  return {
    kbps,
    sampleRate,
    samplesPerFrame: mpeg1 ? 1152 : 576,
    frameBytes: Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / sampleRate) + padding,
    mpeg1,
    mono: (data[i + 3] ?? 0) >> 6 === 3,
  };
}

const u32 = (d: Uint8Array, at: number): number => ((d[at] ?? 0) * 2 ** 24) + ((d[at + 1] ?? 0) << 16) + ((d[at + 2] ?? 0) << 8) + (d[at + 3] ?? 0);

/** The VBR header of the frame at `i` (Xing/Info or VBRI): exact frame count and, when present, the audio byte count. */
function vbrHeaderAt(data: Uint8Array, i: number, h: Mp3FrameHeader): { tag: 'Xing' | 'Info' | 'VBRI'; frames: number; bytes: number | null } | null {
  const x = i + 4 + (h.mpeg1 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17);
  const tag = String.fromCharCode(data[x] ?? 0, data[x + 1] ?? 0, data[x + 2] ?? 0, data[x + 3] ?? 0);
  if ((tag === 'Xing' || tag === 'Info') && x + 12 <= data.length) {
    const flags = data[x + 7] ?? 0;
    if ((flags & 1) === 0) return null;
    const frames = u32(data, x + 8);
    const bytes = (flags & 2) !== 0 && x + 16 <= data.length ? u32(data, x + 12) : null;
    return frames > 0 ? { tag, frames, bytes: bytes || null } : null;
  }
  const v = i + 4 + 32; // VBRI (Fraunhofer) always sits 32 bytes after the header
  if (String.fromCharCode(data[v] ?? 0, data[v + 1] ?? 0, data[v + 2] ?? 0, data[v + 3] ?? 0) === 'VBRI' && v + 18 <= data.length) {
    const frames = u32(data, v + 14);
    const bytes = u32(data, v + 10);
    return frames > 0 ? { tag: 'VBRI', frames, bytes: bytes || null } : null;
  }
  return null;
}

export function inspectMp3(data: Uint8Array): Mp3Info | null {
  let i = id3Size(data);
  const limit = Math.min(data.length - 4, i + 64 * 1024);
  for (; i < limit; i++) {
    const h = frameHeaderAt(data, i);
    if (!h) continue;
    // Xing/Info header (VBR): exact frame count.
    const vbr = vbrHeaderAt(data, i, h);
    if (vbr && vbr.tag !== 'VBRI') {
      const durationSeconds = (vbr.frames * h.samplesPerFrame) / h.sampleRate;
      return { durationSeconds, bytesPerSec: Math.max(1, Math.round((data.length - id3Size(data)) / durationSeconds)) };
    }
    const bytesPerSec = (h.kbps * 1000) / 8;
    return { bytesPerSec, durationSeconds: (data.length - id3Size(data)) / bytesPerSec };
  }
  return null;
}

/**
 * Real-time byte rate of an MP3 stream from its first bytes (ID3 tag already removed), or null when they are not MP3.
 * VBR (Xing/VBRI): audio bytes / exact duration (`audioBytes` = file size without the tag, used when the header has no byte count).
 * CBR: the frame bitrate. A header only counts when the next frame follows where it says (a stray 0xFF in garbage is no frame).
 */
export function mp3BytesPerSec(head: Uint8Array, audioBytes: number | null): number | null {
  const limit = Math.min(head.length - 4, 64 * 1024);
  for (let i = 0; i < limit; i++) {
    const h = frameHeaderAt(head, i);
    if (!h) continue;
    const next = i + h.frameBytes;
    if (next + 4 <= head.length && !frameHeaderAt(head, next)) continue;
    const vbr = vbrHeaderAt(head, i, h);
    if (vbr && vbr.tag !== 'Info') {
      const seconds = (vbr.frames * h.samplesPerFrame) / h.sampleRate;
      const bytes = vbr.bytes ?? audioBytes;
      return bytes ? bytes / seconds : null;
    }
    return (h.kbps * 1000) / 8;
  }
  return null;
}

/**
 * Counts the media time in a running MP3 byte stream, chunk by chunk (frames may span chunks). Garbage between frames is skipped
 * byte by byte until the next valid header, so a broken frame costs a few bytes of resync, never the count.
 */
export class Mp3FrameCounter {
  /** Media seconds of all complete frame headers seen so far. */
  seconds = 0;
  private pending: Buffer = Buffer.alloc(0);
  private skip = 0;

  push(chunk: Uint8Array): void {
    const data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let i = Math.min(this.skip, data.length);
    this.skip -= i;
    while (this.skip === 0 && i + 4 <= data.length) {
      const h = frameHeaderAt(data, i);
      if (!h) {
        i++;
        continue;
      }
      this.seconds += h.samplesPerFrame / h.sampleRate;
      const end = i + h.frameBytes;
      if (end > data.length) this.skip = end - data.length;
      i = Math.min(end, data.length);
    }
    this.pending = this.skip === 0 ? Buffer.from(data.subarray(i)) : Buffer.alloc(0);
  }
}

/** True when `data` contains a plausible MPEG audio frame header (used to spot garbage/corrupt downloads before they go on air). */
export function hasMpegFrameSync(data: Uint8Array, scanBytes = 64 * 1024): boolean {
  const end = Math.min(data.length - 3, scanBytes);
  for (let i = 0; i < end; i++) {
    if (data[i] !== 0xff) continue;
    const b1 = data[i + 1] ?? 0;
    const b2 = data[i + 2] ?? 0;
    if ((b1 & 0xe0) !== 0xe0) continue;
    if (((b1 >> 3) & 3) === 1 || ((b1 >> 1) & 3) === 0) continue; // reserved version / layer
    if (b2 >> 4 === 15 || ((b2 >> 2) & 3) === 3) continue; // bad bitrate / sample-rate index
    return true;
  }
  return false;
}
