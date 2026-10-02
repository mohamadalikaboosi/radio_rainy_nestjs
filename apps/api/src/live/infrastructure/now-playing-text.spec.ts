import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drawtextFilter, filterEscape, NowPlayingText } from './now-playing-text';
import { LIVE_LADDER } from '../domain/live-quality';
import { buildFfmpegRtmpArgs } from './ffmpeg-rtmp-publisher';

describe('now playing on the Telegram live video', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'np-'));

  it('writes title/artist (clipped, single line) and replaces them atomically', () => {
    const np = new NowPlayingText(dir(), '42', 'Radio');
    expect(readFileSync(np.overlay.titleFile, 'utf8')).toBe('Radio');
    np.set('همخرابه', 'صادق');
    expect(readFileSync(np.overlay.titleFile, 'utf8')).toBe('همخرابه');
    expect(readFileSync(np.overlay.artistFile, 'utf8')).toBe('صادق');
    np.set('x'.repeat(100) + '\nsecond', null);
    const t = readFileSync(np.overlay.titleFile, 'utf8');
    expect(t.length).toBe(44);
    expect(t).not.toContain('\n');
    expect(readFileSync(np.overlay.artistFile, 'utf8').trim()).toBe('');
  });

  it('the ffmpeg args get the drawtext filter only when an overlay is given', () => {
    const np = new NowPlayingText(dir(), '42', 'Radio');
    const withText = buildFfmpegRtmpArgs({ url: 'rtmps://x/s/', key: 'k' }, LIVE_LADDER[0], np.overlay);
    const vf = withText[withText.indexOf('-vf') + 1];
    expect(vf).toContain('drawtext=textfile=');
    expect(vf).toContain('reload=1');
    expect(buildFfmpegRtmpArgs({ url: 'rtmps://x/s/', key: 'k' })[buildFfmpegRtmpArgs({ url: 'rtmps://x/s/', key: 'k' }).indexOf('-vf') + 1]).not.toContain('drawtext');
  });

  it('escapes filter-special characters in paths', () => {
    expect(filterEscape("C:\\a'b")).toBe("C\\:/a\\'b");
    expect(drawtextFilter({ titleFile: '/t.txt', artistFile: '/a.txt' })).not.toContain('fontfile');
  });
});
