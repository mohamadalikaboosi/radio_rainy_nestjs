import { Api } from 'telegram';
import { GramJsLiveApi } from './gramjs-live-api';

/** A scripted Telegram: `world` decides what the MTProto methods answer; every invoked method is recorded. */
function setup(world: { call?: 'none' | 'rtmp' | 'voice' | 'ended'; people?: number; fail?: Record<string, string>; urlFailsOnce?: boolean }) {
  const calls: string[] = [];
  const input = new Api.InputGroupCall({ id: 1 as never, accessHash: 2 as never });
  let urlTries = 0;
  const rpc = (m: string): Error => Object.assign(new Error(m), { errorMessage: m });
  const client = {
    getInputEntity: async () => new Api.InputPeerChannel({ channelId: 5 as never, accessHash: 6 as never }),
    invoke: async (req: unknown) => {
      const name = (req as { className: string }).className;
      calls.push(name);
      if (world.fail?.[name]) throw rpc(world.fail[name]);
      switch (name) {
        case 'channels.GetFullChannel':
          return { fullChat: Object.assign(Object.create(Api.ChannelFull.prototype), { call: world.call && world.call !== 'none' ? input : undefined }) };
        case 'phone.GetGroupCall':
          return { call: world.call === 'ended' ? new Api.GroupCallDiscarded({ id: 1 as never, accessHash: 2 as never, duration: 1 }) : Object.assign(Object.create(Api.GroupCall.prototype), { rtmpStream: world.call === 'rtmp', participantsCount: world.people ?? 0 }) };
        case 'phone.GetGroupCallStreamRtmpUrl':
          if (world.urlFailsOnce && urlTries++ === 0) throw rpc('GROUPCALL_INVALID');
          return { url: 'rtmps://dc4-1.rtmp.t.me/s/', key: 'k-1' };
        default:
          return {};
      }
    },
  };
  const api = new GramJsLiveApi({ getClient: () => client } as never, { entityOf: async () => ({ entity: {} }) } as never);
  return { api, calls };
}

describe('GramJsLiveApi (start a Telegram live stream without a pasted link)', () => {
  it('no stream yet: creates an RTMP live stream and returns its URL + key', async () => {
    const { api, calls } = setup({ call: 'none' });
    expect(await api.openLiveStream('c', 'Radio')).toEqual({ url: 'rtmps://dc4-1.rtmp.t.me/s/', key: 'k-1' });
    expect(calls).toEqual(['channels.GetFullChannel', 'phone.CreateGroupCall', 'phone.GetGroupCallStreamRtmpUrl']);
  });

  it('an RTMP live stream already exists: reuses it, creates nothing', async () => {
    const { api, calls } = setup({ call: 'rtmp' });
    await api.openLiveStream('c', 'Radio');
    expect(calls).not.toContain('phone.CreateGroupCall');
  });

  it('a normal voice chat that is empty is replaced by a live stream', async () => {
    const { api, calls } = setup({ call: 'voice', people: 0 });
    await api.openLiveStream('c', 'Radio');
    expect(calls).toEqual(expect.arrayContaining(['phone.DiscardGroupCall', 'phone.CreateGroupCall']));
  });

  it('a voice chat with people in it is never ended: clear error instead', async () => {
    const { api, calls } = setup({ call: 'voice', people: 5 });
    await expect(api.openLiveStream('c', 'Radio')).rejects.toThrow(/normal voice chat with people/);
    expect(calls).not.toContain('phone.DiscardGroupCall');
  });

  it('a finished stream is replaced', async () => {
    const { api, calls } = setup({ call: 'ended' });
    await api.openLiveStream('c', 'Radio');
    expect(calls).toContain('phone.CreateGroupCall');
  });

  it('a start that raced with Telegram (ALREADY_STARTED) is fine', async () => {
    const { api } = setup({ call: 'none', fail: { 'phone.CreateGroupCall': 'GROUPCALL_ALREADY_STARTED' } });
    await expect(api.openLiveStream('c', 'Radio')).resolves.toMatchObject({ key: 'k-1' });
  });

  it('tells which step failed and what to do (missing admin right)', async () => {
    const { api } = setup({ call: 'none', fail: { 'phone.CreateGroupCall': 'CHAT_ADMIN_REQUIRED' } });
    await expect(api.openLiveStream('c', 'Radio')).rejects.toThrow(/could not create the live stream: CHAT_ADMIN_REQUIRED — .*Manage Live Streams/);
  });

  it('reports flood waits with the delay', async () => {
    const { api } = setup({ call: 'none', fail: { 'channels.GetFullChannel': 'FLOOD_WAIT_30' } });
    await expect(api.openLiveStream('c', 'Radio')).rejects.toThrow(/retry in 30 s/);
  });

  it('retries once when a just-created stream is not visible yet', async () => {
    const { api, calls } = setup({ call: 'none', urlFailsOnce: true });
    await api.openLiveStream('c', 'Radio');
    expect(calls.filter((c) => c === 'phone.GetGroupCallStreamRtmpUrl')).toHaveLength(2);
  });
});
