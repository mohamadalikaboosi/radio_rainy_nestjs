import { SettingsService } from '../../../administration/application/settings.service';
import { AudioStore, AudioStoreSource } from '../../application/ports/audio-store';
import { MinioAudioStore } from './minio-audio-store';

/** Builds the MinIO client from the panel settings and rebuilds it only when they change. */
export class SettingsAudioStoreSource implements AudioStoreSource {
  private built: { key: string; store: AudioStore } | null = null;

  constructor(private readonly settings: Pick<SettingsService, 'storage'>) {}

  async current(): Promise<AudioStore | null> {
    const s = await this.settings.storage();
    if (!s) return null;
    const key = JSON.stringify([s.endpoint, s.port, s.useSsl, s.bucket, s.accessKey, s.secretKey]);
    if (this.built?.key !== key) this.built = { key, store: MinioAudioStore.fromSettings(s) };
    return this.built.store;
  }
}
