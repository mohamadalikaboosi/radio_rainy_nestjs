import { spawn } from 'node:child_process';
import { lowerPriority } from '../common/process-priority';
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
    lowerPriority(proc);
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
const FONT_CANDIDATES = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'];

/** What the Telegram live video shows: the song (or ad) on air and, for an ad, its banner. */
export interface Scene {
  title: string;
  artist?: string | null;
  banner?: { data: Buffer; mime: string };
}

const clip = (s: string, max: number): string => {
  const t = s.replace(/[\r\n]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Escapes a value for use inside an ffmpeg filter option. */
export const filterEscape = (s: string): string => s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** The filter graph of the one-shot render: optional banner on top, big note when there is none, title + artist in the lower third. Pure (unit-tested). */
export function sceneFilter(opts: { hasBanner: boolean; titleFile: string; artistFile: string; noteFile: string; fontFile?: string; withText: boolean; titleSize: number }): string {
  const font = opts.fontFile ? `fontfile='${filterEscape(opts.fontFile)}':` : '';
  const common = `${font}fontcolor=white:x=(w-text_w)/2:borderw=2:bordercolor=black@0.6`;
  const input = opts.hasBanner ? `[1:v]scale=1000:380:force_original_aspect_ratio=decrease[b];[0:v][b]overlay=(W-w)/2:40` : `[0:v]null`;
  if (!opts.withText) return `${input}[out]`;
  const titleY = opts.hasBanner ? 'h*0.70' : 'h*0.60';
  const texts = [
    ...(opts.hasBanner ? [] : [`drawtext=textfile='${filterEscape(opts.noteFile)}':${font}fontcolor=0x6c7bff@0.55:x=(w-text_w)/2:y=h*0.12:fontsize=220`]),
    `drawtext=textfile='${filterEscape(opts.titleFile)}':${common}:fontsize=${opts.titleSize}:y=${titleY}`,
    `drawtext=textfile='${filterEscape(opts.artistFile)}':${common.replace('fontcolor=white', 'fontcolor=0xc8d0dc')}:fontsize=38:y=${titleY}+${opts.titleSize + 24}`,
  ];
  return `${input},${texts.join(',')}[out]`;
}

/**
 * The picture of a station's Telegram live video, rendered OUTSIDE the live encoder. Best practice for a radio-on-video stream: the live ffmpeg
 * only encodes one still image (a few frames per second, almost no CPU); whenever the song or the ad changes, ONE short ffmpeg job draws the new
 * picture (text + banner) into a PNG, and the live encoder - which re-reads that file for every frame - picks it up by itself, with no restart
 * and no per-frame text rendering. If the picture cannot be drawn (no font / no drawtext) the dark default stays and the reason is logged.
 */
export class LiveSlide {
  readonly path: string;
  private readonly defaultPath: string;
  private readonly fontFile: string | undefined;
  private version = 0;
  private textBroken = false;

  constructor(
    private readonly dir: string,
    channelId: string,
    private readonly ffmpegPath = 'ffmpeg',
    private readonly run: RunFfmpeg = defaultRun(ffmpegPath),
    private readonly onProblem: (message: string) => void = () => undefined,
  ) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `slide-${channelId}.png`);
    this.defaultPath = join(dir, `slide-${channelId}.default.png`);
    this.fontFile = FONT_CANDIDATES.find((f) => existsSync(f));
    writeFileSync(this.defaultPath, solidPng(SLIDE_W, SLIDE_H, BACKGROUND));
    this.publish(this.defaultPath);
  }

  /** Back to the plain dark frame. */
  showDefault(): void {
    this.version++;
    this.publish(this.defaultPath);
  }

  /** Draws and publishes the scene. A newer request supersedes an older one that is still rendering. Returns whether this scene went live. */
  async show(scene: Scene): Promise<boolean> {
    const mine = ++this.version;
    const id = `${process.pid}-${mine}`;
    const files = { title: join(this.dir, `t-${id}.txt`), artist: join(this.dir, `a-${id}.txt`), note: join(this.dir, `n-${id}.txt`), banner: join(this.dir, `b-${id}.${extOf(scene.banner?.mime)}`), out: join(this.dir, `s-${id}.png`) };
    try {
      const title = clip(scene.title, 44);
      writeFileSync(files.title, title || ' ');
      writeFileSync(files.artist, clip(scene.artist ?? '', 52) || ' ');
      writeFileSync(files.note, '\u266A');
      if (scene.banner) writeFileSync(files.banner, scene.banner.data);
      const titleSize = title.length > 30 ? 46 : title.length > 20 ? 54 : 62;
      const attempt = async (withText: boolean): Promise<{ code: number | null; stderr: string }> =>
        this.run([
          '-nostdin', '-y', '-loglevel', 'error',
          '-f', 'lavfi', '-i', `color=c=0x0f1216:s=${SLIDE_W}x${SLIDE_H}`,
          ...(scene.banner ? ['-i', files.banner] : []),
          '-filter_complex', sceneFilter({ hasBanner: !!scene.banner, titleFile: files.title, artistFile: files.artist, noteFile: files.note, ...(this.fontFile ? { fontFile: this.fontFile } : {}), withText, titleSize }),
          '-map', '[out]', '-frames:v', '1', files.out,
        ]);
      let res = await attempt(!this.textBroken);
      if (res.code !== 0 && !this.textBroken) {
        // most likely this ffmpeg has no drawtext / no usable font: say so once, and still show the banner (without text)
        this.textBroken = true;
        this.onProblem(`cannot draw text on the Telegram live picture (${res.stderr.trim().slice(-300) || `ffmpeg exited ${res.code}`}); showing the picture without text`);
        res = await attempt(false);
      }
      if (res.code !== 0 || !existsSync(files.out)) {
        this.onProblem(`cannot render the Telegram live picture: ${res.stderr.trim().slice(-300) || `ffmpeg exited ${res.code}`}`);
        return false;
      }
      if (mine !== this.version) return false; // a newer picture was requested meanwhile
      this.publish(files.out);
      return true;
    } catch (err) {
      this.onProblem(`cannot render the Telegram live picture: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      for (const f of Object.values(files)) rmSync(f, { force: true });
    }
  }

  private publish(from: string): void {
    const tmp = `${this.path}.tmp`;
    copyFileSync(from, tmp);
    renameSync(tmp, this.path);
  }
}

const extOf = (mime: string | undefined): string => (mime?.includes('png') ? 'png' : mime?.includes('webp') ? 'webp' : mime?.includes('gif') ? 'gif' : 'jpg');
