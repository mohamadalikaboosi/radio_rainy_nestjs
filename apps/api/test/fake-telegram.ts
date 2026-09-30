import { FetchAudioOptions, TelegramAudioMessage, TelegramChannelInfo, TelegramGateway } from '../src/telegram/telegram.types';

export function audioMsg(messageId: number, caption: string, over: Partial<TelegramAudioMessage['audio']> = {}): TelegramAudioMessage {
  return {
    channelId: '1001',
    messageId,
    date: new Date('2026-01-01T00:00:00Z'),
    caption,
    entityUrls: [],
    postUrl: `https://t.me/chan/${messageId}`,
    audio: { mimeType: 'audio/mpeg', size: 1000, duration: 200, fileReference: `ref-${messageId}`, ...over },
  };
}

export class FakeTelegramGateway implements TelegramGateway {
  messages = new Map<number, TelegramAudioMessage>();
  files = new Map<number, Uint8Array[]>();
  failDownloadFor = new Set<number>();
  downloadCalls: number[] = [];
  channel: TelegramChannelInfo = { id: '1001', title: 'Test channel', username: 'chan' };

  add(m: TelegramAudioMessage, chunks: Uint8Array[] = [new Uint8Array([1, 2, 3])]): void {
    this.messages.set(m.messageId, m);
    this.files.set(m.messageId, chunks);
  }
  remove(id: number): void {
    this.messages.delete(id);
  }
  async resolveChannel(): Promise<TelegramChannelInfo> {
    return this.channel;
  }
  async *fetchAudioMessages(opts: FetchAudioOptions = {}): AsyncIterable<TelegramAudioMessage> {
    const sorted = [...this.messages.values()].sort((a, b) => b.messageId - a.messageId);
    for (const m of sorted) if (m.messageId > (opts.minId ?? 0)) yield m;
  }
  async getAudioMessage(id: number): Promise<TelegramAudioMessage | null> {
    return this.messages.get(id) ?? null;
  }
  async existingAudioMessageIds(ids: readonly number[]): Promise<Set<number>> {
    return new Set(ids.filter((i) => this.messages.has(i)));
  }
  async *download(id: number, opts: { offset?: number; signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    this.downloadCalls.push(id);
    if (this.failDownloadFor.has(id)) throw new Error('download failed');
    let skipped = 0;
    for (const c of this.files.get(id) ?? []) {
      if (opts.signal?.aborted) return;
      const offset = opts.offset ?? 0;
      if (skipped + c.length <= offset) {
        skipped += c.length;
        continue;
      }
      const start = Math.max(0, offset - skipped);
      skipped += c.length;
      yield c.subarray(start);
    }
  }
}
