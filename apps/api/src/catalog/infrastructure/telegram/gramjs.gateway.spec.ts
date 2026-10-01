import bigInt from 'big-integer';
import { Api } from 'telegram';
import { toAudioMessage } from './gramjs.gateway';

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
