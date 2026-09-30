import { BadRequestException } from '@nestjs/common';
import { parseLiveTarget } from '../channels/channel.service';
import { SessionCipher } from '../telegram/session-cipher';
import { ManualOrAutoLiveApi } from './manual-live-api';
import { buildFfmpegRtmpArgs, TelegramLiveApi } from './telegram-live-streamer';

describe('parseLiveTarget', () => {
  it('accepts a separate URL and key', () => {
    expect(parseLiveTarget('rtmps://dc4-1.rtmp.t.me/s/', ' 123:abc ')).toEqual({ url: 'rtmps://dc4-1.rtmp.t.me/s/', key: '123:abc' });
    expect(parseLiveTarget('rtmps://dc4-1.rtmp.t.me:443/s', '123:abc').url).toBe('rtmps://dc4-1.rtmp.t.me:443/s/');
  });

  it('splits one pasted link that ends with the key', () => {
    expect(parseLiveTarget('rtmps://dc4-1.rtmp.t.me/s/123:abc-_XY')).toEqual({ url: 'rtmps://dc4-1.rtmp.t.me/s/', key: '123:abc-_XY' });
  });

  it('rejects non-rtmp links, missing keys and whitespace in the key', () => {
    expect(() => parseLiveTarget('https://example.com/s/', 'k')).toThrow(BadRequestException);
    expect(() => parseLiveTarget('javascript:alert(1)', 'k')).toThrow(BadRequestException);
    expect(() => parseLiveTarget('rtmps://host/s/')).toThrow(BadRequestException);
    expect(() => parseLiveTarget('rtmps://host', undefined)).toThrow(BadRequestException);
    expect(() => parseLiveTarget('rtmps://host/s/', 'a b')).toThrow(BadRequestException);
  });

  it('builds the ffmpeg output URL as <url><key>', () => {
    const args = buildFfmpegRtmpArgs(parseLiveTarget('rtmps://host/s/KEY'));
    expect(args[args.length - 1]).toBe('rtmps://host/s/KEY');
  });
});

describe('ManualOrAutoLiveApi', () => {
  const cipher = new SessionCipher('ab'.repeat(32), 'live-rtmp-key');
  const auto: TelegramLiveApi & { calls: string[] } = {
    calls: [],
    async openLiveStream(id) {
      this.calls.push(`open:${id}`);
      return { url: 'rtmps://auto/s/', key: 'auto-key' };
    },
    async closeLiveStream(id) {
      this.calls.push(`close:${id}`);
    },
  };

  it('uses the saved link + key (decrypted) and leaves Telegram\'s own live stream alone', async () => {
    const api = new ManualOrAutoLiveApi(auto, { getLiveTarget: async () => ({ url: 'rtmps://manual/s/', keyEnc: cipher.encrypt('secret-key') }) }, cipher);
    expect(await api.openLiveStream('1', 'T')).toEqual({ url: 'rtmps://manual/s/', key: 'secret-key' });
    await api.closeLiveStream('1');
    expect(auto.calls).toEqual([]);
  });

  it('falls back to the automatic MTProto mode when nothing is saved', async () => {
    const api = new ManualOrAutoLiveApi(auto, { getLiveTarget: async () => null }, cipher);
    expect(await api.openLiveStream('1', 'T')).toEqual({ url: 'rtmps://auto/s/', key: 'auto-key' });
    await api.closeLiveStream('1');
    expect(auto.calls).toEqual(['open:1', 'close:1']);
  });
});
