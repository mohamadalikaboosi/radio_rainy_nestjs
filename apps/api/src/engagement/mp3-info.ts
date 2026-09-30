/**
 * Minimal MP3 inspection for admin-uploaded ads: bitrate of the first frame (CBR assumption) or the exact duration from a
 * Xing/Info header (VBR). Needed so the pacer streams the ad at the right speed and the panel can show its length.
 */
export interface Mp3Info {
  bytesPerSec: number;
  durationSeconds: number;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function id3Size(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  return 10 + (((b[6] ?? 0) & 0x7f) << 21) + (((b[7] ?? 0) & 0x7f) << 14) + (((b[8] ?? 0) & 0x7f) << 7) + ((b[9] ?? 0) & 0x7f);
}

export function inspectMp3(data: Uint8Array): Mp3Info | null {
  let i = id3Size(data);
  const limit = Math.min(data.length - 4, i + 64 * 1024);
  for (; i < limit; i++) {
    const b0 = data[i] ?? 0;
    const b1 = data[i + 1] ?? 0;
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) continue;
    const version = (b1 >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (b1 >> 1) & 3; // 1 = Layer III
    if (version === 1 || layer !== 1) continue;
    const b2 = data[i + 2] ?? 0;
    const b3 = data[i + 3] ?? 0;
    const bitrateIdx = b2 >> 4;
    const rateIdx = (b2 >> 2) & 3;
    if (bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) continue;
    const kbps = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx];
    const sampleRate = SAMPLE_RATES[version]?.[rateIdx];
    if (!kbps || !sampleRate) continue;
    const mono = (b3 >> 6) === 3;
    const samplesPerFrame = version === 3 ? 1152 : 576;

    // Xing/Info header (VBR): exact frame count.
    const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const x = i + 4 + sideInfo;
    const tag = String.fromCharCode(data[x] ?? 0, data[x + 1] ?? 0, data[x + 2] ?? 0, data[x + 3] ?? 0);
    if ((tag === 'Xing' || tag === 'Info') && x + 12 <= data.length && ((data[x + 7] ?? 0) & 1) === 1) {
      const frames = ((data[x + 8] ?? 0) * 2 ** 24) + ((data[x + 9] ?? 0) << 16) + ((data[x + 10] ?? 0) << 8) + (data[x + 11] ?? 0);
      if (frames > 0) {
        const durationSeconds = (frames * samplesPerFrame) / sampleRate;
        return { durationSeconds, bytesPerSec: Math.max(1, Math.round((data.length - id3Size(data)) / durationSeconds)) };
      }
    }
    const bytesPerSec = (kbps * 1000) / 8;
    return { bytesPerSec, durationSeconds: (data.length - id3Size(data)) / bytesPerSec };
  }
  return null;
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
