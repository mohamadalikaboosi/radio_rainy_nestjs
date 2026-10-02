import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

/** A solid-colour RGB PNG (no image library needed): the default picture of the Telegram live video. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + width * 3); // filter byte 0 + pixels
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export type RunFfmpeg = (args: string[]) => Promise<{ code: number | null; stderr: string }>;

const defaultRun = (ffmpegPath: string): RunFfmpeg => (args) =>
  new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-800);
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: e.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });

export const SLIDE_W = 1280;
export const SLIDE_H = 720;
const BACKGROUND: [number, number, number] = [0x0f, 0x12, 0x16];

/**
 * The picture of a station's Telegram live video. The live ffmpeg reads this ONE file again for every frame, so replacing it
 * (write + atomic rename) changes the picture without restarting the stream: the dark default while music plays, the advertiser's
 * banner while an ad with an image is on air.
 */
export class LiveSlide {
  readonly path: string;
  private readonly defaultPath: string;
  private version = 0;

  constructor(private readonly dir: string, channelId: string, private readonly ffmpegPath = 'ffmpeg', private readonly run: RunFfmpeg = defaultRun(ffmpegPath)) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `slide-${channelId}.png`);
    this.defaultPath = join(dir, `slide-${channelId}.default.png`);
    writeFileSync(this.defaultPath, solidPng(SLIDE_W, SLIDE_H, BACKGROUND));
    this.publish(this.defaultPath);
  }

  /** Back to the plain dark frame. */
  showDefault(): void {
    this.version++;
    this.publish(this.defaultPath);
  }

  /** Puts the advertiser's image on the frame (scaled to fit above the text). Returns false when it could not be rendered (the default stays). */
  async showAd(image: { data: Buffer; mime: string }): Promise<boolean> {
    const mine = ++this.version;
    const src = join(this.dir, `ad-${process.pid}-${mine}.${image.mime.includes('png') ? 'png' : image.mime.includes('webp') ? 'webp' : image.mime.includes('gif') ? 'gif' : 'jpg'}`);
    const out = join(this.dir, `ad-${process.pid}-${mine}.slide.png`);
    try {
      writeFileSync(src, image.data);
      const res = await this.run([
        '-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0x0f1216:s=${SLIDE_W}x${SLIDE_H}`,
        '-i', src,
        '-filter_complex', `[1:v]scale=1000:440:force_original_aspect_ratio=decrease[a];[0:v][a]overlay=(W-w)/2:50`,
        '-frames:v', '1', out,
      ]);
      if (res.code !== 0 || !existsSync(out)) return false;
      if (mine !== this.version) return false; // another slide was requested meanwhile
      this.publish(out);
      return true;
    } catch {
      return false;
    } finally {
      rmSync(src, { force: true });
      rmSync(out, { force: true });
    }
  }

  private publish(from: string): void {
    const tmp = `${this.path}.tmp`;
    copyFileSync(from, tmp);
    renameSync(tmp, this.path);
  }
}
