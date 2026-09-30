import { Client } from 'minio';
import { Readable } from 'node:stream';
import { StorageSettings } from '../settings/settings.service';
import { AudioStore } from './audio-store';

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'NotFound' || code === 'NoSuchKey' || code === 'NoSuchBucket';
}

export class MinioAudioStore implements AudioStore {
  private bucketReady = false;

  constructor(private readonly client: Client, private readonly bucket: string) {}

  static fromSettings(s: StorageSettings): MinioAudioStore {
    return new MinioAudioStore(new Client({ endPoint: s.endpoint, port: s.port, useSSL: s.useSsl, accessKey: s.accessKey, secretKey: s.secretKey }), s.bucket);
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    if (!(await this.client.bucketExists(this.bucket))) await this.client.makeBucket(this.bucket);
    this.bucketReady = true;
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const st = await this.client.statObject(this.bucket, key);
      return { size: st.size };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async *open(key: string, opts: { offset?: number; signal?: AbortSignal } = {}): AsyncGenerator<Uint8Array> {
    const stream = (await this.client.getPartialObject(this.bucket, key, opts.offset ?? 0)) as Readable;
    const abort = (): void => void stream.destroy();
    opts.signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of stream) {
        if (opts.signal?.aborted) return;
        yield chunk as Buffer;
      }
    } finally {
      opts.signal?.removeEventListener('abort', abort);
      stream.destroy();
    }
  }

  async put(key: string, data: NodeJS.ReadableStream, size?: number): Promise<void> {
    await this.ensureBucket();
    await this.client.putObject(this.bucket, key, data as Readable, size);
  }

  async remove(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async ping(): Promise<void> {
    await this.ensureBucket();
    const key = `.ping/${Date.now()}`;
    await this.put(key, Readable.from([Buffer.from('ok')]), 2);
    const got: Buffer[] = [];
    for await (const c of this.open(key)) got.push(Buffer.from(c));
    await this.remove(key);
    if (Buffer.concat(got).toString() !== 'ok') throw new Error('storage read-back mismatch');
  }

  async usage(limit = 100_000): Promise<{ objects: number; bytes: number; truncated: boolean }> {
    await this.ensureBucket();
    let objects = 0;
    let bytes = 0;
    const stream = this.client.listObjectsV2(this.bucket, 'audio/', true);
    for await (const o of stream as AsyncIterable<{ size?: number }>) {
      objects++;
      bytes += o.size ?? 0;
      if (objects >= limit) {
        (stream as unknown as Readable).destroy();
        return { objects, bytes, truncated: true };
      }
    }
    return { objects, bytes, truncated: false };
  }
}
