import bigInt from 'big-integer';
import { Api } from 'telegram';
import { GramJsTelegramGateway, StoredFileLookup, storedDocumentLocation, toAudioMessage } from './gramjs.gateway';
import { TelegramClientManager } from './telegram-client.manager';

function docMessage(attributes: Api.TypeDocumentAttribute[], mimeType = 'audio/mpeg', extra: Partial<Api.Message> = {}): Api.Message {
  const document = new Api.Document({
    id: bigInt(11),
    accessHash: bigInt(22),
    fileReference: Buffer.from('ref'),
    date: 1,
    mimeType,
    size: bigInt(4096),
    dcId: 2,
    attributes,
  });
  return new Api.Message({
    id: 77,
    date: 1_700_000_000,
    message: 'Artist - Song\n#rain',
    peerId: new Api.PeerChannel({ channelId: bigInt(1001) }),
    media: new Api.MessageMediaDocument({ document }),
    entities: [new Api.MessageEntityTextUrl({ offset: 0, length: 3, url: 'https://telegra.ph/x-1' })],
    ...extra,
  });
}

describe('toAudioMessage', () => {
  it('extracts audio metadata, hidden urls and post url', () => {
    const m = toAudioMessage(
      docMessage([
        new Api.DocumentAttributeAudio({ duration: 200, title: 'Song', performer: 'Artist' }),
        new Api.DocumentAttributeFilename({ fileName: 'song.mp3' }),
      ]),
      '1001',
      'mychan',
    );
    expect(m).toMatchObject({
      channelId: '1001',
      messageId: 77,
      caption: 'Artist - Song\n#rain',
      entityUrls: ['https://telegra.ph/x-1'],
      postUrl: 'https://t.me/mychan/77',
      audio: { mimeType: 'audio/mpeg', size: 4096, duration: 200, title: 'Song', performer: 'Artist', fileName: 'song.mp3' },
    });
    expect(JSON.parse(m?.audio.fileReference ?? '{}')).toMatchObject({ id: '11', dcId: 2 });
  });

  it('uses private-channel link when there is no username', () => {
    const m = toAudioMessage(docMessage([new Api.DocumentAttributeAudio({ duration: 1 })]), '1001');
    expect(m?.postUrl).toBe('https://t.me/c/1001/77');
  });

  it('accepts audio/* documents without audio attribute', () => {
    expect(toAudioMessage(docMessage([], 'audio/flac'), '1')).not.toBeNull();
  });

  it('skips voice notes, non-audio documents and text messages', () => {
    expect(toAudioMessage(docMessage([new Api.DocumentAttributeAudio({ duration: 3, voice: true })]), '1')).toBeNull();
    expect(toAudioMessage(docMessage([], 'video/mp4'), '1')).toBeNull();
    expect(toAudioMessage(new Api.Message({ id: 1, date: 1, message: 'hi', peerId: new Api.PeerChannel({ channelId: bigInt(1) }) }), '1')).toBeNull();
  });
});

describe('storedDocumentLocation', () => {
  it('rebuilds the download location from the reference the sync stored', () => {
    const stored = toAudioMessage(docMessage([new Api.DocumentAttributeAudio({ duration: 1 })]), '1001')?.audio.fileReference ?? '';
    const loc = storedDocumentLocation(stored, 4096);
    expect(loc?.dcId).toBe(2);
    expect(loc?.location).toBeInstanceOf(Api.InputDocumentFileLocation);
    expect(loc?.location.id.toString()).toBe('11');
    expect(loc?.location.accessHash.toString()).toBe('22');
    expect(Buffer.from(loc?.location.fileReference ?? []).toString()).toBe('ref');
    expect(loc?.size?.toJSNumber()).toBe(4096);
  });

  it('is null for a missing or malformed reference', () => {
    expect(storedDocumentLocation('not json', null)).toBeNull();
    expect(storedDocumentLocation('{"id":"1"}', null)).toBeNull();
  });
});

describe('GramJsTelegramGateway.download', () => {
  const channel = new Api.Channel({ id: bigInt(1001), title: 'Chan', username: 'chan', photo: new Api.ChatPhotoEmpty(), date: 0 });

  /** A client that records what was asked of Telegram. `failStored` makes downloads from a stored location fail like an expired reference. */
  function setup(stored: StoredFileLookup | undefined, failStored = false) {
    const calls: string[] = [];
    const client = {
      getEntity: async () => channel,
      getMessages: async () => {
        calls.push('getMessages');
        return [docMessage([new Api.DocumentAttributeAudio({ duration: 1 })])];
      },
      iterDownload: (args: { file: { className: string }; dcId?: number }) => {
        calls.push(`download:${args.file.className}${args.dcId ? `@dc${args.dcId}` : ''}`);
        const expired = failStored && args.file.className === 'InputDocumentFileLocation';
        return {
          async *[Symbol.asyncIterator]() {
            if (expired) throw new Error('400: FILE_REFERENCE_EXPIRED (caused by upload.GetFile)');
            yield Buffer.from('abc');
            yield Buffer.from('def');
          },
          close: async () => undefined,
        };
      },
    };
    const manager = { getClient: () => client } as unknown as TelegramClientManager;
    const gateway = new GramJsTelegramGateway(manager, { referenceOf: async () => '@chan' }, 512, stored);
    return { gateway, calls };
  }
  const read = async (it: AsyncIterable<Uint8Array>): Promise<string> => {
    const out: Uint8Array[] = [];
    for await (const c of it) out.push(c);
    return Buffer.concat(out).toString();
  };
  const storedRef: StoredFileLookup = async () => ({ fileReference: toAudioMessage(docMessage([new Api.DocumentAttributeAudio({ duration: 1 })]), '1001')?.audio.fileReference ?? '', fileSize: 6 });

  it('downloads from the stored reference without asking Telegram for the message (no channels.getMessages on the playback path)', async () => {
    const { gateway, calls } = setup(storedRef);
    expect(await read(gateway.download('1001', 77))).toBe('abcdef');
    expect(calls).toEqual(['download:InputDocumentFileLocation@dc2']);
  });

  it('an expired stored reference is refreshed from the message once', async () => {
    const { gateway, calls } = setup(storedRef, true);
    expect(await read(gateway.download('1001', 77))).toBe('abcdef');
    expect(calls).toEqual(['download:InputDocumentFileLocation@dc2', 'getMessages', 'download:MessageMediaDocument']);
  });

  it('without a stored reference it fetches the message first, as before', async () => {
    const { gateway, calls } = setup(async () => null);
    expect(await read(gateway.download('1001', 77))).toBe('abcdef');
    expect(calls).toEqual(['getMessages', 'download:MessageMediaDocument']);
  });
});
