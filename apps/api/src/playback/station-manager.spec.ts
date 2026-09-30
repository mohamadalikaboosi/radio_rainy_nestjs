import { ChannelRow } from '../channels/channel.repository';
import { Broadcaster } from '../streaming/broadcaster';
import { Station, StationManager } from './station-manager';

const row = (id: string, over: Partial<ChannelRow> = {}): ChannelRow => ({
  id, reference: `@c${id}`, title: `C${id}`, username: null, slug: `c${id}`, started: true, telegramLiveEnabled: false, liveStatus: 'OFF', liveError: null, createdAt: new Date(), ...over,
});

function fakeStation(channel: ChannelRow) {
  const log: string[] = [];
  const station = {
    channel,
    broadcaster: new Broadcaster(10),
    engine: { start: () => log.push('engine.start'), stop: async () => void log.push('engine.stop') },
    live: { running: false, start() { this.running = true; log.push('live.start'); }, async stop() { this.running = false; log.push('live.stop'); } },
  } as unknown as Station;
  return { station, log };
}

describe('StationManager', () => {
  let rows: ChannelRow[];
  let built: Map<string, ReturnType<typeof fakeStation>>;
  const statuses: [string, string][] = [];
  let mgr: StationManager;

  beforeEach(() => {
    rows = [row('1'), row('2', { started: false })];
    built = new Map();
    statuses.length = 0;
    mgr = new StationManager(
      { list: async () => rows, setLiveStatus: async () => undefined },
      { setStatus: async (id, s) => void statuses.push([id, s]) },
      (c) => {
        const f = fakeStation(c);
        built.set(c.id, f);
        return f.station;
      },
    );
  });

  it('runs exactly the started channels and reacts to admin changes', async () => {
    await mgr.reconcile();
    expect(mgr.active.map((s) => s.channel.id)).toEqual(['1']);
    expect(built.get('1')?.log).toEqual(['engine.start']);

    rows = [row('1'), row('2')]; // channel 2 started
    await mgr.reconcile();
    expect(mgr.active.map((s) => s.channel.id).sort()).toEqual(['1', '2']);

    rows = [row('1', { started: false }), row('2')]; // channel 1 stopped
    await mgr.reconcile();
    expect(mgr.active.map((s) => s.channel.id)).toEqual(['2']);
    expect(built.get('1')?.log).toEqual(['engine.start', 'live.stop', 'engine.stop']);
    expect(statuses).toContainEqual(['1', 'STOPPED']);
  });

  it('is idempotent: repeated reconciles never start a station twice', async () => {
    await Promise.all([mgr.reconcile(), mgr.reconcile(), mgr.reconcile()]);
    expect(built.size).toBe(1);
    expect(built.get('1')?.log).toEqual(['engine.start']);
  });

  it('toggles the Telegram live stream without restarting the player', async () => {
    await mgr.reconcile();
    rows = [row('1', { telegramLiveEnabled: true }), row('2', { started: false })];
    await mgr.reconcile();
    expect(built.get('1')?.log).toEqual(['engine.start', 'live.start']);
    rows = [row('1', { telegramLiveEnabled: false }), row('2', { started: false })];
    await mgr.reconcile();
    expect(built.get('1')?.log).toEqual(['engine.start', 'live.start', 'live.stop']);
  });

  it('removed channels are stopped; stopAll stops everything', async () => {
    rows = [row('1'), row('2')];
    await mgr.reconcile();
    rows = [row('2')];
    await mgr.reconcile();
    expect(mgr.active.map((s) => s.channel.id)).toEqual(['2']);
    await mgr.stopAll();
    expect(mgr.active).toHaveLength(0);
    expect(built.get('2')?.log).toContain('engine.stop');
  });
});
