import { ChannelRepository } from '../../catalog/infrastructure/persistence/channel.repository';
import { SessionCipher } from '../../shared/infrastructure/crypto/session-cipher';
import { RtmpTarget, TelegramLiveApi } from '../application/telegram-live-streamer';

/**
 * Chooses how a station goes live inside Telegram: with a manual "link + stream key" (like OBS; nothing is created through MTProto)
 * when the admin saved one for the channel, otherwise automatically through MTProto.
 */
export class ManualOrAutoLiveApi implements TelegramLiveApi {
  constructor(private readonly auto: TelegramLiveApi, private readonly channels: Pick<ChannelRepository, 'getLiveTarget'>, private readonly cipher: SessionCipher) {}

  async openLiveStream(channelId: string, title: string): Promise<RtmpTarget> {
    const manual = await this.channels.getLiveTarget(channelId);
    if (manual) return { url: manual.url, key: this.cipher.decrypt(manual.keyEnc) };
    return this.auto.openLiveStream(channelId, title);
  }

  async closeLiveStream(channelId: string): Promise<void> {
    if (await this.channels.getLiveTarget(channelId)) return; // Telegram's own app owns that live stream
    return this.auto.closeLiveStream(channelId);
  }
}
