import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { filterEscape, LiveSlide, RunFfmpeg, sceneFilter, solidPng } from './live-slide';

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

describe('sceneFilter', () => {
  const base = { titleFile: '/t.txt', artistFile: '/a.txt', noteFile: '/n.txt', withText: true, titleSize: 60 };
  it('draws the title and artist from text files in the lower third (no per-frame reload in the live encoder)', () => {
    const f = sceneFilter({ ...base, hasBanner: false });
    expect(f).toContain("drawtext=textfile='/t.txt'");
    expect(f).toContain("drawtext=textfile='/a.txt'");
    expect(f).toContain('fontsize=60');
    expect(f).toContain("drawtext=textfile='/n.txt'"); // the big note when there is no banner
    expect(f.endsWith('[out]')).toBe(true);
  });
  it('puts an ad banner on top (and no note), text lower', () => {
    const f = sceneFilter({ ...base, hasBanner: true });
    expect(f).toContain('overlay=');
    expect(f).not.toContain("textfile='/n.txt'");
    expect(f).toContain('y=h*0.70');
  });
  it('without text only the banner is composed (drawtext/font missing)', () => {
    const f = sceneFilter({ ...base, hasBanner: true, withText: false });
    expect(f).not.toContain('drawtext');
    expect(f).toContain('overlay=');
  });
  it('escapes special characters in paths', () => {
    expect(filterEscape("C:\\a'b")).toBe("C\\:/a\\'b");
  });
});

describe('LiveSlide (the picture of the Telegram live video)', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'slide-'));
  const png = (p: string) => readFileSync(p).subarray(1, 4).toString() === 'PNG';

  it('starts with the dark default picture and goes back to it', () => {
    const slide = new LiveSlide(dir(), '7', 'ffmpeg', async () => ({ code: 0, stderr: '' }));
    expect(png(slide.path)).toBe(true);
    slide.showDefault();
    expect(png(slide.path)).toBe(true);
  });

  it('renders the song through ONE short ffmpeg job with the text in files, and swaps the picture atomically', async () => {
    const d = dir();
    let args: string[] = [];
    let titleText = '';
    const run: RunFfmpeg = async (a) => {
      args = a;
      const m = /textfile='([^']*t-[^']*\.txt)'/.exec(a.join(' '));
      if (m) titleText = readFileSync(m[1] as string, 'utf8');
      writeFileSync(a.at(-1) as string, 'RENDERED-SLIDE');
      return { code: 0, stderr: '' };
    };
    const slide = new LiveSlide(d, '7', 'ffmpeg', run);
    expect(await slide.show({ title: 'همخرابه', artist: 'صادق' })).toBe(true);
    expect(readFileSync(slide.path, 'utf8')).toBe('RENDERED-SLIDE');
    expect(titleText).toBe('همخرابه');
    expect(args.join(' ')).toContain('drawtext');
    expect(existsSync(`${slide.path}.tmp`)).toBe(false);
    expect(readdirSync(d).filter((f) => /^(t|a|n|b|s)-/.test(f))).toEqual([]); // temp files cleaned up
  });

  it('long titles are clipped to one line', async () => {
    let title = '';
    const slide = new LiveSlide(dir(), '7', 'ffmpeg', async (a) => {
      const m = /textfile='([^']*t-[^']*\.txt)'/.exec(a.join(' '));
      if (m) title = readFileSync(m[1] as string, 'utf8');
      writeFileSync(a.at(-1) as string, 'X');
      return { code: 0, stderr: '' };
    });
    await slide.show({ title: `${'x'.repeat(100)}\nsecond` });
    expect(title.length).toBe(44);
    expect(title).not.toContain('\n');
  });

  it('an ad shows its banner (rendered once, off the live path)', async () => {
    let args: string[] = [];
    const slide = new LiveSlide(dir(), '7', 'ffmpeg', async (a) => {
      args = a;
      writeFileSync(a.at(-1) as string, 'AD-SLIDE');
      return { code: 0, stderr: '' };
    });
    expect(await slide.show({ title: 'AD · Shop', artist: 'shop.example', banner: { data: Buffer.from('jpeg'), mime: 'image/jpeg' } })).toBe(true);
    expect(args.join(' ')).toContain('overlay');
    expect(readFileSync(slide.path, 'utf8')).toBe('AD-SLIDE');
  });

  it('when drawtext/font is missing it says so ONCE and still shows the picture without text', async () => {
    const problems: string[] = [];
    let calls = 0;
    const slide = new LiveSlide(
      dir(), '7', 'ffmpeg',
      async (a) => {
        calls++;
        if (a.join(' ').includes('drawtext')) return { code: 1, stderr: 'No such filter: drawtext' };
        writeFileSync(a.at(-1) as string, 'PLAIN');
        return { code: 0, stderr: '' };
      },
      (m) => problems.push(m),
    );
    expect(await slide.show({ title: 'A' })).toBe(true);
    expect(readFileSync(slide.path, 'utf8')).toBe('PLAIN');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/drawtext/);
    await slide.show({ title: 'B' }); // no second failed attempt with text
    expect(calls).toBe(3);
    expect(problems).toHaveLength(1);
  });

  it('keeps the previous picture and reports when ffmpeg fails, and ignores a picture that was superseded', async () => {
    const problems: string[] = [];
    const bad = new LiveSlide(dir(), '7', 'ffmpeg', async () => ({ code: 1, stderr: 'boom' }), (m) => problems.push(m));
    expect(await bad.show({ title: 'x' })).toBe(false);
    expect(png(bad.path)).toBe(true);
    expect(problems.length).toBeGreaterThan(0);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new LiveSlide(dir(), '8', 'ffmpeg', async (a) => {
      await gate;
      writeFileSync(a.at(-1) as string, 'LATE');
      return { code: 0, stderr: '' };
    });
    const pending = slow.show({ title: 'old' });
    slow.showDefault();
    release();
    expect(await pending).toBe(false);
    expect(png(slow.path)).toBe(true);
  });
});
