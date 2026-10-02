import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { LiveSlide, RunFfmpeg, solidPng } from './live-slide';

describe('solidPng', () => {
  it('is a valid PNG of the requested size and colour', () => {
    const png = solidPng(8, 4, [10, 20, 30]);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    let off = 8;
    const chunks: Record<string, Buffer> = {};
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.subarray(off + 4, off + 8).toString('latin1');
      const data = png.subarray(off + 8, off + 8 + len);
      expect(png.readUInt32BE(off + 8 + len)).toBe(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data]))); // every CRC is right
      chunks[type] = data;
      off += 12 + len;
    }
    expect(chunks.IHDR?.readUInt32BE(0)).toBe(8);
    expect(chunks.IHDR?.readUInt32BE(4)).toBe(4);
    const raw = inflateSync(chunks.IDAT as Buffer);
    expect(raw.length).toBe(4 * (1 + 8 * 3));
    expect([...raw.subarray(1, 4)]).toEqual([10, 20, 30]);
  });
});

describe('LiveSlide (the picture of the Telegram live video)', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'slide-'));

  it('starts with the dark default picture and goes back to it', () => {
    const slide = new LiveSlide(dir(), '7', 'ffmpeg', async () => ({ code: 0, stderr: '' }));
    const first = readFileSync(slide.path);
    expect(first.subarray(1, 4).toString()).toBe('PNG');
    slide.showDefault();
    expect(readFileSync(slide.path).equals(first)).toBe(true);
  });

  it('renders an ad banner through ffmpeg (once, off the live path) and swaps the file atomically', async () => {
    const d = dir();
    let args: string[] = [];
    const run: RunFfmpeg = async (a) => {
      args = a;
      writeFileSync(a.at(-1) as string, 'RENDERED-AD-SLIDE');
      return { code: 0, stderr: '' };
    };
    const slide = new LiveSlide(d, '7', 'ffmpeg', run);
    expect(await slide.showAd({ data: Buffer.from('jpegbytes'), mime: 'image/jpeg' })).toBe(true);
    expect(readFileSync(slide.path, 'utf8')).toBe('RENDERED-AD-SLIDE');
    expect(args.join(' ')).toContain('overlay');
    expect(existsSync(`${slide.path}.tmp`)).toBe(false);
    slide.showDefault();
    expect(readFileSync(slide.path).subarray(1, 4).toString()).toBe('PNG');
  });

  it('keeps the default picture when ffmpeg fails, and ignores a banner that was superseded', async () => {
    const slide = new LiveSlide(dir(), '7', 'ffmpeg', async () => ({ code: 1, stderr: 'boom' }));
    const before = readFileSync(slide.path);
    expect(await slide.showAd({ data: Buffer.from('x'), mime: 'image/png' })).toBe(false);
    expect(readFileSync(slide.path).equals(before)).toBe(true);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new LiveSlide(dir(), '8', 'ffmpeg', async (a) => {
      await gate;
      writeFileSync(a.at(-1) as string, 'LATE');
      return { code: 0, stderr: '' };
    });
    const pending = slow.showAd({ data: Buffer.from('x'), mime: 'image/png' });
    slow.showDefault(); // the ad ended while its banner was still being rendered
    release();
    expect(await pending).toBe(false);
    expect(readFileSync(slow.path).subarray(1, 4).toString()).toBe('PNG');
  });
});
