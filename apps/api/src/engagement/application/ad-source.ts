import { AdsRepository, BillingRule } from './ports/ads.repository';
import type { PlatformSettings } from '../../accounts/application/ports/platform-settings.repository';
import { EngagementSettingsRepository } from './ports/engagement-settings.repository';
import { AdSource, PlayableAd } from '../../radio/application/playback-engine';
import { LiveTranscoder, OpenedAudio } from '../../radio/application/audio-pipeline';
import { stripId3v2 } from '../../radio/domain/id3';
import { Rng, cryptoRng } from '../../radio/domain/rng';

const MP3_MIME = new Set(['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3']);
const CHUNK = 16 * 1024;

async function* chunks(data: Buffer, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length && !signal.aborted; i += CHUNK) yield data.subarray(i, i + CHUNK);
}

/** Weighted pick of the ads the admin uploaded; MP3 ads stream as they are, other formats go through ffmpeg. */
export class DbAdSource implements AdSource {
  constructor(
    private readonly ads: Pick<AdsRepository, 'playableIds' | 'audio' | 'recordPlay'>,
    private readonly platform: { get(): Promise<PlatformSettings> },
    private readonly settings: Pick<EngagementSettingsRepository, 'get'>,
    private readonly transcoder: LiveTranscoder | null,
    private readonly bitrateKbps: number,
    private readonly rng: Rng = cryptoRng,
  ) {}

  async everyN(channelId: string): Promise<number> {
    return (await this.settings.get(channelId)).adsEveryNTracks;
  }

  async pick(channelId: string): Promise<PlayableAd | null> {
    const candidates = await this.ads.playableIds(channelId, await this.billing());
    const total = candidates.reduce((a, c) => a + c.weight, 0);
    if (total === 0) return null;
    let r = this.rng() * total;
    const chosen = candidates.find((c) => (r -= c.weight) < 0) ?? candidates[candidates.length - 1];
    if (!chosen) return null;
    const ad = await this.ads.audio(chosen.id);
    if (!ad) return null;
    const isMp3 = MP3_MIME.has(ad.mime.toLowerCase());
    if (!isMp3 && !this.transcoder) return null; // cannot play it without ffmpeg; the radio just continues
    return {
      id: ad.id,
      name: ad.name,
      open: (signal: AbortSignal): OpenedAudio => {
        const raw = chunks(ad.data, signal);
        const cancel = async (): Promise<void> => {
          await raw.return(undefined);
        };
        if (isMp3) return { bytes: stripId3v2(raw), bytesPerSec: ad.bytesPerSec ?? (this.bitrateKbps * 1000) / 8, cancel };
        return { bytes: (this.transcoder as LiveTranscoder).toMp3(raw, this.bitrateKbps, signal), bytesPerSec: (this.bitrateKbps * 1000) / 8, cancel };
      },
    };
  }

  async played(adId: string): Promise<void> {
    await this.ads.recordPlay(adId, await this.billing());
  }

  private async billing(): Promise<BillingRule> {
    const p = await this.platform.get();
    return { enabled: p.billingEnabled, pricePerPlayCents: p.pricePerPlayCents, pricePerClickCents: p.pricePerClickCents };
  }
}
