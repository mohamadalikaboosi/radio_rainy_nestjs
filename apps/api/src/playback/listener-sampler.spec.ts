import { freshDb } from '../../test/test-db';
import { DatabaseService } from '../database/database.service';
import { Broadcaster } from '../streaming/broadcaster';
import { ListenerSampler } from './listener-sampler';
import { Station } from './station-manager';

describe('ListenerSampler', () => {
  let db: DatabaseService;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(() => db.onModuleDestroy());

  it('records the listener count per running station, once per time slot', async () => {
    const b = new Broadcaster(10);
    b.subscribe({ write: () => undefined, end: () => undefined });
    b.subscribe({ write: () => undefined, end: () => undefined });
    const stations = { active: [{ channel: { id: '1001' }, broadcaster: b } as unknown as Station] };
    const sampler = new ListenerSampler(db, stations, 30_000);
    const t = new Date('2026-01-01T10:00:07Z');
    expect(await sampler.sample(t)).toBe(1);
    await sampler.sample(new Date('2026-01-01T10:00:20Z')); // same 30 s slot: no duplicate
    await sampler.sample(new Date('2026-01-01T10:00:31Z'));
    const rows = (await db.query<{ listeners: number }>('SELECT listeners FROM listener_samples ORDER BY at')).rows;
    expect(rows).toEqual([{ listeners: 2 }, { listeners: 2 }]);
  });

  it('samples zero listeners too (so averages are honest) and nothing when no station runs', async () => {
    const sampler = new ListenerSampler(db, { active: [{ channel: { id: '1001' }, broadcaster: new Broadcaster(10) } as unknown as Station] });
    await sampler.sample();
    expect((await db.query('SELECT listeners FROM listener_samples')).rows).toEqual([{ listeners: 0 }]);
    expect(await new ListenerSampler(db, { active: [] }).sample()).toBe(0);
  });
});
