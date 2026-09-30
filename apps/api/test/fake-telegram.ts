import { FetchAudioOptions, TelegramAudioMessage, TelegramChannelInfo, TelegramGateway, TelegramNotReadyError } from '../src/telegram/telegram.types';

export function audioMsg(messageId: number, caption: string, over: Partial<TelegramAudioMessage['audio']> = {}, channelId = '1001'): TelegramAudioMessage {
  return {
    channelId,
    messageId,
    date: new Date('2026-01-01T00:00:00Z'),
    caption,
    entityUrls: [],
    postUrl: `https://t.me/chan/${messageId}`,
    audio: { mimeType: 'audio/mpeg', size: 1000, duration: 200, fileReference: `ref-${channelId}-${messageId}`, ...over },
  };
}

/** In-memory Telegram with any number of channels. Messages are scoped by their own channelId. */
export class FakeTelegramGateway implements TelegramGateway {
  messages: TelegramAudioMessage[] = [];
  files = new Map<string, Uint8Array[]>();
  failDownloadFor = new Set<number>();
  downloadCalls: number[] = [];
  /** Fail once after N chunks on first download of this message (tests resume). */
  flakyAfterChunks = new Map<number, number>();
  notReady = false;
  channels = new Map<string, TelegramChannelInfo>([['@chan', { id: '1001', title: 'Test channel', username: 'chan' }]]);

  private key = (channelId: string, id: number): string => `${channelId}:${id}`;

  addChannel(reference: string, info: TelegramChannelInfo): void {
    this.channels.set(reference, info);
  }
  add(m: TelegramAudioMessage, chunks: Uint8Array[] = [new Uint8Array([1, 2, 3])]): void {
    this.messages = this.messages.filter((x) => !(x.channelId === m.channelId && x.messageId === m.messageId));
    this.messages.push(m);
    this.files.set(this.key(m.channelId, m.messageId), chunks);
  }
  remove(id: number, channelId = '1001'): void {
    this.messages = this.messages.filter((x) => !(x.channelId === channelId && x.messageId === id));
  }
  private inChannel(channelId: string): TelegramAudioMessage[] {
    return this.messages.filter((m) => m.channelId === channelId);
  }
  async resolveChannel(reference: string): Promise<TelegramChannelInfo> {
    if (this.notReady) throw new TelegramNotReadyError();
    const c = this.channels.get(reference);
    if (!c) throw Object.assign(new Error('nope'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
    return c;
  }
  async *fetchAudioMessages(channelId: string, opts: FetchAudioOptions = {}): AsyncIterable<TelegramAudioMessage> {
    for (const m of [...this.inChannel(channelId)].sort((a, b) => b.messageId - a.messageId)) if (m.messageId > (opts.minId ?? 0)) yield m;
  }
  async getAudioMessage(channelId: string, id: number): Promise<TelegramAudioMessage | null> {
    return this.inChannel(channelId).find((m) => m.messageId === id) ?? null;
  }
  async existingAudioMessageIds(channelId: string, ids: readonly number[]): Promise<Set<number>> {
    const have = new Set(this.inChannel(channelId).map((m) => m.messageId));
    return new Set(ids.filter((i) => have.has(i)));
  }
  async *download(channelId: string, id: number, opts: { offset?: number; signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    this.downloadCalls.push(id);
    if (this.notReady) throw new TelegramNotReadyError();
    if (this.failDownloadFor.has(id)) throw new Error('download failed');
    const flaky = this.flakyAfterChunks.get(id);
    if (flaky !== undefined) this.flakyAfterChunks.delete(id);
    let emitted = 0;
    let skipped = 0;
    for (const c of this.files.get(this.key(channelId, id)) ?? []) {
      if (opts.signal?.aborted) return;
      const offset = opts.offset ?? 0;
      if (skipped + c.length <= offset) {
        skipped += c.length;
        continue;
      }
      const start = Math.max(0, offset - skipped);
      skipped += c.length;
      if (flaky !== undefined && emitted >= flaky) throw new Error('connection reset');
      emitted++;
      yield c.subarray(start);
    }
  }
}
